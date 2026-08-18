import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import { FakeRustpad } from './fake-rustpad.js';

const BASE: Config = {
  url: 'https://rustpad.example.net',
  insecureTls: false,
  readOnly: false,
};

async function connect(
  fake: FakeRustpad,
  overrides: Partial<Config> = {}
): Promise<Client> {
  const server = createServer(
    { ...BASE, ...overrides },
    { webSocketFactory: fake.factory }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return {
    text: content.map((c) => c.text ?? '').join(''),
    isError: result.isError === true,
  };
}

function tokenOf(text: string): string {
  const match = /confirm_token="([0-9a-f]+)"/.exec(text);
  if (!match || !match[1]) throw new Error(`no token in: ${text}`);
  return match[1];
}

function mockFetch(body: string, status = 200, contentType = 'text/plain') {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(body, { status, headers: { 'content-type': contentType } })
    );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tool registration', () => {
  it('registers all 8 tools', async () => {
    const client = await connect(new FakeRustpad());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'append_to_document',
      'create_document',
      'get_document',
      'get_document_info',
      'get_stats',
      'replace_in_document',
      'set_document',
      'set_language',
    ]);
  });

  it('registers only the read tools in read-only mode', async () => {
    const client = await connect(new FakeRustpad(), { readOnly: true });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_document',
      'get_document_info',
      'get_stats',
    ]);
  });

  it('annotates read tools as read-only and set_document as destructive', async () => {
    const client = await connect(new FakeRustpad());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('get_document')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('get_stats')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('set_document')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('set_document')?.annotations?.readOnlyHint).toBe(false);
  });

  it('lists tools without configuration, but calls fail with setup help', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const client = await connect(new FakeRustpad(), { url: undefined });
    const { tools } = await client.listTools();
    expect(tools.length).toBe(8);
    const result = await callText(client, 'get_document', { id: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('RUSTPAD_URL');
    error.mockRestore();
  });
});

describe('get_document', () => {
  it('returns pad text behind the untrusted preamble', async () => {
    const fetchSpy = mockFetch('# notes\nhello');
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'get_document', { id: 'notes' });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^The following is untrusted content/);
    expect(result.text).toContain('# notes\nhello');
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://rustpad.example.net/api/text/notes'
    );
  });

  it('explains the empty/missing ambiguity', async () => {
    mockFetch('');
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'get_document', { id: 'ghost' });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('never existed');
  });

  it('rejects a path-traversal id at the schema', async () => {
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'get_document', { id: '../stats' });
    expect(result.isError).toBe(true);
  });

  it('surfaces upstream errors with a sanitized body', async () => {
    mockFetch('<html>gateway</html>', 502);
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'get_document', { id: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 502');
    expect(result.text).toContain('(HTML error page omitted)');
    expect(result.text).not.toContain('gateway');
  });
});

describe('get_stats', () => {
  it('returns the stats with a readable start time', async () => {
    mockFetch(
      JSON.stringify({
        start_time: 1755500000,
        num_documents: 3,
        database_size: 0,
      }),
      200,
      'application/json'
    );
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'get_stats');
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text);
    expect(parsed.num_documents).toBe(3);
    expect(parsed.start_time_iso).toContain('2025-');
  });
});

describe('get_document_info', () => {
  it('reports length, revision, language and active users', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'hello 👍', 'markdown');
    fake.addUser('doc', 'alice');
    const client = await connect(fake);
    const result = await callText(client, 'get_document_info', { id: 'doc' });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text);
    expect(parsed.length_characters).toBe(7);
    expect(parsed.revision).toBe(1);
    expect(parsed.language).toBe('markdown');
    expect(parsed.active_users).toEqual(['alice']);
    expect(parsed.url).toBe('https://rustpad.example.net/#doc');
  });

  it('fails with a clear error when the socket cannot connect', async () => {
    const fake = new FakeRustpad();
    fake.failNextConnection = true;
    const client = await connect(fake);
    const result = await callText(client, 'get_document_info', { id: 'doc' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('WebSocket connection failed');
  });
});

