import { describe, expect, it } from 'vitest';

import { cleanText, describeValue } from '../src/text.js';

// Built at runtime rather than spelled: an editing tool that turns an escape
// into the character it names would put the raw byte into this file.
const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x85);
const HIGH = String.fromCharCode(0xd83d);
const REPLACEMENT = String.fromCodePoint(0xfffd);

describe('cleanText', () => {
  it('removes C0, C1 and DEL but keeps tab, newline and carriage return', () => {
    expect(cleanText(`a${ESC}[31mb${NUL}c${DEL}d${C1}e\tf\ng\r`)).toBe(
      'a[31mbcde\tf\ng\r'
    );
  });

  it('keeps format characters, which are content in most of the world', () => {
    const rlm = String.fromCodePoint(0x200f);
    const zwj = String.fromCodePoint(0x200d);
    expect(cleanText(`a${rlm}b${zwj}c`)).toBe(`a${rlm}b${zwj}c`);
  });

  it('replaces a lone surrogate, including one its own cut produced', () => {
    expect(cleanText(`x${HIGH}y`)).toBe(`x${REPLACEMENT}y`);
    // Ten code units: nine of text, then the high half of an emoji.
    const cut = cleanText(`123456789😀`, 10);
    expect(cut.isWellFormed()).toBe(true);
    expect(cut).toBe(`123456789${REPLACEMENT}`);
  });

  it('cuts after cleaning, so a control character cannot hide past the cut', () => {
    expect(cleanText(`${ESC}${ESC}${ESC}abc`, 3)).toBe('abc');
  });
});

describe('describeValue', () => {
  it('quotes a short printable value and describes everything else', () => {
    expect(describeValue('off')).toBe('"off"');
    expect(describeValue(undefined)).toBe('nothing');
    expect(describeValue('x'.repeat(21))).toBe('a 21-character value');
    expect(describeValue('two words')).toBe('a 9-character value');
    expect(describeValue(`a${ESC}b`)).toBe('a 3-character value');
  });
});
