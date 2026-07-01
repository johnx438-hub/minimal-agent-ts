import { isAbortError } from './events.js';

export class LlmHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs?: number;

  constructor(status: number, body: string, retryAfterMs?: number) {
    const preview = body.slice(0, 500);
    super(`LLM HTTP ${status}: ${preview}`);
    this.name = 'LlmHttpError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

const RETRIABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const RETRIABLE_ERRNO = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

export interface LlmRetryConfig {
  /** Total attempts including the first call. Default 3. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_LLM_RETRY_CONFIG: LlmRetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;

  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    const delta = when - Date.now();
    return delta > 0 ? delta : undefined;
  }

  return undefined;
}

export function isRetriableLlmError(err: unknown, tokensEmitted: boolean): boolean {
  if (tokensEmitted) return false;
  if (isAbortError(err)) return false;

  if (err instanceof LlmHttpError) {
    return RETRIABLE_HTTP_STATUS.has(err.status);
  }

  if (err instanceof TypeError) {
    return true;
  }

  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code && RETRIABLE_ERRNO.has(code)) {
      return true;
    }
  }

  return false;
}

export function formatLlmRetryReason(err: unknown): string {
  if (err instanceof LlmHttpError) {
    return `HTTP ${err.status}`;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code) return code;
    return err.message.slice(0, 80);
  }
  return 'unknown';
}

export function computeRetryDelayMs(
  err: unknown,
  attempt: number,
  config: LlmRetryConfig = DEFAULT_LLM_RETRY_CONFIG,
): number {
  const retryAfter =
    err instanceof LlmHttpError && err.retryAfterMs !== undefined
      ? err.retryAfterMs
      : undefined;
  const exponential = config.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 200);
  const delay = retryAfter ?? exponential + jitter;
  return Math.min(config.maxDelayMs, Math.max(0, delay));
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}