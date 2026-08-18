import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';

/** Ample for the two HTTP endpoints, which are in-memory lookups. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Hard cap on how much of a response body is read into memory.
 *
 * Rustpad documents are limited to 256 KiB by the server itself, so 8 MB is far
 * above any legitimate response — but a misconfigured RUSTPAD_URL pointing at
 * something that streams endlessly, or a reverse proxy emitting a huge error
 * page, would otherwise grow the process until it is killed.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Reads a response body, refusing anything past {@link MAX_RESPONSE_BYTES}.
 *
 * `content-length` is checked first because it lets an oversized response be
 * rejected without transferring it, but it is absent on chunked responses and
 * is upstream-controlled either way, so the streaming path enforces the limit
 * again.
 */
async function readCappedText(response: {
  headers: { get(name: string): string | null };
  body: unknown;
  text(): Promise<string>;
}): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Rustpad returned ${declared} bytes, more than the ${MAX_RESPONSE_BYTES} byte limit this server will read.`
    );
  }

  const body = response.body as AsyncIterable<Uint8Array> | null | undefined;
  // Test stubs of fetch commonly return a Response-like object without a
  // stream. Falling back to text() there keeps them working; the
  // content-length check above still applies.
  if (
    !body ||
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !==
      'function'
  ) {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Rustpad returned more than the ${MAX_RESPONSE_BYTES} byte limit this server will read.`
      );
    }
    return text;
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Rustpad returned more than the ${MAX_RESPONSE_BYTES} byte limit this server will read.`
      );
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export class RustpadApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    method: string,
    path: string
  ) {
    super(`Rustpad API ${method} ${path} failed with HTTP ${status}`);
    this.name = 'RustpadApiError';
  }
}

/** Server statistics as returned by `GET /api/stats`. */
export interface RustpadStats {
  start_time: number;
  num_documents: number;
  database_size: number;
}

/**
 * Client for Rustpad's two HTTP endpoints (verified against ekzhang/rustpad
 * `rustpad-server/src/lib.rs`). Everything else — writing, language, presence —
 * speaks the WebSocket protocol in `session.ts`.
 */
export class RustpadApi {
  private readonly config: Config;
  private readonly baseUrl: string;
  /**
   * Only set when RUSTPAD_INSECURE_TLS is enabled. Scopes the relaxed
   * certificate validation to requests against the configured host instead of
   * disabling it process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher?: Agent;

  constructor(config: Config) {
    this.config = config;
    this.baseUrl = config.url ?? '';
    if (config.insecureTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  private async request(path: string): Promise<string> {
    // The URL is only required here, not at startup, so the server can still
    // be started and introspected without it.
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) {
      throw new Error(missingConfigMessage(missing));
    }

    const init: RequestInit = {
      method: 'GET',
      // Never follow a redirect: a mistyped RUSTPAD_URL behind a reverse proxy
      // would silently read from whatever host the upstream points at.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    const url = `${this.baseUrl}${path}`;
    // The insecure dispatcher requires undici's own fetch; the default path
    // uses the (stubbable) global fetch so tests can intercept it.
    const response = this.insecureDispatcher
      ? await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)
      : await fetch(url, init);
    const text = await readCappedText(response);

    if (!response.ok) {
      throw new RustpadApiError(response.status, text, 'GET', path);
    }
    return text;
  }

  /**
   * Current text of a document, as plain text. An empty string is ambiguous:
   * Rustpad answers it both for an empty pad and for one that never existed
   * or has expired.
   */
  async text(id: string): Promise<string> {
    return this.request(`/api/text/${encodeURIComponent(id)}`);
  }

  async stats(): Promise<RustpadStats> {
    const body = await this.request('/api/stats');
    try {
      return JSON.parse(body) as RustpadStats;
    } catch {
      throw new Error('Rustpad /api/stats did not return valid JSON');
    }
  }
}

/**
 * Guards a value that ends up in a URL path or WebSocket path.
 *
 * Rustpad accepts any string as a document id, but ids outside this shape are
 * almost always an attempt at path traversal — and with enough `..` the
 * request reaches a different endpoint entirely.
 */
export function assertDocumentId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(
      'invalid document id: only letters, digits, dot, underscore and hyphen are allowed'
    );
  }
  return value;
}
