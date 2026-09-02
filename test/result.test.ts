import { describe, expect, it } from 'vitest';

import { RustpadApiError } from '../src/api.js';
import {
  budgetedJson,
  budgetedText,
  errorResult,
  MAX_RESULT_BYTES,
  ResultTooLargeError,
  run,
  sanitizeErrorBody,
  textResult,
  ToolInputError,
  untrustedResult,
} from '../src/result.js';

// `run` answers with `CallToolResult | InputRequiredResult`, and only the
// first half carries `content`. Typing the parameter off `run` itself keeps
// both halves acceptable — a bare `{ content?: unknown }` would be a weak
// type, which an input request overlaps in no property at all — and the cast
// then says out loud that every call in this file is on the result half.
function textOf(result: Awaited<ReturnType<typeof run>>) {
  return ((result as { content?: unknown }).content as { text?: string }[])
    .map((c) => c.text ?? '')
    .join('');
}

describe('results', () => {
  it('builds plain and error results', () => {
    expect(textResult('ok').isError).toBeUndefined();
    expect(errorResult('bad').isError).toBe(true);
  });

  it('prefixes untrusted content with the preamble', () => {
    const result = untrustedResult({ text: 'pad content' });
    expect(textOf(result)).toMatch(/^The following is untrusted content/);
    expect(textOf(result)).toContain('pad content');
  });

  it('carries the warning in the structured channel too', () => {
    // A client that reads structuredContent and ignores content — which is the
    // point of declaring an output schema — would otherwise get text anyone
    // who knows the pad id could have written, with no framing at all.
    expect(untrustedResult({ text: 'pad content' }).structuredContent).toEqual({
      untrusted: true,
      source: 'rustpad',
      text: 'pad content',
    });
  });

  it('cannot have its marker turned off by the pad', () => {
    expect(
      untrustedResult({ untrusted: false, source: 'me', text: 'x' })
        .structuredContent
    ).toEqual({ untrusted: true, source: 'rustpad', text: 'x' });
  });

  it('shortens oversized pad text and says how much there was', () => {
    const { text, truncated } = budgetedText(
      'x'.repeat(MAX_RESULT_BYTES + 100)
    );
    expect(text).toHaveLength(MAX_RESULT_BYTES);
    expect(truncated).toEqual({
      shown: MAX_RESULT_BYTES,
      total: MAX_RESULT_BYTES + 100,
    });
  });

  it('keeps small JSON intact and refuses JSON that cannot fit', () => {
    expect(JSON.parse(budgetedJson({ a: 1 }))).toEqual({ a: 1 });
    // It used to answer with an envelope carrying the oversized document as a
    // string. That is valid JSON and no longer a valid *answer*: the SDK checks
    // a result against the schema its tool declares.
    expect(() => budgetedJson({ text: 'x'.repeat(MAX_RESULT_BYTES) })).toThrow(
      ResultTooLargeError
    );
  });
});

describe('sanitizeErrorBody', () => {
  it('drops markup that does not open with a doctype or <html>', () => {
    // A WAF block page can open with a comment, and an upstream that answers
    // errors in XML is exactly as useless to the model as one that answers in
    // HTML. The old check required a doctype or an <html> tag first and let
    // both of these through.
    expect(
      sanitizeErrorBody('<?xml version="1.0"?><error>denied</error>')
    ).toBe('(HTML error page omitted)');
    expect(
      sanitizeErrorBody('<!-- blocked by policy -->\n<html>x</html>')
    ).toBe('(HTML error page omitted)');
  });
  it('drops HTML error pages entirely', () => {
    expect(sanitizeErrorBody('<html><body>boom</body></html>')).toBe(
      '(HTML error page omitted)'
    );
    expect(sanitizeErrorBody('<!DOCTYPE html><p>x</p>')).toBe(
      '(HTML error page omitted)'
    );
  });

  it('truncates long bodies', () => {
    expect(sanitizeErrorBody('y'.repeat(5000))).toContain('(truncated)');
  });

  it('passes short bodies through', () => {
    expect(sanitizeErrorBody(' short ')).toBe('short');
  });
});

describe('run', () => {
  it('passes results through', async () => {
    const result = await run(async () => textResult('fine'));
    expect(result.isError).toBeUndefined();
  });

  it('converts ToolInputError into an error result', async () => {
    const result = await run(async () => {
      throw new ToolInputError('bad argument');
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('bad argument');
  });

  it('converts API errors with sanitized body and hint', async () => {
    const result = await run(async () => {
      throw new RustpadApiError(404, '<html>x</html>', 'GET', '/api/text/x');
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('HTTP 404');
    expect(textOf(result)).toContain('(HTML error page omitted)');
    expect(textOf(result)).toContain('Hint');
  });

  it('converts unknown errors', async () => {
    const result = await run(async () => {
      throw new Error('socket exploded');
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('rustpad-mcp: socket exploded');
  });
});
