import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';

import { ConfirmationStore, createApproval } from 'mcp-approval';
import { buildToolFilter, installToolFilter } from 'mcp-tool-allowlist';

import { RustpadApi } from './api.js';

import type { Config } from './config.js';
import { ALL_TOOLS, ESSENTIAL_TOOLS, READ_TOOLS } from './tools/catalogue.js';
import type { WebSocketFactory } from './session.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export interface ServerOptions {
  /** Test seam: replaces the WebSocket implementation used by the sessions. */
  webSocketFactory?: WebSocketFactory;
}

export function createServer(
  config: Config,
  options: ServerOptions = {}
): McpServer {
  // Before anything is built: an unusable tool list should fail on the
  // way in, not leave a server running with tools quietly missing.
  const filter = buildToolFilter({
    allowTools: config.allowTools,
    denyTools: config.denyTools,
    catalogue: {
      all: ALL_TOOLS,
      essential: ESSENTIAL_TOOLS,
      ungated: READ_TOOLS,
    },
    names: {
      allow: 'RUSTPAD_ALLOW_TOOLS',
      deny: 'RUSTPAD_DENY_TOOLS',
      server: 'rustpad-mcp',
    },
    // No `activatesFilter`: read-only is carried by server.ts, which does not
    // register the write tools at all. The gate is declared anyway so that a
    // suppressed name is answered with the reason rather than "no such tool".
    gate: {
      closed: config.readOnly,
      variable: 'RUSTPAD_READ_ONLY',
      noun: 'read-only mode',
    },
  });

  const api = new RustpadApi(config);
  const confirmations = new ConfirmationStore();
  // One approver per server, because it holds the key that seals the request
  // state carried through the client and back.
  const approval = createApproval({
    server: 'rustpad-mcp',
    elicitation: config.elicitation,
  });

  const server = new McpServer({
    name: 'rustpad-mcp',
    version: packageVersion(),
  });

  // Wraps server.registerTool, so it has to sit before the first
  // register call and does not care how they are organised.
  installToolFilter(server, filter);

  registerReadTools(server, api, config, options.webSocketFactory);

  // Read-only mode does not register the write tools at all. Rejecting them at
  // call time would still advertise capabilities the server refuses to provide.
  if (!config.readOnly) {
    registerWriteTools(
      server,
      api,
      config,
      confirmations,
      approval,
      options.webSocketFactory
    );
  }

  return server;
}
