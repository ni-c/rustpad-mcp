import { afterEach, describe, expect, it, vi } from 'vitest';

import { RustpadApi } from '../src/api.js';
import { loadConfig, stripTrailingSlashes } from '../src/config.js';
import { codepointLength } from '../src/ot.js';
import {
  budgetedText,
  MAX_RESULT_BYTES,
  sanitizeErrorBody,
} from '../src/result.js';
import {
  DEFAULT_LIMITS,
  RustpadSession,
  socketUrl,
  type SessionLimits,
  type WebSocketLike,
} from '../src/session.js';
import { FakeRustpad } from './fake-rustpad.js';
import { callText, connect, mockFetch, testConfig } from './harness.js';

/**
 * The internal security review of 2026-09-07, as tests.
 *
 * Every case here reproduced a defect against `dist/` before the fix and
 * asserts on the result, the thrown error or the request — never on "the
 * guard was called". Characters that must not appear in a source file are
 * built at runtime.
 */

const ESC = String.fromCharCode(0x1b);

afterEach(() => {
  vi.restoreAllMocks();
});

function silence() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

function trapExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
}

type Listener = (event: { data?: unknown }) => void;

/** A server that says whatever `script` makes it say, then goes quiet. */
class ScriptedSocket implements WebSocketLike {
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(script: (raw: (data: string) => void) => void) {
    setTimeout(() => {
      this.emit('open', {});
      this.raw(JSON.stringify({ Identity: 0 }));
      script((data) => this.raw(data));
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(): void {}

  close(): void {
    this.closed = true;
  }

  raw(data: string): void {
    this.emit('message', { data });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function open(
  script: (raw: (data: string) => void) => void,
  limits: Partial<SessionLimits> = {}
): Promise<RustpadSession> {
  return RustpadSession.open(
    testConfig(),
    'pad',
    () => new ScriptedSocket(script),
    { ...DEFAULT_LIMITS, settleIdleMs: 20, ...limits }
  );
}

describe('startup diagnostics do not echo what was pasted (4.5, 6.3)', () => {
  it('names neither the scheme nor the value of a URL with the wrong scheme', () => {
    const error = silence();
    trapExit();
    // A hexadecimal key with a colon after it is a valid URL whose scheme is
    // the key; the "not a valid URL" branch never sees it.
    const key = 'deadbeefcafe0123456789abcdef0123456789abcdef0123456789ab';
    expect(() => loadConfig({ RUSTPAD_URL: `${key}:x` })).toThrow('exit');
    const printed = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('http:// or https://');
    expect(printed).not.toContain(key.slice(0, 12));
  });

  it('describes a long ELICITATION value by its length', () => {
    const error = silence();
    trapExit();
    const secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghijklmnop';
    expect(() =>
      loadConfig({ RUSTPAD_URL: 'https://h', ELICITATION: secret })
    ).toThrow('exit');
    const printed = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain(`a ${secret.length}-character value`);
    expect(printed).not.toContain('eyJhbGci');
    // A short typo is still quoted, so the operator can see it.
    error.mockClear();
    expect(() =>
      loadConfig({ RUSTPAD_URL: 'https://h', ELICITATION: 'off' })
    ).toThrow('exit');
    expect(String(error.mock.calls[0]?.[0])).toContain('got "off"');
  });
});

describe('the base URL is stored as parsed (6.2, 1.8)', () => {
  it('drops surrounding whitespace and encodes the path', () => {
    silence();
    expect(loadConfig({ RUSTPAD_URL: ' https://h/x ' }).url).toBe(
      'https://h/x'
    );
    expect(loadConfig({ RUSTPAD_URL: 'https://h/ /x' }).url).toBe(
      'https://h/%20/x'
    );
    expect(loadConfig({ RUSTPAD_URL: 'HTTPS://H///' }).url).toBe('https://h');
  });

  it('strips a run of trailing slashes in linear time', () => {
    const run = '/'.repeat(1_000_000);
    const started = performance.now();
    expect(stripTrailingSlashes(`/base${run}`)).toBe('/base');
    expect(socketUrl(`https://h/base${run}`, 'p')).toBe(
      'wss://h/base/api/socket/p'
    );
    expect(performance.now() - started).toBeLessThan(200);
  });
});

/** What a fetch stub without a body stream looks like. */
function stub(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    text: async () => text,
  } as unknown as Response;
}

describe('the status decides before the body is read (6.5, 6.8)', () => {
  it('reports a 502 with its hint even when the error page is enormous', async () => {
    mockFetch('x'.repeat(9 * 1024 * 1024), 502);
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'get_document', { id: 'p' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 502');
    expect(result.text).toContain('down or unreachable');
    expect(result.text).not.toContain('byte limit');
    expect(result.text.length).toBeLessThan(4000);
  });

  it('keeps the status when the error body cannot be read at all', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('reset'));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(broken, { status: 503 })
    );
    const api = new RustpadApi(testConfig());
    await expect(api.text('p')).rejects.toMatchObject({
      status: 503,
      body: '',
    });
  });

  it('reads a response without a body stream through text(), under the cap', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(stub('hello'));
    const api = new RustpadApi(testConfig());
    expect(await api.text('p')).toBe('hello');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stub('y'.repeat(9 * 1024 * 1024))
    );
    await expect(api.text('p')).rejects.toThrow(/byte limit/);
  });
});

