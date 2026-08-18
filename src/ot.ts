/**
 * Operational-transformation primitives for Rustpad's wire format.
 *
 * An operation is a flat array walked over the whole document: a positive
 * number retains that many characters, a string inserts it, a negative number
 * deletes that many characters. The retained/deleted counts MUST cover the
 * entire base document, and every index counts Unicode code points — not
 * UTF-16 units. `"👍".length` is 2, but Rustpad sees one character; mixing
 * the two corrupts every position after the first astral character.
 */
export type Op = number | string;

/**
 * Rustpad rejects any edit whose resulting document exceeds this many
 * characters (`apply_edit` in rustpad-server). Checked here first so the
 * caller gets a readable error instead of a dropped connection.
 */
export const MAX_DOCUMENT_CODEPOINTS = 256 * 1024;

/** The number of Unicode code points in a string. */
export function codepointLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    length++;
    // Surrogate pair: one code point spans two UTF-16 units.
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) i++;
  }
  return length;
}

/**
 * Applies one operation to a document. Used to fold the server's History
 * messages into the current text, so a mismatch here means the local view has
 * diverged — better to fail loudly than to write on top of the wrong base.
 */
export function applyOperation(text: string, ops: readonly Op[]): string {
  const chars = [...text];
  const result: string[] = [];
  let index = 0;

  for (const op of ops) {
    if (typeof op === 'string') {
      result.push(op);
    } else if (op > 0) {
      if (index + op > chars.length) {
        throw new Error('operation retains past the end of the document');
      }
      result.push(chars.slice(index, index + op).join(''));
      index += op;
    } else if (op < 0) {
      if (index - op > chars.length) {
        throw new Error('operation deletes past the end of the document');
      }
      index -= op;
    } else {
      throw new Error('operation contains a zero-length component');
    }
  }
  if (index !== chars.length) {
    throw new Error(
      `operation covers ${index} characters but the document has ${chars.length}`
    );
  }
  return result.join('');
}

function assertTargetLength(length: number): void {
  if (length > MAX_DOCUMENT_CODEPOINTS) {
    throw new Error(
      `the resulting document would be ${length} characters, more than Rustpad's ${MAX_DOCUMENT_CODEPOINTS} character limit`
    );
  }
}

/** Replaces the whole document. Returns `undefined` for a no-op. */
export function replaceOps(oldLength: number, text: string): Op[] | undefined {
  assertTargetLength(codepointLength(text));
  const ops: Op[] = [];
  if (oldLength > 0) ops.push(-oldLength);
  if (text.length > 0) ops.push(text);
  return ops.length > 0 ? ops : undefined;
}

/** Appends to the end of the document. Returns `undefined` for a no-op. */
export function appendOps(oldLength: number, text: string): Op[] | undefined {
  if (text.length === 0) return undefined;
  assertTargetLength(oldLength + codepointLength(text));
  const ops: Op[] = [];
  if (oldLength > 0) ops.push(oldLength);
  ops.push(text);
  return ops;
}

export interface SearchReplaceResult {
  ops: Op[] | undefined;
  count: number;
}

/**
 * Builds the operation that replaces occurrences of `search` in `text`.
 *
 * Matches are literal and non-overlapping. Only the matched ranges are
 * deleted and re-inserted; everything else is retained, which is what lets a
 * concurrent edit elsewhere in the pad survive untouched — the whole point of
 * going through OT instead of rewriting the document.
 */
export function searchReplaceOps(
  text: string,
  search: string,
  replace: string,
  all: boolean
): SearchReplaceResult {
  if (search.length === 0) {
    throw new Error('search must not be empty');
  }

  // Match on the UTF-16 string (indexOf), emit op lengths in code points.
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(search, from);
    if (at === -1) break;
    positions.push(at);
    from = at + search.length;
  }

  if (positions.length === 0 || (!all && positions.length !== 1)) {
    return { ops: undefined, count: positions.length };
  }

  const searchCp = codepointLength(search);
  const ops: Op[] = [];
  let cursor = 0;
  for (const at of positions) {
    const gap = codepointLength(text.slice(cursor, at));
    if (gap > 0) ops.push(gap);
    ops.push(-searchCp);
    if (replace.length > 0) ops.push(replace);
    cursor = at + search.length;
  }
  const tail = codepointLength(text.slice(cursor));
  if (tail > 0) ops.push(tail);

  assertTargetLength(
    codepointLength(text) +
      positions.length * (codepointLength(replace) - searchCp)
  );
  // Invariant check before anything is sent: a match that splits a surrogate
  // pair (or any future indexing bug) would produce an operation the server
  // rejects by dropping the connection — fail here with a real error instead.
  applyOperation(text, ops);
  return { ops, count: positions.length };
}
