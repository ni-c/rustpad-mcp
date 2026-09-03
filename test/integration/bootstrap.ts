import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Waits for the throwaway Rustpad.
 *
 * The shortest bootstrap in this family, and the reason is worth stating:
 * Rustpad has no accounts, no tokens and no setup. A document exists as soon
 * as somebody connects to its id, which is also why the compose file binds to
 * loopback and why this suite must never be pointed anywhere else.
 */

export interface Sandbox {
  url: string;
}

export async function bootstrap(
  url = 'http://127.0.0.1:3030'
): Promise<Sandbox> {
  assertLoopback(url);
  // Rustpad serves its single-page app at the root and answers 200 for any
  // path, so a plain reachability check is all there is to wait for.
  await waitForHttp(url, { timeoutSeconds: 120, ready: (r) => r.ok });

  // The suite uses fixed pad ids, and `create_document` refuses a pad that
  // already has content — correctly, since overwriting somebody's document by
  // accident is the thing it is there to prevent. So a second run against the
  // same container fails halfway through with a message about the wrong
  // thing. Rustpad keeps documents in memory for the life of the process and
  // offers no way to delete one, which makes recreating the container the
  // only reset there is.
  const stats = (await (
    await fetch(`${url}/api/stats`, { signal: AbortSignal.timeout(10_000) })
  ).json()) as { num_documents: number };
  if (stats.num_documents > 0) {
    throw new Error(
      `This Rustpad already holds ${stats.num_documents} document(s), and the ` +
        'suite needs an empty one: it creates pads at fixed ids and Rustpad ' +
        'has no way to delete a pad. Run `docker compose -f ' +
        'test/integration/compose.yml down` and up again.'
    );
  }

  return { url };
}

/** A pad id nothing else will collide with, per scenario. */
export function padId(name: string): string {
  return `integration-${name}`;
}