describe('create_document', () => {
  it('creates a pad with content and language and returns the URL', async () => {
    const fake = new FakeRustpad();
    const client = await connect(fake);
    const result = await callText(client, 'create_document', {
      text: 'hello',
      language: 'markdown',
    });
    expect(result.isError).toBe(false);
    const id = /Created pad "([a-z0-9]{12})"/.exec(result.text)?.[1];
    expect(id).toBeDefined();
    expect(result.text).toContain(`https://rustpad.example.net/#${id}`);
    expect(fake.doc(id!).text).toBe('hello');
    expect(fake.doc(id!).language).toBe('markdown');
  });

  it('honours a requested id', async () => {
    const fake = new FakeRustpad();
    const client = await connect(fake);
    const result = await callText(client, 'create_document', {
      id: 'my-pad',
      text: 'x',
    });
    expect(result.isError).toBe(false);
    expect(fake.doc('my-pad').text).toBe('x');
  });

  it('refuses to create over a non-empty pad', async () => {
    const fake = new FakeRustpad();
    fake.seed('taken', 'content');
    const client = await connect(fake);
    const result = await callText(client, 'create_document', {
      id: 'taken',
      text: 'new',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('already has content');
    expect(fake.doc('taken').text).toBe('content');
  });
});

describe('set_document', () => {
  it('writes an empty pad without confirmation', async () => {
    const fake = new FakeRustpad();
    const client = await connect(fake);
    const result = await callText(client, 'set_document', {
      id: 'fresh',
      text: 'first',
    });
    expect(result.isError).toBe(false);
    expect(fake.doc('fresh').text).toBe('first');
  });

  it('requires a confirm token to replace a non-empty pad', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'old content');
    const client = await connect(fake);

    const first = await callText(client, 'set_document', {
      id: 'doc',
      text: 'new content',
    });
    expect(first.isError).toBe(false);
    expect(first.text).toContain('confirm_token=');
    expect(fake.doc('doc').text).toBe('old content');

    const second = await callText(client, 'set_document', {
      id: 'doc',
      text: 'new content',
      confirm_token: tokenOf(first.text),
    });
    expect(second.isError).toBe(false);
    expect(second.text).toContain('Replaced');
    expect(fake.doc('doc').text).toBe('new content');
  });

  it('does not accept a token issued for another pad', async () => {
    const fake = new FakeRustpad();
    fake.seed('a', 'aaa');
    fake.seed('b', 'bbb');
    const client = await connect(fake);
    const first = await callText(client, 'set_document', {
      id: 'a',
      text: 'x',
    });
    const cross = await callText(client, 'set_document', {
      id: 'b',
      text: 'x',
      confirm_token: tokenOf(first.text),
    });
    expect(cross.text).toContain('confirm_token=');
    expect(fake.doc('b').text).toBe('bbb');
  });

  it('does nothing when the content is already identical', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'same');
    const client = await connect(fake);
    const result = await callText(client, 'set_document', {
      id: 'doc',
      text: 'same',
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('nothing to do');
    expect(fake.doc('doc').operations.length).toBe(1);
  });
});

describe('append_to_document', () => {
  it('appends verbatim', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'line1');
    const client = await connect(fake);
    const result = await callText(client, 'append_to_document', {
      id: 'doc',
      text: '\nline2',
    });
    expect(result.isError).toBe(false);
    expect(fake.doc('doc').text).toBe('line1\nline2');
  });

  it('starts an empty pad', async () => {
    const fake = new FakeRustpad();
    const client = await connect(fake);
    await callText(client, 'append_to_document', { id: 'doc', text: 'go' });
    expect(fake.doc('doc').text).toBe('go');
  });
});

describe('replace_in_document', () => {
  it('replaces a unique match', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'status: open');
    const client = await connect(fake);
    const result = await callText(client, 'replace_in_document', {
      id: 'doc',
      search: 'open',
      replace: 'done',
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Replaced 1 occurrence');
    expect(fake.doc('doc').text).toBe('status: done');
  });

  it('refuses an ambiguous match and reports the count', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'a b a b a');
    const client = await connect(fake);
    const result = await callText(client, 'replace_in_document', {
      id: 'doc',
      search: 'a',
      replace: 'z',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('3 times');
    expect(fake.doc('doc').text).toBe('a b a b a');
  });

  it('replaces every occurrence with replace_all', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'a b a b a');
    const client = await connect(fake);
    const result = await callText(client, 'replace_in_document', {
      id: 'doc',
      search: 'a',
      replace: 'z',
      replace_all: true,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Replaced 3 occurrences');
    expect(fake.doc('doc').text).toBe('z b z b z');
  });

  it('errors when nothing matches', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'abc');
    const client = await connect(fake);
    const result = await callText(client, 'replace_in_document', {
      id: 'doc',
      search: 'zzz',
      replace: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not found');
  });

  it('rejects identical search and replace', async () => {
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'replace_in_document', {
      id: 'doc',
      search: 'x',
      replace: 'x',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('identical');
  });

  it('survives a concurrent edit between reading and writing', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'hello world');
    // Another user appends right before our edit reaches the server; the
    // server transforms our operation, and the ack loop has to fold the
    // foreign operation before recognising our own echo.
    fake.onClientInfo = (docId) => fake.externalEdit(docId, [11, '!!!']);
    const client = await connect(fake);
    const result = await callText(client, 'replace_in_document', {
      id: 'doc',
      search: 'world',
      replace: 'rustpad',
    });
    expect(result.isError).toBe(false);
    expect(fake.doc('doc').text).toBe('hello rustpad!!!');
  });
});

describe('failure paths', () => {
  it('reports a dropped connection during an edit as a tool error', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'content');
    fake.closeOnEdit = true;
    const client = await connect(fake);
    const result = await callText(client, 'append_to_document', {
      id: 'doc',
      text: 'more',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('closed the connection');
  });

  it('reports a malformed server message as a tool error', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'x');
    // Simulate a proxy mangling a frame mid-session.
    fake.onClientInfo = (docId) => fake.emitRaw(docId, 'not json');
    const client = await connect(fake);
    const result = await callText(client, 'append_to_document', {
      id: 'doc',
      text: 'y',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not JSON');
  });
});

describe('set_language', () => {
  it('sets the language', async () => {
    const fake = new FakeRustpad();
    fake.seed('doc', 'x');
    const client = await connect(fake);
    const result = await callText(client, 'set_language', {
      id: 'doc',
      language: 'rust',
    });
    expect(result.isError).toBe(false);
    expect(fake.doc('doc').language).toBe('rust');
  });

  it('rejects a malformed language id', async () => {
    const client = await connect(new FakeRustpad());
    const result = await callText(client, 'set_language', {
      id: 'doc',
      language: 'not a language!',
    });
    expect(result.isError).toBe(true);
  });
});