describe('what the instance wrote reaches the model cleaned (4.1, 4.2, 5.x)', () => {
  it('strips control characters from pad text but keeps its lines', async () => {
    mockFetch(`line one${ESC}[2J\n\tline two\r\n`);
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'get_document', { id: 'p' });
    expect(result.isError).toBe(false);
    expect((result.structured as { text: string }).text).toBe(
      'line one[2J\n\tline two\r\n'
    );
  });

  it('cleans user names and the language, and never answers a lone surrogate', async () => {
    const fake = new FakeRustpad();
    fake.addUser('p', `a${ESC}[31m${'😀'.repeat(60)}`);
    fake.seed('p', 'text', `x${ESC}${'😀'.repeat(60)}`);
    const client = await connect(fake);
    const result = await callText(client, 'get_document_info', { id: 'p' });
    expect(result.isError).toBe(false);
    const info = result.structured as {
      active_users: string[];
      language: string;
    };
    expect(info.active_users).toHaveLength(1);
    for (const value of [...info.active_users, info.language]) {
      expect(value).not.toContain(ESC);
      expect(value.isWellFormed()).toBe(true);
      expect(value.length).toBeLessThanOrEqual(100);
    }
  });

  it('strips control characters from an upstream error body', () => {
    expect(sanitizeErrorBody(`bad ${ESC}[1A gateway`)).toBe('bad [1A gateway');
    expect(sanitizeErrorBody('😀'.repeat(1001)).isWellFormed()).toBe(true);
  });
});

