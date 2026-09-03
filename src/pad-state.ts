import type { RustpadApi } from './api.js';
import { ToolInputError } from './result.js';
import type { RustpadSession } from './session.js';

/**
 * Confirms, over a second channel, that a pad the socket reports as empty is
 * really empty.
 *
 * `settle()` ends the initial burst after 300 ms of silence, and Rustpad sends
 * **no History message at all** for a pad that has never been written. So on
 * the socket, "this pad is empty" and "the history has not arrived yet" are the
 * same observation. They are not the same fact: a slow instance, a database
 * restore, a buffering proxy or plain round-trip time plus a TLS handshake can
 * put the History past that window, and the session then carries `text: ''` and
 * `revision: 0` for a pad that is full.
 *
 * That is not a cosmetic difference. An empty pad is precisely the state every
 * write tool treats as safe: `set_document` skips its confirmation dialog
 * entirely, `create_document`'s refusal to overwrite has nothing to refuse, and
 * an operation built on revision 0 is transformed by the server against the
 * operations this client never saw — so the text lands *beside* the existing
 * content rather than in place of it, while the reply reports a clean replace.
 * A guard that is present in every test and absent whenever the network is slow
 * is worse than one that is missing, because nothing ever reports its absence.
 *
 * `GET /api/text/{id}` reads the same in-memory document over a channel that
 * does not depend on the timing of a burst, so a disagreement is decisive.
 * Checked only when no History arrived, for two reasons: that is the one
 * genuinely ambiguous case, and comparing the two channels on every call would
 * turn an ordinary concurrent edit — which the operational transform handles
 * correctly — into a failure.
 */
export async function assertConfirmedEmpty(
  api: RustpadApi,
  session: RustpadSession,
  id: string
): Promise<void> {
  if (session.state.sawHistory) return;
  const text = await api.text(id);
  if (text === '') return;
  throw new ToolInputError(
    `pad "${id}" is not empty, but its content did not arrive over the collaboration ` +
      'socket before this server stopped waiting for it. Refusing to write on a state ' +
      'that could not be confirmed — the edit would have been placed next to the ' +
      'existing text instead of replacing it. Read the pad with get_document and try again.'
  );
}
