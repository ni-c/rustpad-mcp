import { createHash } from 'node:crypto';

// The resource keys of the guarded tools are built with `orderedResourceKey`
// from `mcp-approval`, which binds each part to its position. Until 0.4.0 this
// module carried its own `tupleResourceKey` for that; the reasoning stays at
// the call sites in src/tools/write.ts.

/**
 * A short, stable hash of a pad's content, for use inside a resource key.
 *
 * Pad content runs to 256 KiB and is arbitrary text; putting it in a key
 * verbatim would make the key unbounded and would carry the content into
 * whatever logs the store. The hash carries only the fact that decides the
 * question: is this still the same text the person was told about?
 */
export function contentFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
