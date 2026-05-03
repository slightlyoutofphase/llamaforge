/**
 * @packageDocumentation
 * Client-side HTTP helpers with a production mutation fallback for browser runtimes.
 */

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

type ResponseLike = Pick<Response, "status" | "ok" | "text" | "json">;

function getRuntimeNodeEnv(): string | undefined {
  try {
    return (globalThis as any).process?.env?.NODE_ENV ?? (globalThis as any).Bun?.env?.NODE_ENV;
  } catch {
    return undefined;
  }
}

function shouldUseXhr(method: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (typeof XMLHttpRequest === "undefined") return false;
  return getRuntimeNodeEnv() !== "test";
}

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

function buildResponseLike(status: number, bodyText: string): ResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

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

export async function request(url: string, options: RequestOptions = {}): Promise<ResponseLike> {
  const method = (options.method ?? "GET").toUpperCase();
  if (shouldUseXhr(method)) {
    return xhrRequest(url, options);
  }

  const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
  return fetch(url, fetchOptions);
}
