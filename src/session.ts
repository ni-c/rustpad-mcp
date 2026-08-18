import { Agent, WebSocket as UndiciWebSocket } from 'undici';

import { assertDocumentId } from './api.js';
import type { Config } from './config.js';
import {
  applyOperation,
  codepointLength,
  MAX_DOCUMENT_CODEPOINTS,
  type Op,
} from './ot.js';

/** Name shown to humans who have the pad open while this server edits it. */
export const CLIENT_NAME = 'rustpad-mcp';
const CLIENT_HUE = 200;

/**
 * Bounds on the connection. Every network wait has a wall-clock limit and
 * every buffer a size limit: the server side of this protocol is whatever
 * RUSTPAD_URL points at, and a hostile or broken upstream must cost a failed
 * tool call, not a hung process or unbounded memory.
 */
export interface SessionLimits {
  openTimeoutMs: number;
  ackTimeoutMs: number;
  /** Idle window that ends the initial burst. */
  settleIdleMs: number;
  /** Wall-clock cap on the whole settle phase, chatty server or not. */
  settleDeadlineMs: number;
  maxQueuedMessages: number;
  maxFrameBytes: number;
  maxUsers: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  openTimeoutMs: 15_000,
  ackTimeoutMs: 15_000,
  settleIdleMs: 300,
  settleDeadlineMs: 20_000,
  maxQueuedMessages: 1000,
  maxFrameBytes: 1024 * 1024,
  maxUsers: 200,
};

const MAX_USER_NAME_LENGTH = 100;

export interface UserInfo {
  name: string;
  hue: number;
}

export interface DocumentState {
  /** Number of operations the server holds; the base for the next edit. */
  revision: number;
  text: string;
  language: string | undefined;
  /** Users connected right now, keyed by their socket id (excluding us). */
  users: Map<number, UserInfo>;
}

interface ServerMsg {
  Identity?: number;
  History?: { start: number; operations: { id: number; operation: Op[] }[] };
  Language?: string;
  UserInfo?: { id: number; info: UserInfo | null };
  UserCursor?: unknown;
}

/** Structural check of a History message — the input is upstream-controlled. */
function isValidHistory(
  history: unknown
): history is { start: number; operations: { id: number; operation: Op[] }[] } {
  if (typeof history !== 'object' || history === null) return false;
  const { start, operations } = history as Record<string, unknown>;
  if (!Number.isInteger(start) || (start as number) < 0) return false;
  if (!Array.isArray(operations)) return false;
  return operations.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { id, operation } = entry as Record<string, unknown>;
    return (
      typeof id === 'number' &&
      Array.isArray(operation) &&
      operation.every((op) => typeof op === 'number' || typeof op === 'string')
    );
  });
}

/**
 * The browser-flavoured surface this module needs from a WebSocket. Both
 * Node's global implementation and undici's export satisfy it; tests inject a
 * fake that plays the server side of the protocol.
 */
export interface WebSocketLike {
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: { data?: unknown }) => void
  ): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (
  url: string,
  options: { insecureTls: boolean }
) => WebSocketLike;

/**
 * Default factory. The insecure path needs undici's WebSocket because only it
 * accepts a dispatcher; the plain path uses the global implementation so the
 * two stay independently replaceable.
 */
export function defaultWebSocketFactory(
  url: string,
  options: { insecureTls: boolean }
): WebSocketLike {
  if (options.insecureTls) {
    return new UndiciWebSocket(url, {
      dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    }) as unknown as WebSocketLike;
  }
  return new WebSocket(url) as unknown as WebSocketLike;
}

