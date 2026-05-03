/**
 * @packageDocumentation
 * Client-side HTTP helpers with a production mutation fallback for browser runtimes.
 */

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

type ResponseLike = Pick<Response, "status" | "ok" | "text" | "json">;

/**
 * Reads the current runtime environment name from the browser or Bun global scope.
 *
 * @returns The current `NODE_ENV` value when it can be resolved, or `undefined` otherwise.
 */
function getRuntimeNodeEnv(): string | undefined {
  try {
    return (globalThis as any).process?.env?.NODE_ENV ?? (globalThis as any).Bun?.env?.NODE_ENV;
  } catch {
    return undefined;
  }
}

/**
 * Determines whether a request should use the XMLHttpRequest mutation fallback.
 *
 * @param method - Normalized HTTP method for the outbound request.
 * @returns `true` when the request should avoid `fetch()` and use XHR instead.
 */
function shouldUseXhr(method: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (typeof XMLHttpRequest === "undefined") return false;
  return getRuntimeNodeEnv() !== "test";
}

/**
 * Converts supported header inputs into a mutable plain-object record.
 *
 * @param headers - Request headers supplied through the Fetch API shape.
 * @returns A plain object containing normalized header keys and values.
 */
function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * Builds a minimal response-like object for the XHR fallback path.
 *
 * @param status - HTTP status code reported by the XHR request.
 * @param bodyText - Raw response body text.
 * @returns A subset of the `Response` interface consumed by the client API layer.
 */
function buildResponseLike(status: number, bodyText: string): ResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

/**
 * Issues a browser request through `XMLHttpRequest` for mutation operations.
 *
 * @param url - Relative or absolute endpoint URL to request.
 * @param options - Request options including headers, body, and timeout overrides.
 * @returns A response-like object exposing the status and body readers used by the client.
 * @throws {Error} If the request fails, times out, or is aborted.
 */
async function xhrRequest(url: string, options: RequestOptions): Promise<ResponseLike> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = normalizeHeaders(options.headers);
  const timeoutMs = options.timeoutMs ?? 60000;

  return new Promise<ResponseLike>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = timeoutMs;

    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    xhr.onload = () => {
      resolve(buildResponseLike(xhr.status, xhr.responseText ?? ""));
    };
    xhr.onerror = () => {
      reject(new Error(`XHR request failed for ${method} ${url}`));
    };
    xhr.ontimeout = () => {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
      timeoutError.name = "TimeoutError";
      reject(timeoutError);
    };
    xhr.onabort = () => {
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      reject(abortError);
    };

    xhr.send((options.body as XMLHttpRequestBodyInit | null | undefined) ?? null);
  });
}

/**
 * Sends an HTTP request to the backend using `fetch()` or the XHR mutation fallback.
 *
 * @param url - Relative or absolute endpoint URL to request.
 * @param options - Request options including method, headers, body, and timeout override.
 * @returns A response-like object exposing status, `text()`, and `json()` readers.
 * @throws {Error} If the XHR fallback fails, times out, or is aborted.
 * @example
 * ```ts
 * const response = await request("/api/settings", {
 *   method: "PUT",
 *   headers: { "Content-Type": "application/json" },
 *   body: JSON.stringify({ theme: "system" }),
 * });
 * ```
 */
export async function request(url: string, options: RequestOptions = {}): Promise<ResponseLike> {
  const method = (options.method ?? "GET").toUpperCase();
  if (shouldUseXhr(method)) {
    return xhrRequest(url, options);
  }

  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  return fetch(url, fetchOptions);
}
