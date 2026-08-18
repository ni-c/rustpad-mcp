#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.insecureTls) {
    console.error(
      'rustpad-mcp: RUSTPAD_INSECURE_TLS=true — TLS certificate validation is disabled for the Rustpad connection'
    );
  }
  if (config.readOnly) {
    console.error(
      'rustpad-mcp: RUSTPAD_READ_ONLY=true — write tools are not registered'
    );
  }

  const server = createServer(config);
  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    config.url
      ? `rustpad-mcp: connected, targeting ${config.url}`
      : 'rustpad-mcp: connected without configuration — tools are listed but every call will fail'
  );
}

main().catch((error: unknown) => {
  console.error('rustpad-mcp: fatal error:', error);
  process.exit(1);
});
