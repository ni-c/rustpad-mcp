import { internalHostKind } from 'mcp-internal-hosts';

export interface Config {
  /**
   * Base URL of the Rustpad instance, e.g. `https://rustpad.example.net`.
   * May be undefined: the server still starts and lists its tools, every call
   * then fails with {@link missingConfigMessage}. The same URL is used for the
   * HTTP API, the WebSocket endpoint (http→ws mapped) and the share links
   * returned by the tools.
   */
  url: string | undefined;
  insecureTls: boolean;
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;
  /**
   * Raw value of `RUSTPAD_ALLOW_TOOLS` — comma-separated tool names, `list_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror of
   * the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `RUSTPAD_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: RUSTPAD_URL (e.g. https://rustpad.example.net)\n' +
    'Rustpad has no authentication: anyone who can reach the instance and ' +
    'knows a pad id can read and write it.\n' +
    'Optional: RUSTPAD_READ_ONLY=true to expose only read tools, ' +
    'RUSTPAD_INSECURE_TLS=true to accept self-signed certificates, ' +
    'RUSTPAD_ALLOW_TOOLS / RUSTPAD_DENY_TOOLS to choose which tools load, ' +
    'ELICITATION=false to fall back to the two-call confirmation token'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [!config.url && 'RUSTPAD_URL'].filter((v): v is string => Boolean(v));
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the first variable of the family that defaults to *on*. The
 * others fail open on a typo, which is the safe direction for them. Here a typo
 * would leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  console.error(
    `rustpad-mcp: ELICITATION must be "true" or "false" — got "${raw}". ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

/**
 * Reads the configuration from environment variables.
 *
 * A missing URL is only a warning, not a fatal error: the server must be able
 * to complete the MCP handshake and answer `tools/list` without it, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — every request built from it would go to the wrong place.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.RUSTPAD_URL;
  const insecureTls = env.RUSTPAD_INSECURE_TLS === 'true';
  const readOnly = env.RUSTPAD_READ_ONLY === 'true';
  const elicitation = parseElicitation(env.ELICITATION);
  const allowTools = env.RUSTPAD_ALLOW_TOOLS;
  const denyTools = env.RUSTPAD_DENY_TOOLS;

  if (!url) {
    console.error(`rustpad-mcp: ${missingConfigMessage(['RUSTPAD_URL'])}`);
    return {
      url: undefined,
      insecureTls,
      readOnly,
      elicitation,
      allowTools,
      denyTools,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberately without the value: a secret pasted into the wrong variable
    // would be echoed into the log by an error message that quotes it.
    console.error('rustpad-mcp: RUSTPAD_URL is not a valid absolute URL');
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `rustpad-mcp: RUSTPAD_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Rustpad has no authentication, so credentials here are always a mistake —
  // and they would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error('rustpad-mcp: RUSTPAD_URL must not contain credentials');
    process.exit(1);
  }
  // A query or fragment silently corrupts every request URL built from this
  // base: `…#x` + `/api/text/id` sends the request to `/` of the host, with
  // the intended path swallowed by the fragment.
  if (parsed.search || parsed.hash) {
    console.error(
      'rustpad-mcp: RUSTPAD_URL must not contain a query string or fragment'
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    console.error(
      'rustpad-mcp: WARNING: RUSTPAD_URL uses plain http to a non-local host — ' +
        'all pad content will travel unencrypted. Use https:// instead.'
    );
  }

  return {
    url: url.replace(/\/+$/, ''),
    insecureTls,
    readOnly,
    elicitation,
    allowTools,
    denyTools,
  };
}

function isLoopbackHost(hostname: string): boolean {
  // The shared classifier, so every spelling of a loopback address is
  // recognised — including http://[::ffff:127.0.0.1] and 'localhost.' with its
  // root label, which the string comparison this replaced did not see.
  return internalHostKind(hostname) === 'loopback';
}
