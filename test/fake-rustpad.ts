import { applyOperation, type Op } from '../src/ot.js';
import type { WebSocketFactory, WebSocketLike } from '../src/session.js';

interface HistoryEntry {
  id: number;
  operation: Op[];
}

interface Doc {
  operations: HistoryEntry[];
  text: string;
  language?: string;
  users: Map<number, { name: string; hue: number }>;
}

type Listener = (event: { data?: unknown }) => void;

function cpLength(text: string): number {
  return [...text].length;
}

/**
 * Transforms `a` so it applies after `b`, both based on the same document —
 * the same thing rustpad-server does with edits sent at a stale revision.
 * Minimal port of the ot.js algorithm for the flat wire format.
 */
export function transform(a: readonly Op[], b: readonly Op[]): Op[] {
  const result: Op[] = [];
  const push = (op: Op) => {
    if (op === 0 || op === '') return;
    const last = result[result.length - 1];
    if (typeof op === 'string' && typeof last === 'string') {
      result[result.length - 1] = last + op;
    } else if (
      typeof op === 'number' &&
      typeof last === 'number' &&
      Math.sign(op) === Math.sign(last)
    ) {
      result[result.length - 1] = last + op;
    } else {
      result.push(op);
    }
  };

  const as = [...a];
  const bs = [...b];
  let ao = as.shift();
  let bo = bs.shift();
  for (;;) {
    if (ao === undefined && bo === undefined) break;
    // Insertions in `a` happen regardless of what `b` did around them.
    if (typeof ao === 'string') {
      push(ao);
      ao = as.shift();
      continue;
    }
    // Insertions in `b` become retains: those characters now exist.
    if (typeof bo === 'string') {
      push(cpLength(bo));
      bo = bs.shift();
      continue;
    }
    if (ao === undefined || bo === undefined) {
      throw new Error('transform: operations have different base lengths');
    }
    const chunk = Math.min(Math.abs(ao), Math.abs(bo));
    if (ao > 0 && bo > 0) {
      push(chunk);
    } else if (ao < 0 && bo > 0) {
      push(-chunk);
    }
    // b deleted the characters: whatever a wanted there is moot.
    ao = Math.sign(ao) * (Math.abs(ao) - chunk) || undefined;
    bo = Math.sign(bo) * (Math.abs(bo) - chunk) || undefined;
    if (ao === undefined) ao = as.shift();
    if (bo === undefined) bo = bs.shift();
  }
  return result;
}

/**
 * In-memory stand-in for rustpad-server: plays the WebSocket protocol far
 * enough for the session code — initial burst, Edit echo, Language broadcast.
 * It deliberately does NOT transform concurrent edits; tests that need
 * interleaving inject the external operation through `onClientInfo`, before
 * the client's own edit is applied.
 */
export class FakeRustpad {
  readonly docs = new Map<string, Doc>();
  private nextIdentity = 0;
  /** When set, the next connection attempt fails at the socket level. */
  failNextConnection = false;
  /** When set, the server drops the connection instead of answering an edit. */
  closeOnEdit = false;
  /**
   * Milliseconds by which the initial History message trails the rest of the
   * burst. Zero — a healthy local instance — is the default.
   *
   * Anything past `settleIdleMs` reproduces the one thing the socket cannot
   * express: Rustpad sends no History at all for a pad that was never written,
   * so a History that is merely *late* is indistinguishable from an empty pad.
   * A slow instance, a database restore, a buffering proxy or round-trip time
   * plus a TLS handshake all produce it, and every test written against the
   * synchronous burst has the guard present by accident.
   */
  historyDelayMs = 0;
  /** Hook that runs when a client announces itself, before any edit. */
  onClientInfo: ((docId: string) => void) | undefined;
  /** Sockets currently open, by doc id, for broadcasting external edits. */
  private readonly sockets = new Map<string, Set<FakeSocket>>();

  readonly factory: WebSocketFactory = (url) => {
    const match = /\/api\/socket\/([^/]+)$/.exec(url);
    if (!match || !match[1]) throw new Error(`unexpected socket url: ${url}`);
    const socket = new FakeSocket(
      this,
      decodeURIComponent(match[1]),
      this.failNextConnection
    );
    this.failNextConnection = false;
    return socket;
  };

