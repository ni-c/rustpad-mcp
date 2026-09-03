import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { assertDocumentId, type RustpadApi } from '../api.js';
import type { Config } from '../config.js';
import { codepointLength } from '../ot.js';
import { assertConfirmedEmpty } from '../pad-state.js';
import { budgetedText, jsonResult, run, untrustedResult } from '../result.js';
import { untrustedFields } from '../output-schema.js';
import { documentIdParam } from '../schema.js';
import { withSession, type WebSocketFactory } from '../session.js';

/** Reused across tool descriptions so the caveat is worded identically. */
export const EPHEMERAL_NOTE =
  'Pads are ephemeral: they are lost when the Rustpad server restarts and ' +
  'after 24 hours without an open connection.';

export function shareUrl(config: Config, id: string): string {
  return `${config.url}/#${id}`;
}

export function registerReadTools(
  server: McpServer,
  api: RustpadApi,
  config: Config,
  webSocketFactory?: WebSocketFactory
): void {
  server.registerTool(
    'get_document',
    {
      title: 'Read a pad',
      description:
        `Reads the current plain-text content of a pad. ${EPHEMERAL_NOTE} ` +
        'An empty result is ambiguous: Rustpad cannot distinguish an empty ' +
        'pad from one that never existed or has expired.',
      inputSchema: z.object({ id: documentIdParam }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // The pad goes in a field rather than being the result. A schema whose
      // root is a string is served to a 2025-era client rewritten as
      // `{result: …}`, so the tool would answer in two shapes depending on who
      // asked — and `empty` needs somewhere to live either way.
      outputSchema: z.object({
        ...untrustedFields,
        id: z.string(),
        text: z.string(),
        empty: z
          .literal(true)
          .optional()
          .describe(
            'The pad is empty — or never existed, or has expired. Rustpad ' +
              'reports all three the same way.'
          ),
        truncated: z
          .object({ shown: z.number().int(), total: z.number().int() })
          .optional()
          .describe('Present when the pad is larger than the result budget.'),
      }),
    },
    async ({ id }) =>
      run(async () => {
        const text = await api.text(assertDocumentId(id));
        if (text === '') {
          return untrustedResult({
            id,
            text: '',
            empty: true,
            note:
              `The pad "${id}" is empty — or it never existed, or it has ` +
              'expired. Rustpad reports all three the same way.',
          });
        }
        return untrustedResult({ id, ...budgetedText(text) });
      })
  );

  server.registerTool(
    'get_document_info',
    {
      title: 'Inspect a pad',
      description:
        'Fetches metadata about a pad over the collaboration socket: content ' +
        'length, revision, editor language and the users who have it open ' +
        `right now. ${EPHEMERAL_NOTE}`,
      inputSchema: z.object({ id: documentIdParam }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        ...untrustedFields,
        id: z.string(),
        url: z.string(),
        length_characters: z.number().int().describe('Codepoints, not bytes.'),
        revision: z.number().int(),
        language: z.string(),
        active_users: z
          .array(z.string())
          .describe('Names arbitrary clients of the instance chose.'),
        note: z.string(),
      }),
    },
    async ({ id }) =>
      run(async () => {
        assertDocumentId(id);
        return withSession(config, id, webSocketFactory, async (session) => {
          const { state } = session;
          // Reporting `length_characters: 0` for a full pad is the read-side
          // face of the same ambiguity the write tools guard against: no
          // History message means either "empty" or "not here yet". A number a
          // model will act on has to be a fact, so the second channel decides.
          if (state.text === '') {
            await assertConfirmedEmpty(api, session, id);
          }
          // Through untrustedResult, not jsonResult: `language` and the user
          // names are free text chosen by arbitrary clients of the instance.
          return untrustedResult({
            id,
            url: shareUrl(config, id),
            length_characters: codepointLength(state.text),
            revision: state.revision,
            language: state.language ?? 'plaintext (default)',
            active_users: [...state.users.values()].map((user) => user.name),
            note: EPHEMERAL_NOTE,
          });
        });
      })
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Server statistics',
      description:
        'Reads the Rustpad server statistics: start time, number of documents ' +
        'currently held in memory, and the number persisted in the database ' +
        '(0 when the instance runs without persistence).',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // No untrusted marker: three counters and a timestamp the Rustpad
      // process keeps about itself, with nothing anyone typed in them.
      outputSchema: z.object({
        start_time: z.number().describe('Unix seconds.'),
        start_time_iso: z.string(),
        num_documents: z.number().int().describe('Held in memory right now.'),
        database_size: z
          .number()
          .int()
          .describe('Persisted pads; 0 on an instance without persistence.'),
      }),
    },
    async () =>
      run(async () => {
        const stats = await api.stats();
        return jsonResult({
          ...stats,
          start_time_iso: new Date(stats.start_time * 1000).toISOString(),
        });
      })
  );
}
