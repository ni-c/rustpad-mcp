import { ConfirmationStore, createApproval } from 'mcp-approval';
import { describe, expect, it } from 'vitest';

/**
 * What SECURITY.md § "What an approval binds" claims about freshness, held
 * against the approver this server actually builds.
 *
 * This file used to be a tripwire on `SUPPORTED_PROTOCOL_VERSIONS` from
 * `@modelcontextprotocol/core/internal`, reasoning that a sealed dialog
 * answer only crosses the wire on protocol revision `2026-07-28`, and that
 * the day the SDK listed it, the replay question would become real. It never
 * fired: that constant is the list of *legacy* revisions and never carries the
 * modern one, which `serveStdio` negotiates separately through
 * `server/discover` — and has, on this server, since 0.3.0. The question was
 * real for two releases while the test said it was not.
 *
 * So the test now asks the question itself. A sealed state is minted with a
 * nonce; the first answer that carries it is honoured, the second is treated
 * as no answer at all and the person is asked again. The context here is the
 * shape of a modern-era call — `requestState()` and `inputResponses` on the
 * request — driven directly, because the in-memory client of the harness
 * speaks the legacy era, where the SDK answers the dialog server-side inside
 * the same call and there is no state to replay.
 */
describe('a sealed dialog answer is single-use', () => {
  const approver = createApproval({ server: 'rustpad-mcp', elicitation: true });
  const server = {
    server: { getClientCapabilities: () => ({ elicitation: {} }) },
  } as unknown as Parameters<typeof approver.requestApproval>[0];
  const store = new ConfirmationStore();
  const request = {
    what: 'replace the entire content of pad "p" (14 characters)',
    consequence: 'The previous content cannot be restored.',
    resourceKey: 'set_document:p',
    toolName: 'set_document',
    token: undefined,
  };
  type Ctx = Parameters<typeof approver.requestApproval>[1];
  const asking = (): Ctx =>
    ({
      mcpReq: { method: 'tools/call', requestState: () => undefined },
    }) as unknown as Ctx;
  const answering = (state: string): Ctx =>
    ({
      mcpReq: {
        method: 'tools/call',
        requestState: () => state,
        inputResponses: {
          confirm: { action: 'accept', content: { confirm: true } },
        },
      },
    }) as unknown as Ctx;

  it('honours the first presentation and asks again on the second', async () => {
    const first = await approver.requestApproval(
      server,
      asking(),
      store,
      request
    );
    expect(first.decision).toBe('pending');
    const state = (first as { result: { requestState?: unknown } }).result
      .requestState;
    expect(typeof state).toBe('string');

    const second = await approver.requestApproval(
      server,
      answering(state as string),
      store,
      request
    );
    expect(second.decision).toBe('approved');

    // The same sealed state, the same ticked box, presented again within its
    // lifetime: not an approval. Not an error either — the likeliest cause is
    // a gateway that put the server to sleep — so it is a fresh question.
    const third = await approver.requestApproval(
      server,
      answering(state as string),
      store,
      request
    );
    expect(third.decision).toBe('pending');
  });

  it('does not let a state minted for one operation answer another', async () => {
    const first = await approver.requestApproval(
      server,
      asking(),
      store,
      request
    );
    const state = (first as { result: { requestState: string } }).result
      .requestState;
    const other = await approver.requestApproval(
      server,
      answering(state),
      store,
      { ...request, resourceKey: 'set_document:q' }
    );
    expect(other.decision).toBe('pending');
  });
});
