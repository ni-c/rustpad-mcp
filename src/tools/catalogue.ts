/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `RUSTPAD_ALLOW_TOOLS=append_to_document` report
 * "unknown tool" under `RUSTPAD_READ_ONLY=true`, which is the one answer that
 * is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set.
 */

/** Registered always. Every one carries `readOnlyHint: true`. */
export const READ_TOOLS = [
  'get_document',
  'get_document_info',
  'get_stats',
] as const;

/** Registered unless `RUSTPAD_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  'append_to_document',
  'create_document',
  'replace_in_document',
  'set_document',
  'set_language',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `RUSTPAD_ALLOW_TOOLS=essential` selects: read a pad, write a pad.
 *
 * 5 of 8. Left out on purpose: `replace_in_document`, whose search-and-replace semantics `set_document`
 * and `append_to_document` already cover, plus the cosmetic and diagnostic tools.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'get_document',
  'get_document_info',
  'create_document',
  'set_document',
  'append_to_document',
];
