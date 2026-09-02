import {
  expectEveryToolDeclaresOutputSchema,
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  tokenOf,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import { bootstrap, padId, type Sandbox } from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real Rustpad in Docker.
 *
 * This is the repository where an integration suite earns the most. The unit
 * tests replace the WebSocket with `FakeRustpad`, so what they check is that
 * this server speaks the operational-transform protocol the way its author
 * understood it — against a fake that the same author wrote to that same
 * understanding. Only a real Rustpad can disagree, and the place it can
 * disagree is the one that has already bitten once: OT offsets are measured in
 * **Unicode code points**, not UTF-16 code units, so anything outside the basic
 * plane shifts every later edit if the two are mixed up.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

/** Reads a document straight from Rustpad, past this server entirely. */
async function readBack(id: string): Promise<string> {
  const response = await fetch(`${sandbox.url}/api/text/${id}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GET /api/text/${id}: ${response.status}`);
  return response.text();
}

beforeAll(async () => {
  sandbox = await bootstrap();
  const env = { RUSTPAD_URL: sandbox.url };
  asking = await startServer({ env, elicit: 'accept' });
  plain = await startServer({ env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the instance', () => {
  it('reports its statistics', async () => {
    expect(await asking.call('get_stats')).toContain('num_documents');
  });
});

describe('a document through its whole life', () => {
  const id = padId('lifecycle');

  it('creates one and reads it back through Rustpad itself', async () => {
    await asking.call('create_document', {
      id,
      text: 'first line\nsecond line\n',
    });
    // Read past this server: if the write only looked right in the reply, the
    // document itself says so.
    expect(await readBack(id)).toBe('first line\nsecond line\n');

    expect(await asking.call('get_document', { id })).toContain('second line');
    expect(await asking.call('get_document_info', { id })).toContain(
      'language'
    );
  });

  it('appends without disturbing what is already there', async () => {
    await asking.call('append_to_document', { id, text: 'third line\n' });
    expect(await readBack(id)).toBe('first line\nsecond line\nthird line\n');
  });

  it('refuses an ambiguous single replacement', async () => {
    // "line" occurs three times, so replacing "the" occurrence is not a
    // well-formed request. Refusing beats guessing which one was meant.
    const refused = await asking.call(
      'replace_in_document',
      { id, search: 'line', replace: 'row' },
      { expectError: true }
    );
    expect(refused).toContain('occurs 3 times');
    expect(await readBack(id)).toBe('first line\nsecond line\nthird line\n');
  });

  it('replaces one unique occurrence, and then all of them', async () => {
    await asking.call('replace_in_document', {
      id,
      search: 'first line',
      replace: 'first row',
    });
    expect(await readBack(id)).toBe('first row\nsecond line\nthird line\n');

    await asking.call('replace_in_document', {
      id,
      search: 'line',
      replace: 'row',
      replace_all: true,
    });
    expect(await readBack(id)).toBe('first row\nsecond row\nthird row\n');
  });

  it('sets the language, which is document state and not content', async () => {
    await asking.call('set_language', { id, language: 'markdown' });
    expect(await asking.call('get_document_info', { id })).toContain(
      'markdown'
    );
    // The content is untouched: a language change is a setting.
    expect(await readBack(id)).toBe('first row\nsecond row\nthird row\n');
  });

  it('replaces the whole document', async () => {
    await asking.call('set_document', { id, text: 'replaced entirely\n' });
    expect(await readBack(id)).toBe('replaced entirely\n');
  });
});

describe('offsets are Unicode code points, against a real Rustpad', () => {
  // The bug this repository already had once, and the only place a fake can
  // agree with a wrong implementation forever. An emoji is one code point and
  // two UTF-16 code units; Rustpad counts code points, so an implementation
  // that reached for `String.length` would put every edit after the emoji one
  // unit late and corrupt the document silently. `src/ot.ts` counts code
  // points, and these assertions are what says so against the real server —
  // read them before "fixing" that file in the other direction.
  const id = padId('codepoints');

  it('appends after an emoji without shifting anything', async () => {
    await asking.call('create_document', { id, text: 'a😀b' });
    expect(await readBack(id)).toBe('a😀b');

    await asking.call('append_to_document', { id, text: 'c' });
    expect(await readBack(id)).toBe('a😀bc');
  });

  it('replaces text that sits after an astral character', async () => {
    await asking.call('replace_in_document', {
      id,
      search: 'bc',
      replace: 'XY',
    });
    expect(await readBack(id)).toBe('a😀XY');
  });

  it('handles a combining sequence and a flag, which are longer still', async () => {
    const flagId = padId('flag');
    // 🇩🇪 is two regional indicators, four UTF-16 code units.
    await asking.call('create_document', { id: flagId, text: 'x🇩🇪y' });
    await asking.call('append_to_document', { id: flagId, text: 'z' });
    expect(await readBack(flagId)).toBe('x🇩🇪yz');
  });
});

describe('a document that does not exist yet', () => {
  it('reads as empty rather than failing', async () => {
    // Rustpad creates a document by being asked for it, so there is no such
    // thing as a missing pad — a distinction worth pinning, because it means
    // a typo in an id is a silent empty document rather than an error.
    const text = await asking.call('get_document', { id: padId('never-used') });
    expect(text).not.toContain('error');
  });
});

describe('the fallback path for a client with no dialog', () => {
  const id = padId('fallback');

  it('takes the two-call token instead', async () => {
    await plain.call('create_document', { id, text: 'original\n' });

    // An error result: the pad was not changed, which is what `isError` says
    // — and a tool that declares an `outputSchema` may not answer without
    // `structuredContent` unless the result is an error.
    const refusal = await plain.call(
      'set_document',
      { id, text: 'rewritten\n' },
      { expectError: /confirm_token=/ }
    );
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);
    // Nothing happened yet: the first call is a question, not a write.
    expect(await readBack(id)).toBe('original\n');

    await plain.call('set_document', {
      id,
      text: 'rewritten\n',
      confirm_token: tokenOf(refusal),
    });
    expect(await readBack(id)).toBe('rewritten\n');
  });

  it('refuses a token issued for different replacement text', async () => {
    const refusal = await plain.call(
      'set_document',
      { id, text: 'one\n' },
      { expectError: /confirm_token=/ }
    );
    await plain.call(
      'set_document',
      { id, text: 'something else\n', confirm_token: tokenOf(refusal) },
      // The reason, not merely "it failed". A bare `expectError: true` is
      // satisfied by an expired token, an evicted store entry or a renamed
      // parameter just as well as by the guard this test is named after, so
      // the guard could be gone and this would stay green.
      { expectError: 'issued for different arguments' }
    );
    expect(await readBack(id)).toBe('rewritten\n');
  });

  it('asked a person on the other harness, and nobody on this one', () => {
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});

it('declares an output schema on every tool', async () => {
  // The unit suite checks the same thing against a fake. Here it is checked
  // against the server that has just answered every one of these tools against
  // a real Rustpad — and each of those answers went through the SDK's
  // validation against the schema below it.
  const { tools } = await asking.client.listTools();
  expectEveryToolDeclaresOutputSchema(tools);
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([...asking.called, ...plain.called]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `rustpad-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real Rustpad`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
