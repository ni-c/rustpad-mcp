import { createHash, randomInt } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  appendOps,
  codepointLength,
  replaceOps,
  searchReplaceOps,
} from '../ot.js';
import {
  confirmTokenParam,
  documentIdParam,
  documentTextParam,
  languageParam,
  wellFormed,
} from '../schema.js';

import { assertDocumentId } from '../api.js';
import {
  setResourceKey,
  type Approver,
  type ConfirmationStore,
} from 'mcp-approval';
import type { Config } from '../config.js';
import { run, textResult, ToolInputError } from '../result.js';
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
  approval: Approver,
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
      inputSchema: z.object({
        id: documentIdParam
          .optional()
          .describe('Desired pad id; omit to generate a random one'),
        text: documentTextParam.optional().describe('Initial content'),
        language: languageParam.optional(),
      }),
      annotations: {
        // Additive: it brings a pad into existence and writes what was asked
        // for. Idempotent because a pad is just an id — asking for the same one
        // twice lands on the same pad rather than making a second.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      inputSchema: z.object({
        id: documentIdParam,
        text: documentTextParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Idempotent in the sense the specification means: it names an
        // absolute target state, so sending it twice leaves the pad exactly
        // where the first call left it.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, text, confirm_token }, mcp) =>
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
            // The key is bound to the replacement text as well as the pad, so
            // an approval obtained for one text cannot execute another.
            const fingerprint = createHash('sha256')
              .update(text)
              .digest('hex')
              .slice(0, 16);
            const outcome = await approval.requestApproval(
              server,
              mcp,
              confirmations,
              {
                what: `replace the entire content of pad "${id}" (${oldLength} characters) with new content (${codepointLength(text)} characters)`,
                consequence: 'The previous content cannot be restored.',
                resourceKey: `set_document:${id}:${fingerprint}`,
                token: confirm_token,
                title: `Replace the contents of pad "${id}"?`,
                hint: 'Tick to replace it, leave it to cancel.',
                toolName: 'set_document',
              }
            );
            if (outcome.decision === 'declined') {
              throw new ToolInputError(
                'rustpad-mcp: the user declined. The pad was not changed.'
              );
            }
            // A token that was sent and did not match is refused with the
            // reason rather than answered with a fresh prompt: it means the
            // call carried a confirmation issued for a different pad or a
            // different replacement text, which is what the key binds against.
            // The sentence is the library's, so every server says the same.
            if (outcome.decision === 'rejected') {
              throw new ToolInputError(`rustpad-mcp: ${outcome.reason}`);
            }
            if (outcome.decision === 'pending') return outcome.result;
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
      inputSchema: z.object({
        id: documentIdParam,
        text: documentTextParam.min(1).describe('Text to append verbatim'),
      }),
      annotations: {
        // Additive, and the one write here that is not idempotent: appending the
        // same text twice leaves it in the pad twice.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
        'replace_all to change every occurrence. Replacing more than one ' +
        'occurrence at once asks a person first.',
      inputSchema: z.object({
        id: documentIdParam,
        confirm_token: confirmTokenParam,
        search: wellFormed(
          z
            .string()
            .min(1)
            .max(256 * 1024)
        ).describe('Exact string to find (no regex)'),
        replace: wellFormed(z.string().max(256 * 1024)).describe(
          'Replacement; may be empty to delete the match'
        ),
        replace_all: z
          .boolean()
          .optional()
          .describe(
            'Replace every occurrence instead of requiring a unique match'
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Not idempotent, and it is worth being exact about why: a second
        // run is only a no-op while the replacement does not itself contain
        // the search string. "a" -> "aa" grows the pad every time.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, search, replace, replace_all, confirm_token }, mcp) =>
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
          // A single, unique replacement is a targeted edit and goes through.
          // `replace_all` across several matches is the case that can take out
          // as much of a pad as set_document does, and set_document asks — so
          // this asks too, and says how many places it is about to change.
          //
          // The count comes from `searchReplaceOps` above, which means it was
          // measured inside the open session: what the person is told is the
          // pad as it stands, not as it stood when the model decided.
          if (count > 1) {
            const outcome = await approval.requestApproval(
              server,
              mcp,
              confirmations,
              {
                what: `replace ${count} occurrences in pad "${id}"`,
                consequence:
                  'What is replaced cannot be restored, and a search string ' +
                  'that is shorter than intended matches in places nobody ' +
                  'looked at.',
                // Bound to the pad, the exact pair and the number of matches:
                // an approval for two occurrences does not execute against a
                // pad that has since grown a third.
                resourceKey: setResourceKey('replace_in_document', [
                  id,
                  search,
                  replace,
                  String(count),
                ]),
                token: confirm_token,
                details: [
                  { label: 'Search', value: search },
                  { label: 'Replace with', value: replace },
                ],
                title: `Replace ${count} occurrences in pad "${id}"?`,
                hint: 'Tick to replace them, leave it to cancel.',
                toolName: 'replace_in_document',
              }
            );
            if (outcome.decision === 'declined') {
              throw new ToolInputError(
                'rustpad-mcp: the user declined. The pad was not changed.'
              );
            }
            if (outcome.decision === 'rejected') {
              throw new ToolInputError(`rustpad-mcp: ${outcome.reason}`);
            }
            if (outcome.decision === 'pending') return outcome.result;
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
      inputSchema: z.object({ id: documentIdParam, language: languageParam }),
      annotations: {
        // Overwrites a setting, not content — "last writer wins" is a change, not
        // a destruction. Setting the same language twice is the same pad.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
