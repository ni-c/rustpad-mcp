import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/core/internal';
import { describe, expect, it } from 'vitest';

/**
 * A tripwire for a paragraph in SECURITY.md, not a behaviour of this server.
 *
 * `mcp-approval` seals the request state it hands to the client and checks the
 * seal on the way back. That proves *binding* — the answer belongs to the
 * question and to this operation — and deliberately not *freshness*: a sealed
 * state stays valid for its whole TTL, so a client that replayed one would
 * replay an approval.
 *
 * It is unreachable here today, and the reason is mechanical rather than
 * careful design on this server's part. The sealed state only crosses the wire
 * on protocol revision `2026-07-28`, where the call ends with `input_required`
 * and the client comes back with a second `tools/call`. On every revision this
 * SDK actually speaks, the SDK's legacy shim answers the elicitation
 * server-side inside the *same* `tools/call`, so there is no reply for anyone
 * to replay. The other half of the guard, the two-call token, is single-use
 * regardless.
 *
 * When this test fails, the newer revision has arrived and the question becomes
 * real. SECURITY.md § "What an approval binds" says what would have to be built
 * that day; nothing is built for it now, because a mechanism guarding a path
 * that cannot be taken is a mechanism nobody can test.
 */
describe('the protocol era this server actually speaks', () => {
  it('does not offer the revision on which a sealed approval crosses the wire', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
  });
});
