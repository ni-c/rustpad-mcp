import { Agent, WebSocket as UndiciWebSocket } from 'undici';

import { assertDocumentId } from './api.js';
import type { Config } from './config.js';
import { stripTrailingSlashes } from './config.js';
import {
  applyOperation,
  codepointLength,
  MAX_DOCUMENT_CODEPOINTS,
  type Op,
} from './ot.js';
import { cleanText } from './text.js';

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
  /**
   * UTF-16 units the queue may hold across all buffered messages.
   *
   * The count above is not a memory bound: a thousand messages at the frame
   * limit is a gigabyte, measured at 424 MB for four hundred of them, and
   * the process this server usually runs in is allowed 192 MB. The frames
   * arrive between two turns of the event loop — faster than they are
   * folded whenever the upstream is on a fast link — so the bound has to be
   * on what is held, not on how many things are held.
   */
  maxQueuedBytes: number;
  /**
   * Largest single message accepted, enforced *before* it is buffered: the
   * WebSocket implementation is told this number and fails the connection on
   * a frame header that announces more, so a hostile upstream cannot make the
   * process hold a 128 MB message (undici's default) for a check that runs
   * after the fact. The same number is checked again on the message once it
   * arrives, for a factory that ignores the option.
   */
  maxFrameBytes: number;
  /**
   * Operations this client will fold out of a single History message.
   *
   * A backstop on {@link maxFrameBytes}, not the bound that does the work.
   * Folding one operation costs O(document length), so the cost of a History
   * message is the product of its length and the document's — and a count is a
   * poor proxy for either. The bound that actually holds is the deadline check
   * inside the folding loop; this one exists so that raising `maxFrameBytes`
   * does not silently raise the number of operations one frame may demand.
   *
   * Set above what a 1 MiB frame can carry (the smallest useful entry is about
   * 25 bytes, so ~42 000) on purpose. A tighter count would refuse pads that
   * work today: Rustpad replays a pad's entire history on connect and never
   * compacts it, a typing session produces roughly one operation per keystroke,
   * and a real entry runs 30–60 bytes — so a cap in the low tens of thousands
   * would turn "slow but fine" into "permanently unusable" for an ordinary
   * heavily-edited pad, to save an adversary's frame twenty seconds it can only
   * spend once per tool call anyway.
   */
  maxHistoryOperations: number;
  maxUsers: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  openTimeoutMs: 15_000,
  ackTimeoutMs: 15_000,
  settleIdleMs: 300,
  settleDeadlineMs: 20_000,
  maxQueuedMessages: 1000,
  maxQueuedBytes: 8 * 1024 * 1024,
  maxFrameBytes: 1024 * 1024,
  maxHistoryOperations: 50_000,
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
  /**
   * Whether a History message was ever seen on this connection.
   *
   * The one thing `text === ''` cannot tell a caller apart. Rustpad sends no
   * History at all for a pad that has never been written, so silence means
   * either "empty" or "not here yet" — and {@link RustpadSession.settle} ends
   * the initial burst after {@link SessionLimits.settleIdleMs} of quiet, which
   * a slow instance, a restored database or a buffering proxy can outlast.
   * Everything that treats an empty pad as licence to skip a guard has to know
   * which of the two it is looking at.
   */
  sawHistory: boolean;
}

