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
