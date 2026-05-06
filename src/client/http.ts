/**
 * @packageDocumentation
 * Client-side HTTP helpers with consistent fetch-based timeout handling.
 */

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

/**
 * Builds a normalized timeout error for request cancellations triggered by the helper.
 *
 * @param timeoutMs - Timeout budget in milliseconds.
 * @returns Error instance tagged with the `TimeoutError` name.
 */
function createTimeoutError(timeoutMs: number): Error {
  const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
  timeoutError.name = "TimeoutError";
  return timeoutError;
}

/**
 * Builds a normalized abort error for caller-initiated request cancellation.
 *
 * @returns Error instance tagged with the `AbortError` name.
 */
function createAbortError(): Error {
  const abortError = new Error("Request aborted");
  abortError.name = "AbortError";
  return abortError;
}

/**
 * Determines whether a timeout value should arm the helper's abort timer.
 *
 * @param timeoutMs - Requested timeout budget.
 * @returns `true` when the helper should enforce a timeout.
 */
function hasFiniteTimeout(timeoutMs: number): boolean {
  return Number.isFinite(timeoutMs) && timeoutMs > 0;
}

/**
 * Connects an external abort signal to an internal request controller.
 *
 * @param controller - Internal controller used for the outbound fetch.
 * @param signal - Optional caller-provided abort signal.
 * @returns Cleanup callback that detaches the external listener.
 */
function bindAbortSignal(
  controller: AbortController,
  signal: AbortSignal | null | undefined,
): () => void {
  if (!signal) return () => {};

  const abortRequest = () => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  if (signal.aborted) {
    abortRequest();
    return () => {};
  }

  signal.addEventListener("abort", abortRequest, { once: true });
  return () => {
    signal.removeEventListener("abort", abortRequest);
  };
}

/**
 * Normalizes fetch rejections back to the helper's stable timeout/abort error shapes.
 *
 * @param error - Error thrown by `fetch()`.
 * @param controller - Internal request controller.
 * @param signal - Optional caller-provided abort signal.
 * @param timeoutMs - Timeout budget in milliseconds.
 * @returns The error that should be rethrown.
 */
function normalizeFetchError(
  error: unknown,
  controller: AbortController,
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
): unknown {
  if (signal?.aborted) {
    return createAbortError();
  }

  if (controller.signal.aborted) {
    const reason = controller.signal.reason;
    if (reason instanceof Error && reason.name === "TimeoutError") {
      return reason;
    }
    if (hasFiniteTimeout(timeoutMs)) {
      return createTimeoutError(timeoutMs);
    }
  }

  return error;
}

/**
 * Sends an HTTP request to the backend using `fetch()` with timeout and abort support.
 *
 * @param url - Relative or absolute endpoint URL to request.
 * @param options - Request options including method, headers, body, and timeout override.
 * @returns Native fetch response object.
 * @throws {Error} If the request fails, times out, or is aborted.
 * @example
 * ```ts
 * const response = await request("/api/settings", {
 *   method: "PUT",
 *   headers: { "Content-Type": "application/json" },
 *   body: JSON.stringify({ theme: "system" }),
 * });
 * ```
 */
export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = 60000, signal, ...fetchOptions } = options;

  if (signal?.aborted) {
    throw createAbortError();
  }

  const controller = new AbortController();
  const unbindSignal = bindAbortSignal(controller, signal);
  const timeoutId = hasFiniteTimeout(timeoutMs)
    ? setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(createTimeoutError(timeoutMs));
        }
      }, timeoutMs)
    : null;

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } catch (error) {
    throw normalizeFetchError(error, controller, signal, timeoutMs);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    unbindSignal();
  }
}
