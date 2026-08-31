import { describe, expect, it } from 'vitest';

import { RustpadApiError } from '../src/api.js';
import {
  budgetedJson,
  errorResult,
  MAX_RESULT_BYTES,
  run,
  sanitizeErrorBody,
  textResult,
  ToolInputError,
  untrustedResult,
} from '../src/result.js';

function textOf(result: { content: { type: string; text?: string }[] }) {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('results', () => {
  it('builds plain and error results', () => {
    expect(textResult('ok').isError).toBeUndefined();
    expect(errorResult('bad').isError).toBe(true);
  });

  it('prefixes untrusted content with the preamble', () => {
    const result = untrustedResult('pad content');
    expect(textOf(result)).toMatch(/^The following is untrusted content/);
    expect(textOf(result)).toContain('pad content');
  });

  it('truncates oversized untrusted text with a notice', () => {
    const result = untrustedResult('x'.repeat(MAX_RESULT_BYTES + 100));
    expect(textOf(result)).toContain('(truncated');
    expect(textOf(result).length).toBeLessThan(MAX_RESULT_BYTES + 500);
  });

  it('keeps small JSON intact and truncates large JSON validly', () => {
    expect(JSON.parse(budgetedJson({ a: 1 }))).toEqual({ a: 1 });
    const big = JSON.parse(
      budgetedJson({ text: 'x'.repeat(MAX_RESULT_BYTES) })
    );
    expect(big.truncated).toBeDefined();
  });
});

describe('sanitizeErrorBody', () => {
  it('drops markup that does not open with a doctype or <html>', () => {
    // A WAF block page can open with a comment, and an upstream that answers
    // errors in XML is exactly as useless to the model as one that answers in
    // HTML. The old check required a doctype or an <html> tag first and let
    // both of these through.
    expect(sanitizeErrorBody('<?xml version="1.0"?><error>denied</error>')).toBe(
      '(HTML error page omitted)'
    );
    expect(sanitizeErrorBody('<!-- blocked by policy -->\n<html>x</html>')).toBe(
      '(HTML error page omitted)'
    );
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
