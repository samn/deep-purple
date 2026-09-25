/**
 * Timeouts and retries for network reads. A request that never settles would
 * otherwise hold its slot in the load queue forever, and a single dropped
 * connection would cost a frame for the whole session.
 */

export interface RetryOptions {
  /** Total tries, including the first. */
  attempts: number;
  /** Abort an attempt that hasn't settled after this long. */
  timeoutMs: number;
  /** Wait before the first retry; doubles for each one after. */
  backoffMs: number;
  /** False for errors a retry can't fix (e.g. corrupt data). */
  retryable?: (e: unknown) => boolean;
}

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

/**
 * Whether a failed store read is worth trying again. Corrupt data and 4xx
 * responses come back the same every time (a missing object stays missing);
 * timeouts, network drops, throttling and 5xx usually don't. Status codes only
 * reach us inside icechunk-js's error messages ("…: 404 Not Found", "HTTP 503
 * …"), so they are read from there.
 */
export function isTransientLoadError(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  if (e.name === "GribDecodeError") return false;
  const status = /(?:HTTP |: )([1-5]\d\d)\b/.exec(e.message)?.[1];
  if (!status) return true;
  const code = Number(status);
  return code >= 500 || code === 408 || code === 429;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` with a per-attempt abort signal that fires on timeout, retrying
 * failures with exponential backoff. Rethrows the last error.
 */
export async function withRetry<T>(fn: (signal: AbortSignal) => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (attempt > 0) await sleep(opts.backoffMs * 2 ** (attempt - 1));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race the call against the timer too, in case something below ignores
    // the signal: the queue slot must come back either way.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new TimeoutError(`timed out after ${opts.timeoutMs} ms`);
        controller.abort(e);
        reject(e);
      }, opts.timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } catch (e) {
      lastError = e;
      if (opts.retryable && !opts.retryable(e)) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