interface ServerMsg {
  Identity?: number;
  History?: { start: number; operations: { id: number; operation: Op[] }[] };
  Language?: string;
  UserInfo?: { id: number; info: UserInfo | null };
  UserCursor?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural check of a History message — the input is upstream-controlled.
 *
 * Numbers have to be integers: `1.5` as a retain count slices half a
 * character, `NaN` and `Infinity` are `typeof "number"` too, and an id that
 * is not an integer can never be this connection's.
 */
function isValidHistory(
  history: unknown
): history is { start: number; operations: { id: number; operation: Op[] }[] } {
  if (!isRecord(history)) return false;
  const { start, operations } = history;
  if (!Number.isInteger(start) || (start as number) < 0) return false;
  if (!Array.isArray(operations)) return false;
  return operations.every((entry) => {
    if (!isRecord(entry)) return false;
    const { id, operation } = entry;
    return (
      Number.isInteger(id) &&
      Array.isArray(operation) &&
      operation.every(
        (op) =>
          (typeof op === 'number' && Number.isInteger(op) && op !== 0) ||
          typeof op === 'string'
      )
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

export interface WebSocketOptions {
  insecureTls: boolean;
  /** Passed to the implementation as its payload limit; see {@link SessionLimits.maxFrameBytes}. */
  maxFrameBytes: number;
}

export type WebSocketFactory = (
  url: string,
  options: WebSocketOptions
) => WebSocketLike;

/**
 * One dispatcher per distinct pair of options, built on first use.
 *
 * Both paths go through undici's own `WebSocket` now, not only the insecure
 * one: the payload limit lives on the dispatcher, and the global
 * implementation offers no way to set it. A dispatcher is a connection pool,
 * so it is shared rather than built per call — the pairs are two in practice
 * (one per TLS setting), the map is here for tests that vary the limit.
 */
const dispatchers = new Map<string, Agent>();

function dispatcherFor(options: WebSocketOptions): Agent {
  const key = `${options.insecureTls}:${options.maxFrameBytes}`;
  let agent = dispatchers.get(key);
  if (!agent) {
    agent = new Agent({
      // Scoped: relaxed certificate validation reaches the configured
      // connection only, never the process.
      connect: options.insecureTls ? { rejectUnauthorized: false } : {},
      // The bound that matters. undici reads the payload length out of the
      // frame header and fails the connection there, before a byte of the
      // payload is buffered; its default is 128 MB.
      webSocket: { maxPayloadSize: options.maxFrameBytes },
    } as ConstructorParameters<typeof Agent>[0]);
    dispatchers.set(key, agent);
  }
  return agent;
}

/** Default factory: undici's WebSocket on a dispatcher that carries the limits. */
export function defaultWebSocketFactory(
  url: string,
  options: WebSocketOptions
): WebSocketLike {
  return new UndiciWebSocket(url, {
    dispatcher: dispatcherFor(options),
  }) as unknown as WebSocketLike;
}

/** Maps the configured http(s) base URL to the ws(s) socket URL for a pad. */
export function socketUrl(baseUrl: string, id: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${url.origin}${stripTrailingSlashes(url.pathname)}/api/socket/${encodeURIComponent(id)}`;
}

/** Pulls messages out of event-listener callbacks into an awaitable queue. */
class MessageQueue {
  private readonly queue: string[] = [];
  private queuedBytes = 0;
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
    if (
      this.queue.length >= this.limits.maxQueuedMessages ||
      this.queuedBytes + message.length > this.limits.maxQueuedBytes
    ) {
      this.end(
        new Error(
          'the Rustpad server sent more data than this client will buffer'
        )
      );
      return;
    }
    this.queue.push(message);
    this.queuedBytes += message.length;
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
    if (queued !== undefined) {
      this.queuedBytes -= queued.length;
      return queued;
    }
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
    sawHistory: false,
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
      maxFrameBytes: limits.maxFrameBytes,
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
      this.handle(raw, deadline);
    }
  }

  /**
   * Folds one server message into the state.
   *
   * `deadline` is the wall-clock limit of whatever wait this message arrived
   * during, and it is passed in rather than checked by the caller because the
   * expensive part happens *here*: a single History message can carry tens of
   * thousands of operations, and the caller's own deadline check is not reached
   * again until all of them have been applied.
   */
  private handle(raw: string, deadline: number): ServerMsg {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('the Rustpad server sent a message that is not JSON');
    }
    // `null` and `42` are JSON too. Read as an object, `null` answered the
    // tool call with "Cannot read properties of null (reading 'Identity')".
    if (!isRecord(parsed)) {
      throw new Error(
        'the Rustpad server sent a message that is not a JSON object'
      );
    }
    const msg = parsed as ServerMsg;
    if (msg.Identity !== undefined) {
      if (typeof msg.Identity === 'number') this.identity = msg.Identity;
    } else if (msg.History !== undefined) {
      if (!isValidHistory(msg.History)) {
        throw new Error('the Rustpad server sent a malformed History message');
      }
      const { start, operations } = msg.History;
      if (operations.length > this.limits.maxHistoryOperations) {
        throw new Error(
          `the Rustpad server sent a History of ${operations.length} operations, more than the ${this.limits.maxHistoryOperations} this client will fold`
        );
      }
      // A History that starts past the revision this client holds is a gap:
      // operations the server applied that this client never saw. Folding
      // nothing and calling the pad "seen" would let a write skip the
      // second-channel check and land beside content the server has and
      // this client does not. Rustpad replays from zero on connect and
      // broadcasts contiguously after that, so a gap is not a slow instance;
      // it is a different server.
      if (start > this.state.revision) {
        throw new Error(
          `the Rustpad server sent a History starting at revision ${start} while this client holds ${this.state.revision} — the pad state cannot be trusted`
        );
      }
      this.state.sawHistory = true;
      // The server replays from `start`; anything before the local revision
      // has been applied already.
      for (let i = this.state.revision - start; i < operations.length; i++) {
        const entry = operations[i];
        if (!entry) break;
        // Inside the loop, not around it: each iteration costs O(document
        // length), so a frame full of operations against a large document is
        // minutes of work that no outer deadline check would interrupt. A
        // hostile or broken upstream must cost a failed tool call, not a hung
        // process, and this is the only place that stays true of.
        if (Date.now() > deadline) {
          throw new Error(
            'the Rustpad server sent more edit history than this client could apply before its deadline — the pad may be too heavily edited to work with through this server'
          );
        }
        const text = applyOperation(this.state.text, entry.operation);
        // Rustpad itself rejects edits beyond this size, so anything larger
        // arriving inbound is not a legitimate document — refuse to buffer it.
        // The UTF-16 length is never below the code-point count, so the cheap
        // comparison rules out every operation but the ones near the limit,
        // and only those pay for the exact scan.
        if (
          text.length > MAX_DOCUMENT_CODEPOINTS &&
          codepointLength(text) > MAX_DOCUMENT_CODEPOINTS
        ) {
          throw new Error(
            'the Rustpad server sent a document above the 256 KiB limit'
          );
        }
        this.state.text = text;
        this.state.revision++;
      }
    } else if (msg.Language !== undefined) {
      if (typeof msg.Language === 'string') {
        this.state.language = cleanText(msg.Language, 100);
      }
    } else if (isRecord(msg.UserInfo)) {
      const { id, info } = msg.UserInfo as { id: unknown; info: unknown };
      if (typeof id === 'number' && id !== this.identity) {
        if (
          isRecord(info) &&
          typeof info.name === 'string' &&
          typeof info.hue === 'number'
        ) {
          if (
            this.state.users.size < this.limits.maxUsers ||
            this.state.users.has(id)
          ) {
            this.state.users.set(id, {
              // A name is typed by whoever opened the pad: control
              // characters out, and a cut that cannot leave half a pair.
              name: cleanText(info.name, MAX_USER_NAME_LENGTH),
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
        // Deliberately does not claim the pad is unchanged. The echo is the
        // only acknowledgement this protocol has, and its absence says nothing
        // about whether the operation was applied — the server may have taken
        // it and lost the echo. Saying "unchanged" would invite exactly the
        // retry that turns one append into two.
        throw new Error(
          'the Rustpad server did not acknowledge the edit in time — whether it was applied is unknown. ' +
            'Read the pad with get_document before deciding what to do; in particular do not repeat ' +
            'append_to_document, which would append the text a second time if the first one landed.'
        );
      }
      const raw = await this.messages.next(remaining);
      if (raw === null) continue;
      const msg = this.handle(raw, deadline);
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
      const msg = this.handle(raw, deadline);
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