  doc(id: string): Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = { operations: [], text: '', users: new Map() };
      this.docs.set(id, doc);
    }
    return doc;
  }

  seed(id: string, text: string, language?: string): void {
    const doc = this.doc(id);
    doc.operations.push({ id: Number.MAX_SAFE_INTEGER, operation: [text] });
    doc.text = text;
    if (language !== undefined) doc.language = language;
  }

  addUser(id: string, name: string, hue = 10): void {
    this.doc(id).users.set(this.claimIdentity(), { name, hue });
  }

  claimIdentity(): number {
    return this.nextIdentity++;
  }

  register(docId: string, socket: FakeSocket): void {
    let set = this.sockets.get(docId);
    if (!set) {
      set = new Set();
      this.sockets.set(docId, set);
    }
    set.add(socket);
  }

  unregister(docId: string, socket: FakeSocket): void {
    this.sockets.get(docId)?.delete(socket);
  }

  /** Sends a raw (possibly malformed) frame to every open socket of a pad. */
  emitRaw(docId: string, raw: string): void {
    for (const socket of this.sockets.get(docId) ?? []) {
      socket.emitData(raw);
    }
  }

  /** Applies an edit from "someone else" and broadcasts it to open sockets. */
  externalEdit(docId: string, operation: Op[]): void {
    const doc = this.doc(docId);
    const start = doc.operations.length;
    const entry = { id: this.claimIdentity(), operation };
    doc.text = applyOperation(doc.text, operation);
    doc.operations.push(entry);
    for (const socket of this.sockets.get(docId) ?? []) {
      socket.emitMessage({ History: { start, operations: [entry] } });
    }
  }
}

class FakeSocket implements WebSocketLike {
  private readonly listeners = new Map<string, Listener[]>();
  private readonly identity: number;

  constructor(
    private readonly server: FakeRustpad,
    private readonly docId: string,
    failConnection: boolean
  ) {
    this.identity = server.claimIdentity();
    setTimeout(() => {
      if (failConnection) {
        this.emit('error', {});
        return;
      }
      this.server.register(this.docId, this);
      this.emit('open', {});
      const doc = this.server.doc(this.docId);
      this.emitMessage({ Identity: this.identity });
      const history = () => {
        if (doc.operations.length > 0) {
          this.emitMessage({
            History: { start: 0, operations: doc.operations },
          });
        }
      };
      if (this.server.historyDelayMs > 0) {
        // Unref: a delayed frame that arrives after the session closed must
        // not keep the test process alive.
        setTimeout(history, this.server.historyDelayMs).unref?.();
      } else {
        history();
      }
      if (doc.language !== undefined) {
        this.emitMessage({ Language: doc.language });
      }
      for (const [id, info] of doc.users) {
        this.emitMessage({ UserInfo: { id, info } });
      }
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    const msg = JSON.parse(data) as {
      Edit?: { revision: number; operation: Op[] };
      SetLanguage?: string;
      ClientInfo?: { name: string; hue: number };
    };
    const doc = this.server.doc(this.docId);
    if (msg.ClientInfo) {
      this.server.onClientInfo?.(this.docId);
      return;
    }
    if (msg.SetLanguage !== undefined) {
      doc.language = msg.SetLanguage;
      this.emitMessage({ Language: msg.SetLanguage });
      return;
    }
    if (msg.Edit) {
      if (this.server.closeOnEdit) {
        this.close();
        return;
      }
      if (msg.Edit.revision > doc.operations.length) {
        throw new Error(
          `fake server: edit at future revision ${msg.Edit.revision}`
        );
      }
      // Like the real server: transform the edit over everything that
      // happened since the revision it was based on.
      let operation = msg.Edit.operation;
      for (const past of doc.operations.slice(msg.Edit.revision)) {
        operation = transform(operation, past.operation);
      }
      const entry = { id: this.identity, operation };
      const start = doc.operations.length;
      doc.text = applyOperation(doc.text, operation);
      doc.operations.push(entry);
      this.emitMessage({ History: { start, operations: [entry] } });
    }
  }

  close(): void {
    this.server.unregister(this.docId, this);
    this.emit('close', {});
  }

  emitMessage(message: unknown): void {
    this.emitData(JSON.stringify(message));
  }

  emitData(raw: string): void {
    this.emit('message', { data: raw });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
