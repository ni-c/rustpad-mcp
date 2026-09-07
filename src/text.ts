/**
 * Text the instance wrote, fit for a model.
 *
 * A pad, a user name and the editor language are typed by whoever has the
 * pad open, and the WebSocket frames that carry them are JSON from whatever
 * `RUSTPAD_URL` points at. Two things in such a string are not content:
 *
 * - C0 and C1 control characters and DEL. `ESC[1A` moves a terminal cursor,
 *   a NUL splits a C string, and none of them is something a person typed
 *   into a pad on purpose. Tab, LF and CR stay — a pad is lines of text.
 *   Format characters (bidi marks, joiners) stay too: they are content in
 *   text that is not English, and a model reads them as such.
 * - A lone surrogate. `"\ud800"` is legal JSON, `JSON.parse` turns it into a
 *   string no UTF-8 encoder accepts, and a client written in Python raises
 *   `UnicodeEncodeError` on the whole result. A `slice` can make one out of a
 *   well-formed string by cutting a pair in half, which is why the
 *   replacement runs after the cut.
 */

// Built from code points rather than spelled as escapes: an editing tool that
// rewrites a backslash-u escape into the character it names would put a raw ESC into this
// file, and a later search for the escape would no longer find the line.
function range(from: number, to: number): string {
  return `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
}

const CONTROL_CHARACTERS = new RegExp(
  `[${range(0x00, 0x08)}${range(0x0b, 0x0c)}${range(0x0e, 0x1f)}${range(0x7f, 0x9f)}]`,
  'g'
);

/**
 * Strips control characters, cuts at `max` UTF-16 units where given, and
 * replaces every lone surrogate with U+FFFD — in that order, so the cut cannot
 * reintroduce what the last step removes.
 */
export function cleanText(value: string, max?: number): string {
  const clean = value.replace(CONTROL_CHARACTERS, '');
  const cut =
    max !== undefined && clean.length > max ? clean.slice(0, max) : clean;
  return cut.toWellFormed();
}

/**
 * A configuration value described for a log line: quoted only when it is
 * short and printable ASCII, otherwise by its length. The variable next to a
 * secret is where a secret gets pasted, and "got '<value>'" is how it reaches
 * the log.
 */
export function describeValue(raw: string | undefined): string {
  if (raw === undefined) return 'nothing';
  if (/^[!-~]{1,20}$/.test(raw)) return `"${raw}"`;
  return `a ${raw.length}-character value`;
}
