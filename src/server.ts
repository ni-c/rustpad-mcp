import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RustpadApi } from './api.js';
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
  const api = new RustpadApi(config);
  const confirmations = new ConfirmationStore();

  const server = new McpServer({
    name: 'rustpad-mcp',
    version: packageVersion(),
  });

  registerReadTools(server, api, config, options.webSocketFactory);

  // Read-only mode does not register the write tools at all. Rejecting them at
  // call time would still advertise capabilities the server refuses to provide.
  if (!config.readOnly) {
    registerWriteTools(server, config, confirmations, options.webSocketFactory);
  }

  return server;
}
