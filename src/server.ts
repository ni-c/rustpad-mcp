import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RustpadApi } from './api.js';
import { buildToolFilter, installToolFilter } from './tool-filter.js';
import { ConfirmationStore } from './confirm.js';
import type { Config } from './config.js';
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
  const filter = buildToolFilter(config);

  const api = new RustpadApi(config);
  const confirmations = new ConfirmationStore();

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
    registerWriteTools(server, config, confirmations, options.webSocketFactory);
  }

  return server;
}
