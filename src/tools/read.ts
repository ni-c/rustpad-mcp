import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { assertDocumentId, type RustpadApi } from '../api.js';
import type { Config } from '../config.js';
import { codepointLength } from '../ot.js';
import { jsonResult, run, textResult, untrustedResult } from '../result.js';
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
    },
    async ({ id }) =>
      run(async () => {
        const text = await api.text(assertDocumentId(id));
        if (text === '') {
          return textResult(
            `The pad "${id}" is empty — or it never existed, or it has ` +
              'expired. Rustpad reports all three the same way.'
          );
        }
        return untrustedResult(text);
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
    },
    async ({ id }) =>
      run(async () => {
        assertDocumentId(id);
        return withSession(config, id, webSocketFactory, async (session) => {
          const { state } = session;
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
