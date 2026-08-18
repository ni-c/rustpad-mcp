import { randomInt } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertDocumentId } from '../api.js';
import { ConfirmationStore, confirmationPrompt } from '../confirm.js';
import type { Config } from '../config.js';
import {
  appendOps,
  codepointLength,
  replaceOps,
  searchReplaceOps,
} from '../ot.js';
import { run, textResult, ToolInputError } from '../result.js';
import {
  confirmTokenParam,
  documentIdParam,
  documentTextParam,
  languageParam,
} from '../schema.js';
import { withSession, type WebSocketFactory } from '../session.js';
import { EPHEMERAL_NOTE, shareUrl } from './read.js';

/**
 * Same alphabet the Rustpad frontend uses for generated ids. 12 characters of
 * base 36 are ~62 bits — collisions are not a realistic concern, and the
 * create tool checks the pad is empty anyway.
 */
function randomDocumentId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) {
    id += alphabet[randomInt(alphabet.length)];
  }
  return id;
}

export function registerWriteTools(
  server: McpServer,
  config: Config,
  confirmations: ConfirmationStore,
  webSocketFactory?: WebSocketFactory
): void {
  server.registerTool(
    'create_document',
    {
      title: 'Create a pad',
      description:
        'Creates a pad, optionally with initial content and an editor ' +
        'language, and returns its shareable URL. Without an id a random one ' +
        `is generated. ${EPHEMERAL_NOTE} Anyone who knows the URL can read ` +
        'and edit the pad.',
      inputSchema: {
        id: documentIdParam
          .optional()
          .describe('Desired pad id; omit to generate a random one'),
        text: documentTextParam.optional().describe('Initial content'),
        language: languageParam.optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id, text, language }) =>
      run(async () => {
        const documentId = id ? assertDocumentId(id) : randomDocumentId();
        return withSession(
          config,
          documentId,
          webSocketFactory,
          async (session) => {
            if (session.state.text !== '') {
              throw new ToolInputError(
                `pad "${documentId}" already has content — use set_document to replace it or append_to_document to add to it`
              );
            }
            if (text !== undefined && text !== '') {
              const ops = replaceOps(0, text);
              if (ops) await session.edit(ops);
            }
            if (language !== undefined) {
              await session.setLanguage(language);
            }
            const wrote =
              text !== undefined && text !== ''
                ? ` with ${codepointLength(text)} characters`
                : '';
            return textResult(
              `Created pad "${documentId}"${wrote}.\nURL: ${shareUrl(config, documentId)}\n${EPHEMERAL_NOTE}`
            );
          }
        );
      })
  );

  server.registerTool(
    'set_document',
    {
      title: 'Replace a pad',
      description:
        'Replaces the entire content of a pad. Replacing a non-empty pad ' +
        'requires confirmation: call once to receive a token, then again ' +
        'with that token. For targeted changes prefer replace_in_document, ' +
        'which leaves concurrent edits elsewhere in the pad intact.',
      inputSchema: {
        id: documentIdParam,
        text: documentTextParam,
        confirm_token: confirmTokenParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, text, confirm_token }) =>
      run(async () => {
        assertDocumentId(id);
        return withSession(config, id, webSocketFactory, async (session) => {
          const oldText = session.state.text;
          if (oldText === text) {
            return textResult(
              `The pad "${id}" already has exactly this content — nothing to do.`
            );
          }
          const oldLength = codepointLength(oldText);
          if (oldLength > 0) {
            const key = `set_document:${id}`;
            if (!confirmations.consume(key, confirm_token)) {
              return textResult(
                confirmationPrompt(
                  `replace the entire content of pad "${id}" (${oldLength} characters) with new content (${codepointLength(text)} characters)`,
                  confirmations.issue(key),
                  confirmations.ttlMinutes,
                  'The previous content cannot be restored.'
                )
              );
            }
          }
          const ops = replaceOps(oldLength, text);
          if (ops) await session.edit(ops);
          return textResult(
            `Replaced the content of pad "${id}" (${oldLength} → ${codepointLength(text)} characters).\nURL: ${shareUrl(config, id)}`
          );
        });
      })
  );

  server.registerTool(
    'append_to_document',
    {
      title: 'Append to a pad',
      description:
        'Appends text to the end of a pad, leaving everything else — ' +
        'including concurrent edits — untouched. The text is appended ' +
        'verbatim; include a leading newline to start a new line.',
      inputSchema: {
        id: documentIdParam,
        text: documentTextParam.min(1).describe('Text to append verbatim'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id, text }) =>
      run(async () => {
        assertDocumentId(id);
        return withSession(config, id, webSocketFactory, async (session) => {
          const oldLength = codepointLength(session.state.text);
          const ops = appendOps(oldLength, text);
          if (ops) await session.edit(ops);
          return textResult(
            `Appended ${codepointLength(text)} characters to pad "${id}" (now ${oldLength + codepointLength(text)} characters).\nURL: ${shareUrl(config, id)}`
          );
        });
      })
  );

  server.registerTool(
    'replace_in_document',
    {
      title: 'Search and replace in a pad',
      description:
        'Replaces an exact string in a pad with another. Only the matched ' +
        'ranges are edited, so concurrent edits elsewhere in the pad ' +
        'survive. By default the search string must match exactly once; set ' +
        'replace_all to change every occurrence.',
      inputSchema: {
        id: documentIdParam,
        search: z
          .string()
          .min(1)
          .max(256 * 1024)
          .describe('Exact string to find (no regex)'),
        replace: z
          .string()
          .max(256 * 1024)
          .describe('Replacement; may be empty to delete the match'),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            'Replace every occurrence instead of requiring a unique match'
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id, search, replace, replace_all }) =>
      run(async () => {
        assertDocumentId(id);
        if (search === replace) {
          throw new ToolInputError('search and replace are identical');
        }
        return withSession(config, id, webSocketFactory, async (session) => {
          const { ops, count } = searchReplaceOps(
            session.state.text,
            search,
            replace,
            replace_all ?? false
          );
          if (count === 0) {
            throw new ToolInputError(
              `the search string was not found in pad "${id}"`
            );
          }
          if (ops === undefined) {
            throw new ToolInputError(
              `the search string occurs ${count} times in pad "${id}" — pass replace_all=true or a longer, unique search string`
            );
          }
          await session.edit(ops);
          return textResult(
            `Replaced ${count} occurrence${count === 1 ? '' : 's'} in pad "${id}".\nURL: ${shareUrl(config, id)}`
          );
        });
      })
  );

  server.registerTool(
    'set_language',
    {
      title: 'Set the editor language',
      description:
        'Sets the syntax-highlighting language of a pad (Monaco language id, ' +
        'e.g. "markdown", "javascript", "rust"). Last writer wins; the change ' +
        'is visible to everyone who has the pad open.',
      inputSchema: { id: documentIdParam, language: languageParam },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id, language }) =>
      run(async () => {
        assertDocumentId(id);
        return withSession(config, id, webSocketFactory, async (session) => {
          await session.setLanguage(language);
          return textResult(`Set the language of pad "${id}" to ${language}.`);
        });
      })
  );
}
