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
 * How much of an *error* body is kept. It is quoted into the tool result,
 * shortened, so anything past a few kilobytes is never read at all.
 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * The response surface both `fetch` implementations share. undici's
 * `Response` and the global one are type-incompatible; this is what the
 * readers below need from either.
 */
interface BodyLike {
  headers: { get(name: string): string | null };
  body: unknown;
  text(): Promise<string>;
}

function chunks(response: BodyLike): AsyncIterable<Uint8Array> | undefined {
  const body = response.body as AsyncIterable<Uint8Array> | null | undefined;
  // Test stubs of fetch commonly return a Response-like object without a
  // stream. The callers fall back to text() there; the content-length check
  // still applies.
  if (
    !body ||
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !==
      'function'
  ) {
    return undefined;
  }
  return body;
}

/**
 * Reads a response body, refusing anything past {@link MAX_RESPONSE_BYTES}.
 *
 * `content-length` is checked first because it lets an oversized response be
 * rejected without transferring it, but it is absent on chunked responses and
 * is upstream-controlled either way, so the streaming path enforces the limit
 * again.
 */
async function readCappedText(response: BodyLike): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Rustpad returned ${declared} bytes, more than the ${MAX_RESPONSE_BYTES} byte limit this server will read.`
    );
  }

  const body = chunks(response);
  if (body === undefined) {
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

/**
 * Reads the body of a failed response: at most {@link MAX_ERROR_BODY_BYTES},
 * cut rather than refused, and never a throw.
 *
 * Separate from {@link readCappedText} because the status has already
 * decided the outcome. A 502 with a two-megabyte error page is a 502 with a
 * hint about the instance being down, not "the answer was too large" — and a
 * body that fails to read is not a reason to lose the status either.
 */
async function readErrorBody(response: BodyLike): Promise<string> {
  try {
    const body = chunks(response);
    if (body === undefined) {
      return (await response.text()).slice(0, MAX_ERROR_BODY_BYTES);
    }
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for await (const chunk of body) {
      const room = MAX_ERROR_BODY_BYTES - total;
      const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      total += part.byteLength;
      text += decoder.decode(part, { stream: true });
      // Leaving the loop early returns the iterator, which cancels the stream.
      if (total >= MAX_ERROR_BODY_BYTES) break;
    }
    return text + decoder.decode();
  } catch {
    return '';
  }
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
 * The widest Unix timestamp `Date` can represent, in seconds: past this,
 * `toISOString()` throws `RangeError: Invalid time value`.
 */
const MAX_UNIX_SECONDS = 8_640_000_000_000;

/**
 * A count the instance reported, or `undefined` for anything the output
 * schema's `.int()` would refuse: `1.5`, `1e999` (which `JSON.parse` reads
 * as `Infinity`), a negative, a string. One such value used to fail the whole
 * answer with an output validation error that named no field.
 */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function unixSecondsOf(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= MAX_UNIX_SECONDS
    ? value
    : undefined;
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

    // Status first. The body of a failure is read under its own small
    // ceiling and only ever shortened; reading it under the success ceiling
    // turned a 401 from a proxy with a large login page into "more than the
    // byte limit", with the status and its hint lost.
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new RustpadApiError(response.status, body, 'GET', path);
    }
    return readCappedText(response);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('Rustpad /api/stats did not return valid JSON');
    }
    // Picked field by field: the response is upstream-controlled, and spreading
    // it through would hand any extra key straight to the model.
    const record =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const start_time = unixSecondsOf(record.start_time);
    const num_documents = countOf(record.num_documents);
    const database_size = countOf(record.database_size);
    if (start_time === undefined) {
      throw new Error(
        'Rustpad /api/stats returned an unexpected shape: start_time is not a Unix timestamp'
      );
    }
    if (num_documents === undefined || database_size === undefined) {
      throw new Error(
        'Rustpad /api/stats returned an unexpected shape: num_documents and database_size must be whole numbers'
      );
    }
    return { start_time, num_documents, database_size };
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
