/**
 * What this repository still has to prove about its tool filter.
 *
 * The filter lives in `mcp-tool-allowlist` and is tested there: pattern syntax,
 * the preset, how a rejected entry is quoted back, the shape of every message.
 * Repeating that here would test the dependency.
 *
 * What only this repository can assert is the wiring — that the catalogue names
 * exactly the tools the server registers, that the messages name *these*
 * variables, that the gate hangs off `RUSTPAD_READ_ONLY`, and that a filtered
 * tool is really gone rather than merely hidden.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';

import { createServer } from '../src/server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';
import { connect, testConfig, toolNames } from './harness.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the catalogue', () => {
  // These are what let the filter validate a name before anything is
  // registered. If they drift from the code, every error message drifts too.
  it('is exactly the set of tools the server registers', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });

  it('splits into read and write with nothing left over', async () => {
    expect([...READ_TOOLS, ...WRITE_TOOLS].sort()).toEqual(
      [...ALL_TOOLS].sort()
    );
    expect(
      READ_TOOLS.filter((t) => (WRITE_TOOLS as readonly string[]).includes(t))
    ).toEqual([]);
    expect(await toolNames({ readOnly: true })).toEqual([...READ_TOOLS].sort());
  });

  it('holds names the env-var syntax cannot misread', () => {
    // A comma or an asterisk in a name would break the separator or the
    // pattern; a tool called "essential" would be unreachable behind the preset.
    for (const tool of ALL_TOOLS) {
      expect(tool).toMatch(/^[a-z0-9_]+$/);
    }
    expect(ALL_TOOLS).not.toContain('essential');
  });

  it('has an essential preset that is a real, sensibly sized subset', () => {
    expect(new Set(ESSENTIAL_TOOLS).size).toBe(ESSENTIAL_TOOLS.length);
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
    for (const tool of ESSENTIAL_TOOLS) expect(ALL_TOOLS).toContain(tool);
  });
});

describe('selecting tools', () => {
  it('narrows tools/list to an allow list', async () => {
    expect(
      await toolNames({ allowTools: 'get_document,get_document_info' })
    ).toEqual(['get_document', 'get_document_info'].sort());
  });

  it('removes a whole family with a prefix pattern', async () => {
    const names = await toolNames({ denyTools: 'get_*' });
    expect(names.some((n) => n.startsWith('get_'))).toBe(false);
    expect(names).toHaveLength(
      ALL_TOOLS.length - ALL_TOOLS.filter((t) => t.startsWith('get_')).length
    );
  });

  it('subtracts the deny list from the allow list', async () => {
    expect(
      await toolNames({
        allowTools: 'get_document,get_document_info',
        denyTools: 'get_document_info',
      })
    ).toEqual(['get_document']);
  });

  it('selects the curated set for "essential"', async () => {
    expect(await toolNames({ allowTools: 'essential' })).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  it('lets the preset compose with extra names', async () => {
    expect(await toolNames({ allowTools: 'essential,get_stats' })).toEqual(
      [...ESSENTIAL_TOOLS, 'get_stats'].sort()
    );
  });

  it('leaves an unconfigured server untouched', async () => {
    expect(await toolNames()).toEqual([...ALL_TOOLS].sort());
  });
});

describe('a filtered-out tool', () => {
  it('cannot be called either, not merely hidden', async () => {
    // This is the difference between removing the tool and disabling it: a
    // disabled tool still answers a call, which advertises a refusal.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response('{}', {
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    const client = await connect(undefined, { allowTools: 'get_document' });

    // SDK v2 reports an unknown tool as a JSON-RPC error rather than as a
    // result carrying isError. Either way the call fails and nothing reaches
    // the API, which is what this test is about.
    await expect(
      client.callTool({
        name: 'append_to_document',
        arguments: {},
      })
    ).rejects.toThrow('Tool append_to_document not found');
    expect(calls).toHaveLength(0);
  });
});

describe('refusing an unusable list', () => {
  it('rejects a name no tool has, and says which names exist', () => {
    // A typo that was merely ignored would leave a tool missing with no trace
    // of why — nobody looks for the cause of an absence in an env var.
    expect(() =>
      createServer(testConfig({ allowTools: 'get_documenz' }))
    ).toThrow(ToolFilterError);
    expect(() =>
      createServer(testConfig({ allowTools: 'get_documenz' }))
    ).toThrow(/no tool matches "get_documenz".*get_document/s);
  });

  it('applies the same rule to the deny list', () => {
    expect(() =>
      createServer(testConfig({ denyTools: 'get_documenz' }))
    ).toThrow(/_DENY_TOOLS: no tool matches "get_documenz"/);
  });

  it('rejects a list that would leave no tools at all', () => {
    expect(() => createServer(testConfig({ denyTools: '*' }))).toThrow(
      /empty tool list/
    );
  });
});

describe('together with read-only mode', () => {
  const readOnly = { readOnly: true } as const;

  it('names read-only as the reason, rather than calling the tool unknown', () => {
    // The tool exists; it is suppressed. Reporting "unknown tool" would send
    // the reader looking for a typo that is not there.
    let thrown: unknown;
    try {
      createServer(
        testConfig({ ...readOnly, allowTools: 'append_to_document' })
      );
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('_READ_ONLY');
    expect(message).not.toContain('no tool matches');
  });

  it('keeps the essential preset usable, narrowed to its read half', async () => {
    expect(await toolNames({ ...readOnly, allowTools: 'essential' })).toEqual(
      ESSENTIAL_TOOLS.filter((t) =>
        (READ_TOOLS as readonly string[]).includes(t)
      ).sort()
    );
  });

  it('does not apply the write-tool rule to the deny list', async () => {
    // Denying something already suppressed is how a defensive list is written.
    expect(
      await toolNames({ ...readOnly, denyTools: 'append_to_document' })
    ).toEqual([...READ_TOOLS].sort());
  });

  it('lets a pattern cover write tools without failing', async () => {
    // A prefix that only matches write tools is a legitimate template to hand
    // to both kinds of deployment; under read-only it contributes nothing.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await toolNames({ ...readOnly, allowTools: 'essential,append_*' })
    ).toEqual(
      ESSENTIAL_TOOLS.filter((t) =>
        (READ_TOOLS as readonly string[]).includes(t)
      ).sort()
    );
    expect(warn.mock.calls.flat().join(' ')).toContain('contributes nothing');
  });

  it('says read-only is the reason when a pattern leaves nothing at all', () => {
    // The pattern is legal and merely contributes nothing — but if it was the
    // whole allow list, the empty server needs the real explanation.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      createServer(testConfig({ ...readOnly, allowTools: 'append_*' }))
    ).toThrow(/read-only mode suppresses.*RUSTPAD_READ_ONLY is set/s);
  });
});
