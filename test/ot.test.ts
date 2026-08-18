import { describe, expect, it } from 'vitest';

import {
  applyOperation,
  appendOps,
  codepointLength,
  MAX_DOCUMENT_CODEPOINTS,
  replaceOps,
  searchReplaceOps,
} from '../src/ot.js';

describe('codepointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codepointLength('')).toBe(0);
    expect(codepointLength('abc')).toBe(3);
    expect(codepointLength('👍')).toBe(1);
    expect(codepointLength('a👍b')).toBe(3);
  });
});

describe('applyOperation', () => {
  it('applies retain, insert and delete', () => {
    expect(applyOperation('hello world', [6, -5, 'rustpad'])).toBe(
      'hello rustpad'
    );
  });

  it('inserts into an empty document', () => {
    expect(applyOperation('', ['hi'])).toBe('hi');
  });

  it('counts astral characters as one', () => {
    // Retain the emoji (1), delete one character, insert.
    expect(applyOperation('👍x', [1, -1, 'y'])).toBe('👍y');
  });

  it('rejects an operation that does not cover the document', () => {
    expect(() => applyOperation('abc', [2])).toThrow(/covers 2 characters/);
  });

  it('rejects an operation that retains past the end', () => {
    expect(() => applyOperation('abc', [4])).toThrow(/past the end/);
  });

  it('rejects an operation that deletes past the end', () => {
    expect(() => applyOperation('abc', [-4])).toThrow(/past the end/);
  });

  it('rejects a zero-length component', () => {
    expect(() => applyOperation('abc', [0, 3])).toThrow(/zero-length/);
  });
});

describe('replaceOps', () => {
  it('deletes the old content and inserts the new', () => {
    expect(replaceOps(3, 'new')).toEqual([-3, 'new']);
  });

  it('only inserts into an empty document', () => {
    expect(replaceOps(0, 'new')).toEqual(['new']);
  });

  it('only deletes when the new content is empty', () => {
    expect(replaceOps(3, '')).toEqual([-3]);
  });

  it('is a no-op for empty to empty', () => {
    expect(replaceOps(0, '')).toBeUndefined();
  });

  it('round-trips through applyOperation', () => {
    const ops = replaceOps(codepointLength('a👍c'), 'x👍');
    expect(applyOperation('a👍c', ops!)).toBe('x👍');
  });

  it('rejects documents above the Rustpad limit', () => {
    expect(() =>
      replaceOps(0, 'x'.repeat(MAX_DOCUMENT_CODEPOINTS + 1))
    ).toThrow(/character limit/);
  });
});

describe('appendOps', () => {
  it('retains the document and inserts at the end', () => {
    expect(appendOps(5, '!')).toEqual([5, '!']);
    expect(applyOperation('hello', appendOps(5, ' world')!)).toBe(
      'hello world'
    );
  });

  it('only inserts into an empty document', () => {
    expect(appendOps(0, 'hi')).toEqual(['hi']);
  });

  it('is a no-op for empty text', () => {
    expect(appendOps(5, '')).toBeUndefined();
  });

  it('rejects appends that push the document above the limit', () => {
    expect(() => appendOps(MAX_DOCUMENT_CODEPOINTS, 'x')).toThrow(
      /character limit/
    );
  });
});

describe('searchReplaceOps', () => {
  it('replaces a unique match and retains everything else', () => {
    const { ops, count } = searchReplaceOps(
      'hello world',
      'world',
      'pad',
      false
    );
    expect(count).toBe(1);
    expect(applyOperation('hello world', ops!)).toBe('hello pad');
  });

  it('reports zero matches without an operation', () => {
    expect(searchReplaceOps('abc', 'x', 'y', false)).toEqual({
      ops: undefined,
      count: 0,
    });
  });

  it('refuses an ambiguous match unless replace_all is set', () => {
    const single = searchReplaceOps('a a a', 'a', 'b', false);
    expect(single.ops).toBeUndefined();
    expect(single.count).toBe(3);

    const all = searchReplaceOps('a a a', 'a', 'b', true);
    expect(all.count).toBe(3);
    expect(applyOperation('a a a', all.ops!)).toBe('b b b');
  });

  it('deletes when the replacement is empty', () => {
    const { ops } = searchReplaceOps('foo-bar', '-bar', '', false);
    expect(applyOperation('foo-bar', ops!)).toBe('foo');
  });

  it('finds non-overlapping matches only', () => {
    const { count, ops } = searchReplaceOps('aaaa', 'aa', 'b', true);
    expect(count).toBe(2);
    expect(applyOperation('aaaa', ops!)).toBe('bb');
  });

  it('emits code-point lengths around astral characters', () => {
    const text = '👍👍 target 👍';
    const { ops } = searchReplaceOps(text, 'target', 'done', false);
    expect(applyOperation(text, ops!)).toBe('👍👍 done 👍');
  });

  it('replaces at the very start and very end', () => {
    const { ops } = searchReplaceOps('abcab', 'ab', 'X', true);
    expect(applyOperation('abcab', ops!)).toBe('XcX');
  });

  it('rejects an empty search string', () => {
    expect(() => searchReplaceOps('abc', '', 'x', false)).toThrow(
      /must not be empty/
    );
  });

  it('rejects replacements that push the document above the limit', () => {
    const text = 'x'.repeat(MAX_DOCUMENT_CODEPOINTS - 1);
    expect(() => searchReplaceOps(text, 'x', 'yyy', true)).toThrow(
      /character limit/
    );
  });
});
