import { z } from 'zod';

/**
 * Rustpad accepts any string as a pad id, but this server restricts ids to a
 * URL-safe shape: everything else is either a typo or a path-traversal
 * attempt. The frontend generates ids from the same alphabet.
 */
export const documentIdParam = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'only letters, digits, dot, underscore and hyphen are allowed'
  )
  .refine((v) => v !== '.' && v !== '..', 'invalid document id')
  .describe('Id of the pad, the part after # in its URL');

/**
 * Rejects lone surrogates: they cannot be encoded as valid UTF-8, so the Rust
 * server drops the connection instead of answering — and inside a search
 * string they would corrupt the code-point arithmetic in ot.ts.
 */
export function wellFormed<T extends z.ZodString>(schema: T) {
  return schema.refine(
    (value) => value.isWellFormed(),
    'text must not contain unpaired surrogate characters'
  );
}

/**
 * Zod's max() counts UTF-16 units while Rustpad's 256 KiB limit counts code
 * points; the code-point check in ot.ts is authoritative, this bound just
 * rejects the absurd early.
 */
export const documentTextParam = wellFormed(
  z.string().max(256 * 1024)
).describe('Plain text content (up to 256 KiB, the Rustpad document limit)');

export const languageParam = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9+#.-]+$/i, 'not a Monaco language id')
  .describe(
    'Monaco editor language id for syntax highlighting, e.g. "markdown", ' +
      '"javascript", "rust", "plaintext"'
  );

export const confirmTokenParam = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Confirmation token from a previous call of this tool with the same ' +
      'arguments. Omit on the first call.'
  );
