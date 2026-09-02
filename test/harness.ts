import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';
import type { FakeRustpad } from './fake-rustpad.js';

/**
 * What the test files used to keep their own copies of.
 *
 * `tools.test.ts` and `tool-filter.test.ts` each built a `Config` literal, and
 * the one in `tool-filter.test.ts` had no `elicitation` field — not optional
 * since the human-in-the-loop pass, and unnoticed because `tsconfig.json`
 * covers `src` and not `test`.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: 'https://rustpad.example.net',
    insecureTls: false,
    readOnly: false,
    elicitation: true,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

/** How a client that can show a dialog answers it. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel';

/**
 * Connects a client to the real server.
 *
 * The fake stands in for Rustpad's WebSocket and is per-connection, which is
 * why it comes first rather than through a global stub. Pass `undefined` where
 * no tool will actually open a document.
 *
 * Without `elicit` the client declares no elicitation capability, which is the
 * case the two-call token exists for. With it, the client answers the dialog —
 * and `prompts` records every message the server put in front of the user, so
 * a test can assert what was shown as well as what was decided.
 */
export async function connect(
  fake: FakeRustpad | undefined,
  overrides: Partial<Config> = {},
  elicit?: ElicitBehaviour
): Promise<Client & { prompts: string[] }> {
  const server = createServer(
    testConfig(overrides),
    fake === undefined ? {} : { webSocketFactory: fake.factory }
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const prompts: string[] = [];
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (elicit === 'cancel') return { action: 'cancel' };
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return Object.assign(client, { prompts });
}

/** The tools a server built with this configuration actually offers. */
export async function toolNames(
  overrides: Partial<Config> = {}
): Promise<string[]> {
  vi.stubGlobal('fetch', vi.fn());
  const client = await connect(undefined, overrides);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name).sort();
}

export async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean; structured: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return {
    text: content.map((part) => part.text ?? '').join(''),
    isError: result.isError === true,
    // Every tool declares an `outputSchema`, so every successful answer carries
    // this — and the SDK has already validated it against that schema by the
    // time it arrives here.
    structured: result.structuredContent,
  };
}

/** The confirmation token a guarded tool handed back on its first call. */
export function tokenOf(text: string): string {
  const match = /confirm_token="([0-9a-f]+)"/.exec(text);
  if (!match?.[1]) {
    throw new Error(
      `no confirm_token in the result — did the client declare elicitation? ` +
        `Got: ${text.slice(0, 300)}`
    );
  }
  return match[1];
}

/**
 * Runs a guarded tool through both halves of its two-call token.
 *
 * Takes the client rather than living on what `connect` returns, so the
 * signature matches every other repository in this family. Only meaningful on
 * a client that declared no elicitation: with a dialog available the server
 * asks instead of offering a token, which is the point of the dialog.
 */
export async function confirmed(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean }> {
  const first = await callText(client, name, args);
  return callText(client, name, {
    ...args,
    confirm_token: tokenOf(first.text),
  });
}

export function mockFetch(
  body: string,
  status = 200,
  contentType = 'text/plain'
) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(body, { status, headers: { 'content-type': contentType } })
    );
}
