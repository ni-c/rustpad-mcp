import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  applyOperation,
  appendOps,
  codepointLength,
  replaceOps,
  searchReplaceOps,
} from '../src/ot.js';

/**
 * Properties of the operational-transformation write path.
 *
 * The module header states the trap this exists around: every index counts
 * Unicode code points, not UTF-16 units — `"👍".length` is 2 and Rustpad sees
 * one — and mixing the two corrupts every position after the first astral
 * character. That is a whole-document corruption reached by one emoji in
 * somebody's note, which is exactly the kind of input an example test does not
 * think to include and a generator produces constantly.
 *
 * The properties are stated as round trips through `applyOperation`, because
 * that is the question that matters: does the operation this server sends
 * produce the document it promised?
 */

const RUNS = { numRuns: 500 };

/** Text that mixes plain, accented and astral characters. */
const text = fc
  .array(
    fc.oneof(
      fc.stringMatching(/^[a-z ]{0,8}$/),
      fc.constantFrom('ä', 'é', '👍', '🇩🇪', '👨‍👩‍👧', '𝔘', '\n', '\t')
    ),
    { maxLength: 25 }
  )
  .map((parts) => parts.join(''));

describe('code points are counted, not UTF-16 units', () => {
  it('agrees with spreading the string', () => {
    fc.assert(
      fc.property(text, (value) => {
        expect(codepointLength(value)).toBe([...value].length);
      }),
      RUNS
    );
  });

  /**
   * The distinction is only visible above the basic plane, which is why it has
   * to be generated rather than assumed: for anything that fits in one UTF-16
   * unit the two counts agree, and a test built from such text would pass
   * against a wrong implementation.
   */
  it('counts an astral character once, where .length counts two', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (count) => {
        const astral = '👍'.repeat(count);
        expect(codepointLength(astral)).toBe(count);
        expect(astral.length).toBe(count * 2);
      }),
      RUNS
    );
  });
});

describe('an operation produces the document it promised', () => {
  /**
   * The round trip that makes the whole module trustworthy: what
   * `replaceOps` builds, applied to the base document, is the requested text.
   */
  it('replaceOps rewrites the document to exactly the new text', () => {
    fc.assert(
      fc.property(text, text, (before, after) => {
        const ops = replaceOps(codepointLength(before), after);
        if (ops === undefined) {
          expect(before).toBe('');
          expect(after).toBe('');
          return;
        }
        expect(applyOperation(before, ops)).toBe(after);
      }),
      RUNS
    );
  });

  it('appendOps adds to the end and leaves the rest byte-identical', () => {
    fc.assert(
      fc.property(text, text, (before, addition) => {
        const ops = appendOps(codepointLength(before), addition);
        if (ops === undefined) {
          expect(addition).toBe('');
          return;
        }
        expect(applyOperation(before, ops)).toBe(`${before}${addition}`);
      }),
      RUNS
    );
  });

  /**
   * Search and replace goes through OT rather than rewriting the document, so
   * that a concurrent edit elsewhere in the pad survives. That only holds if
   * the operation retains everything it did not match — which is what a round
   * trip against the plain string replacement checks.
   */
  it('searchReplaceOps matches a literal replacement, and counts what it did', () => {
    fc.assert(
      fc.property(
        text,
        fc.stringMatching(/^[a-z]{1,4}$/),
        fc.stringMatching(/^[a-zé\u{1f44d}]{0,5}$/u),
        (document, search, replacement) => {
          const { ops, count } = searchReplaceOps(
            document,
            search,
            replacement,
            true
          );
          const expected = document.split(search).join(replacement);
          expect(count).toBe(document.split(search).length - 1);
          if (ops === undefined) {
            expect(expected).toBe(document);
          } else {
            expect(applyOperation(document, ops)).toBe(expected);
          }
        }
      ),
      RUNS
    );
  });

  /**
   * Without `all`, an ambiguous search changes nothing.
   *
   * The count still comes back, so the caller can say "that matched four
   * times" rather than silently rewriting three places nobody looked at. This
   * is the safety rule of the tool, and it is only visible on a document where
   * the search occurs more than once — which a generator produces and a chosen
   * example usually does not.
   */
  it('refuses to guess when a single-match replace finds several', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,3}$/),
        fc.integer({ min: 2, max: 6 }),
        fc.stringMatching(/^[a-z]{0,4}$/),
        (search, times, replacement) => {
          const document = `x${search}`.repeat(times);
          const { ops, count } = searchReplaceOps(
            document,
            search,
            replacement,
            false
          );
          expect(count).toBeGreaterThan(1);
          expect(ops).toBeUndefined();
        }
      ),
      RUNS
    );
  });

  /**
   * An astral character in the *document* is where a UTF-16 count would go
   * wrong first, and where the damage is silent: every position after it
   * shifts, so the edit lands in the middle of unrelated text.
   */
  it('holds when the document is astral characters throughout', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.stringMatching(/^[a-z]{0,10}$/),
        (count, addition) => {
          const document = '👍'.repeat(count);
          const ops = appendOps(codepointLength(document), addition);
          if (ops === undefined) return;
          expect(applyOperation(document, ops)).toBe(`${document}${addition}`);
        }
      ),
      RUNS
    );
  });
});

describe('a malformed operation is refused rather than applied', () => {
  /**
   * `applyOperation` folds the server's history into the local view, so a
   * mismatch means the view has diverged. Failing loudly is the point — writing
   * on top of the wrong base is how a pad loses somebody's paragraph.
   */
  it('refuses an operation that does not cover the whole document', () => {
    fc.assert(
      fc.property(
        text.filter((value) => value.length > 0),
        fc.integer({ min: 1, max: 5 }),
        (document, short) => {
          const length = codepointLength(document);
          fc.pre(length > short);
          expect(() => applyOperation(document, [length - short])).toThrow(
            /covers/
          );
        }
      ),
      RUNS
    );
  });

  it('refuses to retain or delete past the end', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 1, max: 10 }), (document, extra) => {
        const length = codepointLength(document);
        expect(() => applyOperation(document, [length + extra])).toThrow(
          /past the end/
        );
        expect(() => applyOperation(document, [-(length + extra)])).toThrow(
          /past the end/
        );
      }),
      RUNS
    );
  });

  it('refuses a zero-length component', () => {
    fc.assert(
      fc.property(text, (document) => {
        expect(() => applyOperation(document, [0])).toThrow(/zero-length/);
      }),
      RUNS
    );
  });
});
