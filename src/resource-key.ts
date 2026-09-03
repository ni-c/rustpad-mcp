import { createHash } from 'node:crypto';

/**
 * Binds a confirmation to an *ordered* tuple of targets.
 *
 * `setResourceKey` from `mcp-approval` hashes `[...targets].sort()`, which is
 * right for what its name says — a *set* — and wrong for every guarded tool
 * here. `replace_in_document` is confirmed on `(id, search, replace, count)`,
 * and the middle two are drawn from the same vocabulary: every legal `search`
 * is a legal `replace`. Sorted, `[doc, "DEV", "PROD", "2"]` and
 * `[doc, "PROD", "DEV", "2"]` hash to the same key, so a person who read
 * "Search: DEV / Replace with: PROD" and ticked the box has also approved the
 * exact opposite substitution — on a pad where both strings occur equally often
 * the count matches too, and the pad is world-writable, so an attacker can
 * arrange that.
 *
 * Preserving the order is a caller-side fix on purpose. `mcp-approval` is shared
 * across the fleet and does exactly what it promises; a server whose targets are
 * ordered says so here rather than making the library configurable.
 */
export function tupleResourceKey(
  operation: string,
  targets: readonly string[]
): string {
  return `${operation}:${createHash('sha256')
    .update(JSON.stringify(targets))
    .digest('hex')
    .slice(0, 16)}`;
}

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
