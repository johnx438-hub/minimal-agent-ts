/** Unified abort source for runAgent (opts.signal takes precedence). */
export function resolveAbortSignal(
  optsSignal?: AbortSignal,
  configSignal?: AbortSignal,
): AbortSignal | undefined {
  return optsSignal ?? configSignal;
}

/**
 * Reject as soon as signal aborts — do not wait for in-flight parallel work.
 * Removes the abort listener when the wrapped promise settles.
 */
export function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort);

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}