describe('the result budget measures the text as serialised (3.3)', () => {
  it('keeps the text block inside the budget when every character escapes', () => {
    const { text, truncated } = budgetedText('\\'.repeat(MAX_RESULT_BYTES));
    expect(JSON.stringify(text).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(truncated?.shown).toBe(codepointLength(text));
    expect(truncated?.total).toBe(MAX_RESULT_BYTES);
  });

  it('cuts on a code point and counts code points', () => {
    const { text, truncated } = budgetedText('😀'.repeat(MAX_RESULT_BYTES));
    expect(text.isWellFormed()).toBe(true);
    expect(truncated?.total).toBe(MAX_RESULT_BYTES);
    expect(truncated?.shown).toBe(codepointLength(text));
  });
});

describe('server statistics are checked at the boundary (3.5, 3.8)', () => {
  const cases: [string, string][] = [
    [
      'a start time past what Date can hold',
      '{"start_time":1e300,"num_documents":1,"database_size":0}',
    ],
    [
      'a fractional count',
      '{"start_time":1755500000,"num_documents":1.5,"database_size":0}',
    ],
    [
      'an infinite count',
      '{"start_time":1755500000,"num_documents":1e999,"database_size":0}',
    ],
    [
      'a negative count',
      '{"start_time":1755500000,"num_documents":1,"database_size":-1}',
    ],
    ['a null body', 'null'],
    ['a list', '[1,2,3]'],
  ];
  for (const [label, body] of cases) {
    it(`answers a sentence, not a validation error, for ${label}`, async () => {
      mockFetch(body, 200, 'application/json');
      const client = await connect(new FakeRustpad());
      const result = await callText(client, 'get_stats');
      expect(result.isError).toBe(true);
      expect(result.text).toContain('unexpected shape');
      expect(result.text).not.toContain('Output validation error');
      expect(result.text).not.toContain('Invalid time value');
    });
  }
});

describe('frames from the instance are checked as objects (3.8)', () => {
  it('refuses a message that is JSON but not an object', async () => {
    await expect(open((raw) => raw('null'))).rejects.toThrow(
      /not a JSON object/
    );
    await expect(open((raw) => raw('[1]'))).rejects.toThrow(
      /not a JSON object/
    );
  });

  it('ignores a UserInfo that is not an object instead of crashing', async () => {
    const session = await open((raw) => {
      raw('{"UserInfo":null}');
      raw('{"UserInfo":"x"}');
      raw('{"UserInfo":{"id":3,"info":{"name":"n","hue":1}}}');
    });
    expect(session.state.users.size).toBe(1);
    session.close();
  });

  it('refuses a History that starts past the revision it holds', async () => {
    await expect(
      open((raw) =>
        raw('{"History":{"start":5,"operations":[{"id":1,"operation":["x"]}]}}')
      )
    ).rejects.toThrow(/cannot be trusted/);
  });

  it('refuses an id that is not an integer', async () => {
    await expect(
      open((raw) =>
        raw(
          '{"History":{"start":0,"operations":[{"id":1.5,"operation":["x"]}]}}'
        )
      )
    ).rejects.toThrow(/malformed History/);
  });

  it('keeps counting code points on a lone surrogate the instance sent', async () => {
    const session = await open((raw) =>
      raw(
        `{"History":{"start":0,"operations":[{"id":1,"operation":["${'\\'}ud800abc"]}]}}`
      )
    );
    expect(session.state.text).toBe(`${String.fromCharCode(0xd800)}abc`);
    expect(codepointLength(session.state.text)).toBe(4);
    session.close();
  });
});

describe('the queue is bounded in bytes, not only in messages (1.2)', () => {
  it('refuses a burst whose total exceeds the byte budget', async () => {
    const frame = JSON.stringify({ UserCursor: 'x'.repeat(900 * 1024) });
    await expect(
      open(
        (raw) => {
          for (let i = 0; i < 20; i++) raw(frame);
        },
        { maxQueuedBytes: 8 * 1024 * 1024, maxQueuedMessages: 1000 }
      )
    ).rejects.toThrow(/more data than this client will buffer/);
  });

  it('releases the budget as messages are consumed', async () => {
    // Twenty frames of a tenth of the budget each, one per turn of the event
    // loop: consumed as they come, never more than one in the queue.
    const frame = JSON.stringify({ UserCursor: 'x'.repeat(800 * 1024) });
    const session = await open(
      (raw) => {
        for (let i = 0; i < 20; i++) setTimeout(() => raw(frame), i);
      },
      { maxQueuedBytes: 8 * 1024 * 1024, settleIdleMs: 100 }
    );
    session.close();
  });
});

describe('caller input has a ceiling (1.3)', () => {
  it('refuses a confirmation token longer than any it issues', async () => {
    const fake = new FakeRustpad();
    fake.seed('p', 'old');
    const client = await connect(fake);
    const result = await callText(client, 'set_document', {
      id: 'p',
      text: 'new',
      confirm_token: 'f'.repeat(65),
    });
    expect(result.isError).toBe(true);
    expect(fake.doc('p').text).toBe('old');
  });
});
