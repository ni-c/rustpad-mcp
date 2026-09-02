import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import {
  DEFAULT_LIMITS,
  RustpadSession,
  socketUrl,
  type SessionLimits,
  type WebSocketLike,
} from '../src/session.js';

const CONFIG: Config = {
  url: 'https://rustpad.example.net',
  insecureTls: false,
  readOnly: false,
};

type Listener = (event: { data?: unknown }) => void;

/**
 * A server under the attacker's control: connects fine, then behaves however
 * the `script` says. Tracks whether the client closed the socket.
 */
class HostileSocket implements WebSocketLike {
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(script: (socket: HostileSocket) => void) {
    setTimeout(() => {
      this.emit('open', {});
      this.message({ Identity: 0 });
      script(this);
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(_data: string): void {}

  close(): void {
    this.closed = true;
  }

  message(payload: unknown): void {
    this.raw(JSON.stringify(payload));
  }

  raw(data: string): void {
    this.emit('message', { data });
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function limits(overrides: Partial<SessionLimits>): SessionLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

async function openAgainst(
  script: (socket: HostileSocket) => void,
  sessionLimits: SessionLimits = DEFAULT_LIMITS
): Promise<{ session: Promise<RustpadSession>; socket: () => HostileSocket }> {
  let created: HostileSocket | undefined;
  const session = RustpadSession.open(
    CONFIG,
    'pad',
    () => {
      created = new HostileSocket(script);
      return created;
    },
    sessionLimits
  );
  return { session, socket: () => created! };
}

describe('socketUrl', () => {
  it('maps http(s) to ws(s) and escapes the id', () => {
    expect(socketUrl('https://rustpad.example.net', 'a b')).toBe(
      'wss://rustpad.example.net/api/socket/a%20b'
    );
    expect(socketUrl('http://localhost:3030', 'x')).toBe(
      'ws://localhost:3030/api/socket/x'
    );
  });

  it('keeps a path prefix intact', () => {
    expect(socketUrl('https://rustpad.example.net/pad', 'x')).toBe(
      'wss://rustpad.example.net/pad/api/socket/x'
    );
  });
});

describe('RustpadSession against a hostile server', () => {
  it('rejects an invalid document id before opening a socket', async () => {
    await expect(
      RustpadSession.open(CONFIG, '..', () => {
        throw new Error('factory must not be reached');
      })
    ).rejects.toThrow(/invalid document id/);
  });

  it('gives up when the server never goes idle, and closes the socket', async () => {
    const { session, socket } = await openAgainst(
      (s) => {
        const timer = setInterval(() => s.message({ Language: 'x' }), 20);
        // Unref so a leaked interval cannot keep the test process alive.
        timer.unref?.();
      },
      limits({ settleIdleMs: 50, settleDeadlineMs: 300 })
    );
    await expect(session).rejects.toThrow(/kept sending/);
    expect(socket().closed).toBe(true);
  });

  it('refuses to buffer an unbounded message flood', async () => {
    const { session, socket } = await openAgainst(
      (s) => {
        // Synchronous burst: only one message can be consumed by the parked
        // reader, the rest must hit the queue cap.
        for (let i = 0; i < 50; i++) s.message({ Language: `l${i}` });
      },
      limits({ maxQueuedMessages: 10 })
    );
    await expect(session).rejects.toThrow(/more data than this client/);
    expect(socket().closed).toBe(true);
  });

  it('refuses a single oversized frame', async () => {
    const { session, socket } = await openAgainst(
      (s) => s.raw('x'.repeat(2048)),
      limits({ maxFrameBytes: 1024 })
    );
    await expect(session).rejects.toThrow(/frame larger/);
    expect(socket().closed).toBe(true);
  });

  it('refuses a History that grows the document past the Rustpad limit', async () => {
    const { session, socket } = await openAgainst((s) =>
      s.message({
        History: {
          start: 0,
          operations: [{ id: 99, operation: ['x'.repeat(256 * 1024 + 1)] }],
        },
      })
    );
    await expect(session).rejects.toThrow(/256 KiB/);
    expect(socket().closed).toBe(true);
  });

  it('refuses a structurally malformed History message', async () => {
    const { session, socket } = await openAgainst((s) =>
      s.message({
        History: { start: 0, operations: [{ id: 1, operation: null }] },
      })
    );
    await expect(session).rejects.toThrow(/malformed History/);
    expect(socket().closed).toBe(true);
  });

  it('refuses a History operation with an invalid op component', async () => {
    const { session } = await openAgainst((s) =>
      s.message({
        History: { start: 0, operations: [{ id: 1, operation: [0] }] },
      })
    );
    await expect(session).rejects.toThrow(/zero-length/);
  });

  it('refuses a History carrying more operations than it will fold', async () => {
    // The backstop on maxFrameBytes: at the default frame size this cap cannot
    // fire, and it is set that way on purpose, so the limits are lowered here
    // to reach it. What bounds the work at default settings is the deadline
    // check in the test below.
    const { session, socket } = await openAgainst(
      (s) =>
        s.message({
          History: {
            start: 0,
            operations: Array.from({ length: 10 }, (_, i) => ({
              id: i,
              operation: ['x'],
            })),
          },
        }),
      limits({ maxHistoryOperations: 3 })
    );
    await expect(session).rejects.toThrow(/more than the 3 this client/);
    expect(socket().closed).toBe(true);
  });

  it('abandons a History it cannot fold within the deadline', async () => {
    // The deadline check that used to sit only *around* `handle`, where a
    // single frame could hold the event loop for as long as it liked. Measured
    // at 2.4 ms per operation against a full document, 35 000 of them are 85
    // seconds of synchronous work in which nothing is ever consulted.
    const filler = 'x'.repeat(100_000);
    const { session, socket } = await openAgainst(
      (s) => {
        s.message({
          History: { start: 0, operations: [{ id: 1, operation: [filler] }] },
        });
        s.message({
          History: {
            start: 1,
            operations: Array.from({ length: 2000 }, (_, i) => ({
              id: i + 2,
              operation: [100_000],
            })),
          },
        });
      },
      limits({ settleIdleMs: 20, settleDeadlineMs: 30 })
    );
    // Without the check inside the loop this still fails — but only after all
    // 2000 operations have run, and with the message about a chatty server
    // rather than about the work it asked for.
    await expect(session).rejects.toThrow(/could apply before its deadline/);
    expect(socket().closed).toBe(true);
  });

  it('does not claim the pad is unchanged when the echo never comes', async () => {
    // The acknowledgement is the History echo and nothing else, so its absence
    // says nothing about whether the server applied the operation. Claiming it
    // did not is an invitation to retry, and `append_to_document` retried is
    // the text twice.
    const { session } = await openAgainst(
      () => {},
      limits({ settleIdleMs: 20, ackTimeoutMs: 50 })
    );
    const opened = await session;
    const failure = await opened
      .edit(['x'])
      .then(() => 'the edit resolved, which it must not')
      .catch((error: unknown) => (error as Error).message);
    expect(failure).toContain('whether it was applied is unknown');
    expect(failure).toContain('get_document');
    expect(failure).toContain('append_to_document');
    expect(failure).not.toContain('left unchanged');
    opened.close();
  });

  it('caps the tracked users and truncates their names', async () => {
    const { session } = await openAgainst(
      (s) => {
        for (let i = 1; i <= 10; i++) {
          s.message({
            UserInfo: { id: i, info: { name: 'n'.repeat(500), hue: 1 } },
          });
        }
      },
      limits({ maxUsers: 3 })
    );
    const opened = await session;
    expect(opened.state.users.size).toBe(3);
    for (const user of opened.state.users.values()) {
      expect(user.name.length).toBeLessThanOrEqual(100);
    }
    opened.close();
  });

  it('ignores garbage in optional fields instead of crashing', async () => {
    const { session } = await openAgainst((s) => {
      s.message({ Identity: 'not a number' });
      s.message({ Language: 42 });
      s.message({ UserInfo: { id: 'x', info: { name: 1, hue: 'y' } } });
      s.message({ UserCursor: { whatever: true } });
    });
    const opened = await session;
    expect(opened.state.language).toBeUndefined();
    expect(opened.state.users.size).toBe(0);
    opened.close();
  });
});
