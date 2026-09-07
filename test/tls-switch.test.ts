import { describe, expect, it, vi } from 'vitest';

/**
 * The one code path that weakens TLS, and the one that carries the payload
 * limit, both live on the dispatcher handed to undici. Neither can be
 * observed through a fake socket, so undici is mocked here — hoisted, in its
 * own file — and what the module hands it is read back.
 */
const agents: unknown[] = [];
const sockets: { url: string; init: unknown }[] = [];
const fetches: { url: string; init: unknown }[] = [];

vi.mock('undici', () => ({
  Agent: class {
    constructor(public readonly options: unknown) {
      agents.push(options);
    }
  },
  WebSocket: class {
    constructor(url: string, init: unknown) {
      sockets.push({ url, init });
    }
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  },
  fetch: vi.fn(async (url: string, init: unknown) => {
    fetches.push({ url, init });
    return new Response('body', { status: 200 });
  }),
}));

const { defaultWebSocketFactory } = await import('../src/session.js');
const { RustpadApi } = await import('../src/api.js');
const { testConfig } = await import('./harness.js');

interface AgentOptions {
  connect?: { rejectUnauthorized?: boolean };
  webSocket?: { maxPayloadSize?: number };
}

describe('the WebSocket dispatcher', () => {
  it('carries the payload limit on both TLS settings, and relaxes validation only under the switch', () => {
    defaultWebSocketFactory('wss://a/api/socket/x', {
      insecureTls: false,
      maxFrameBytes: 4321,
    });
    defaultWebSocketFactory('wss://a/api/socket/x', {
      insecureTls: true,
      maxFrameBytes: 4321,
    });
    const [plain, insecure] = agents as AgentOptions[];
    expect(plain?.webSocket?.maxPayloadSize).toBe(4321);
    expect(insecure?.webSocket?.maxPayloadSize).toBe(4321);
    expect(plain?.connect?.rejectUnauthorized).toBeUndefined();
    expect(insecure?.connect?.rejectUnauthorized).toBe(false);
    // Both sockets were built on a dispatcher, so the limit reaches them.
    expect(sockets).toHaveLength(2);
    for (const socket of sockets) {
      expect((socket.init as { dispatcher: unknown }).dispatcher).toBeDefined();
    }
  });

  it('shares one dispatcher per setting rather than building one per pad', () => {
    const before = agents.length;
    defaultWebSocketFactory('wss://a/api/socket/y', {
      insecureTls: false,
      maxFrameBytes: 4321,
    });
    expect(agents.length).toBe(before);
  });
});

describe('the HTTP client under RUSTPAD_INSECURE_TLS', () => {
  it("goes through undici's fetch with the scoped dispatcher, never the global one", async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const api = new RustpadApi(testConfig({ insecureTls: true }));
    const text = await api.text('pad');
    expect(text).toBe('body');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(fetches).toHaveLength(1);
    const init = fetches[0]?.init as {
      dispatcher: { options: AgentOptions };
      redirect: string;
    };
    expect(init.dispatcher.options.connect?.rejectUnauthorized).toBe(false);
    expect(init.redirect).toBe('error');
  });

  it('uses the global fetch and no dispatcher without the switch', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('plain', { status: 200 }));
    const api = new RustpadApi(testConfig());
    expect(await api.text('pad')).toBe('plain');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    // Only the insecure client above built a dispatcher for HTTP.
    const insecureAgents = (agents as AgentOptions[]).filter(
      (options) => options.connect?.rejectUnauthorized === false
    );
    expect(insecureAgents.length).toBeGreaterThanOrEqual(1);
  });
});
