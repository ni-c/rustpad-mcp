import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertDocumentId, RustpadApi } from '../src/api.js';
import type { Config } from '../src/config.js';

const CONFIG: Config = {
  url: 'https://rustpad.example.net',
  insecureTls: false,
  readOnly: false,
  elicitation: true,
  allowTools: undefined,
  denyTools: undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RustpadApi', () => {
  it('refuses to call out without a configured URL', async () => {
    const api = new RustpadApi({ ...CONFIG, url: undefined });
    await expect(api.text('x')).rejects.toThrow(/RUSTPAD_URL/);
  });

  it('rejects a response with an oversized content-length up front', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'content-length': String(100 * 1024 * 1024) },
      })
    );
    const api = new RustpadApi(CONFIG);
    await expect(api.text('x')).rejects.toThrow(/byte limit/);
  });

  it('rejects a streamed body that exceeds the limit', async () => {
    const chunk = new TextEncoder().encode('y'.repeat(1024 * 1024));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(endless, { status: 200 })
    );
    const api = new RustpadApi(CONFIG);
    await expect(api.text('x')).rejects.toThrow(/byte limit/);
  });

  it('rejects stats that are not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 200 })
    );
    const api = new RustpadApi(CONFIG);
    await expect(api.stats()).rejects.toThrow(/valid JSON/);
  });

  it('escapes the document id in the request path', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const api = new RustpadApi(CONFIG);
    await api.text('a.b-c_d');
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      'https://rustpad.example.net/api/text/a.b-c_d'
    );
  });
});

describe('assertDocumentId', () => {
  it('accepts the frontend id shape', () => {
    expect(assertDocumentId('abc123XYZ._-')).toBe('abc123XYZ._-');
  });

  it('rejects traversal and separator characters', () => {
    for (const bad of ['..', '.', 'a/b', 'a\\b', 'a b', 'a#b', '']) {
      expect(() => assertDocumentId(bad)).toThrow(/invalid document id/);
    }
  });
});