/** Maps the configured http(s) base URL to the ws(s) socket URL for a pad. */
export function socketUrl(baseUrl: string, id: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/api/socket/${encodeURIComponent(id)}`;
}

/** Pulls messages out of event-listener callbacks into an awaitable queue. */
class MessageQueue {
  private readonly queue: string[] = [];
  private waiter: ((value: string | null) => void) | undefined;
  private done = false;
  private failure: Error | undefined;

  constructor(private readonly limits: SessionLimits) {}

  push(message: string): void {
    if (message.length > this.limits.maxFrameBytes) {
      this.end(
        new Error(
          'the Rustpad server sent a frame larger than this client accepts'
        )
      );
      return;
    }
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(message);
      return;
    }
    if (this.queue.length >= this.limits.maxQueuedMessages) {
      this.end(
        new Error(
          'the Rustpad server sent more data than this client will buffer'
        )
      );
      return;
    }
    this.queue.push(message);
  }

  end(error?: Error): void {
    this.done = true;
    if (error && !this.failure) this.failure = error;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(null);
    }
  }

  /**
   * Next message, `null` on timeout, or a throw when the socket ended with an
   * error. Only one outstanding read at a time — the session is strictly
   * sequential.
   */
  async next(timeoutMs: number): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.done) {
      if (this.failure) throw this.failure;
      throw new Error('the Rustpad server closed the connection');
    }
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        resolve(null);
      }, timeoutMs);
      this.waiter = (value) => {
        clearTimeout(timer);
        if (value === null) {
          if (this.failure) {
            reject(this.failure);
          } else {
            reject(new Error('the Rustpad server closed the connection'));
          }
          return;
        }
        resolve(value);
      };
    });
  }
}

/**
 * One short-lived connection to a pad: read the current state, optionally send
 * a single edit or a language change, close. Stateless by design — every tool
 * call sees the server's truth of that moment, and there is no long-lived
 * socket to babysit across hub restarts.
 */
export class RustpadSession {
  readonly state: DocumentState = {
    revision: 0,
    text: '',
    language: undefined,
    users: new Map(),
  };
  private identity = -1;
  private infoSent = false;

  private constructor(
    private readonly socket: WebSocketLike,
    private readonly messages: MessageQueue,
    private readonly limits: SessionLimits
  ) {}

  static async open(
    config: Config,
    id: string,
    factory: WebSocketFactory = defaultWebSocketFactory,
    limits: SessionLimits = DEFAULT_LIMITS
  ): Promise<RustpadSession> {
    if (!config.url) {
      throw new Error('RUSTPAD_URL is not configured');
    }
    // Defense in depth: every tool validates already, but this is the last
    // line before the id becomes part of a URL path.
    assertDocumentId(id);
    const socket = factory(socketUrl(config.url, id), {
      insecureTls: config.insecureTls,
    });
    const messages = new MessageQueue(limits);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error('timed out connecting to the Rustpad WebSocket endpoint')
          ),
        limits.openTimeoutMs
      );
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        const error = new Error(
          'the Rustpad WebSocket connection failed — check RUSTPAD_URL and that the instance is reachable'
        );
        messages.end(error);
        reject(error);
      });
      socket.addEventListener('close', () => messages.end());
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') messages.push(event.data);
      });
    });

    const session = new RustpadSession(socket, messages, limits);
    try {
      await session.settle();
    } catch (error) {
      // The socket is live at this point; failing to close it here would leak
      // one connection per hostile or garbled response.
      socket.close();
      throw error;
    }
    return session;
  }

  /** Reads until the initial burst (or the aftermath of an edit) goes quiet. */
  private async settle(): Promise<void> {
    const deadline = Date.now() + this.limits.settleDeadlineMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          'the Rustpad server kept sending messages without going idle — giving up'
        );
      }
      const raw = await this.messages.next(
        Math.min(this.limits.settleIdleMs, remaining)
      );
      if (raw === null) {
        if (Date.now() >= deadline) continue; // deadline check throws above
        return;
      }
      this.handle(raw);
    }
  }

  private handle(raw: string): ServerMsg {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      throw new Error('the Rustpad server sent a message that is not JSON');
    }
    if (msg.Identity !== undefined) {
      if (typeof msg.Identity === 'number') this.identity = msg.Identity;
    } else if (msg.History !== undefined) {
      if (!isValidHistory(msg.History)) {
        throw new Error('the Rustpad server sent a malformed History message');
      }
      const { start, operations } = msg.History;
      // The server replays from `start`; anything before the local revision
      // has been applied already.
      for (let i = this.state.revision - start; i < operations.length; i++) {
        const entry = operations[i];
        if (!entry) break;
        const text = applyOperation(this.state.text, entry.operation);
        // Rustpad itself rejects edits beyond this size, so anything larger
        // arriving inbound is not a legitimate document — refuse to buffer it.
        if (codepointLength(text) > MAX_DOCUMENT_CODEPOINTS) {
          throw new Error(
            'the Rustpad server sent a document above the 256 KiB limit'
          );
        }
        this.state.text = text;
        this.state.revision++;
      }
    } else if (msg.Language !== undefined) {
      if (typeof msg.Language === 'string') {
        this.state.language = msg.Language.slice(0, 100);
      }
    } else if (msg.UserInfo !== undefined) {
      const { id, info } = msg.UserInfo;
      if (typeof id === 'number' && id !== this.identity) {
        if (
          info &&
          typeof info === 'object' &&
          typeof info.name === 'string' &&
          typeof info.hue === 'number'
        ) {
          if (
            this.state.users.size < this.limits.maxUsers ||
            this.state.users.has(id)
          ) {
            this.state.users.set(id, {
              name: info.name.slice(0, MAX_USER_NAME_LENGTH),
              hue: info.hue,
            });
          }
        } else if (info === null) {
          this.state.users.delete(id);
        }
      }
    }
    return msg;
  }

  private sendClientInfo(): void {
    if (this.infoSent) return;
    this.infoSent = true;
    this.socket.send(
      JSON.stringify({ ClientInfo: { name: CLIENT_NAME, hue: CLIENT_HUE } })
    );
  }

  /**
   * Sends one edit based on the current state and waits until the server's
   * History echo contains an operation attributed to this connection — that
   * echo is the only acknowledgement the protocol has. Concurrent edits that
   * arrive first are folded in; the server transforms this operation against
   * them itself.
   */
  async edit(ops: Op[]): Promise<void> {
    this.sendClientInfo();
    const before = this.state.revision;
    this.socket.send(
      JSON.stringify({ Edit: { revision: before, operation: ops } })
    );

    const deadline = Date.now() + this.limits.ackTimeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          'the Rustpad server did not acknowledge the edit in time — the pad was left unchanged or a concurrent edit interfered'
        );
      }
      const raw = await this.messages.next(remaining);
      if (raw === null) continue;
      const msg = this.handle(raw);
      const acked = msg.History?.operations.some(
        (op) => op.id === this.identity
      );
      if (acked) return;
    }
  }

  /**
   * Sets the editor language and waits for the server's broadcast of the same
   * value, which every connection — including the sender — receives.
   */
  async setLanguage(language: string): Promise<void> {
    this.socket.send(JSON.stringify({ SetLanguage: language }));

    const deadline = Date.now() + this.limits.ackTimeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          'the Rustpad server did not confirm the language change in time'
        );
      }
      const raw = await this.messages.next(remaining);
      if (raw === null) continue;
      const msg = this.handle(raw);
      if (msg.Language === language) return;
    }
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * Opens a session, runs `fn`, and closes the socket no matter how `fn` ends.
 */
export async function withSession<T>(
  config: Config,
  id: string,
  factory: WebSocketFactory | undefined,
  fn: (session: RustpadSession) => Promise<T>
): Promise<T> {
  const session = await RustpadSession.open(config, id, factory);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}
