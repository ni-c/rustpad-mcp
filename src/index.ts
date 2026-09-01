#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';

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
  // Printed only when it is off, like RUSTPAD_READ_ONLY above. ELICITATION is
  // unprefixed, so one `export ELICITATION=false` reaches every MCP server in
  // the environment — this line is what makes that visible in the log of each
  // one it actually reached.
  if (!config.elicitation) {
    console.error(
      'rustpad-mcp: ELICITATION=false — guarded tools fall back to the two-call token'
    );
  }

  let server;
  try {
    server = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash: print the
    // sentence on its own rather than behind "fatal error:".
    if (error instanceof ToolFilterError) {
      console.error(`rustpad-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  console.error(
    config.url
      ? `rustpad-mcp: connected, targeting ${config.url}`
      : 'rustpad-mcp: connected without configuration — tools are listed but every call will fail'
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error('rustpad-mcp: fatal error:', error);
  process.exit(1);
});
