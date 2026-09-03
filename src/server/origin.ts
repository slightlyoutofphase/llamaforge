/**
 * @packageDocumentation
 * Origin and Host checks for WebSocket upgrades and mutating HTTP routes.
 *
 * LlamaForge is a single-user local app. These checks stop other websites from
 * driving the local API or subscribing to the log/token WebSocket.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Returns whether a hostname refers to the loopback interface.
 *
 * @param hostname - Hostname from a URL or Host header, without a port.
 * @returns `true` when the host is localhost or a loopback address.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

/**
 * Reads the hostname from an Origin header value.
 *
 * @param origin - Raw Origin header, such as `http://127.0.0.1:3000`.
 * @returns The origin hostname, or `null` when the header is missing or not a valid URL.
 */
export function parseOriginHostname(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Reads the hostname the request was addressed to.
 *
 * @param req - Incoming HTTP request.
 * @returns Hostname from the request URL.
 */
export function getRequestHostname(req: Request): string {
  try {
    return new URL(req.url).hostname;
  } catch {
    return "";
  }
}

/**
 * Returns whether an Origin is allowed to talk to this request's host.
 *
 * Loopback pages may call a loopback server. LAN pages may call the same host
 * they were loaded from (used when the user opts into a non-loopback bind).
 *
 * @param originHostname - Hostname parsed from the Origin header.
 * @param requestHostname - Hostname the request was sent to.
 * @returns `true` when the origin is allowed.
 */
export function isAllowedOriginHost(originHostname: string, requestHostname: string): boolean {
  const originHost = originHostname.trim().toLowerCase();
  const requestHost = requestHostname.trim().toLowerCase();
  if (!originHost || !requestHost) return false;
  if (isLoopbackHostname(originHost) && isLoopbackHostname(requestHost)) {
    return true;
  }
  return originHost === requestHost;
}

/**
 * Validates the Origin header for a WebSocket upgrade.
 *
 * Browsers always send Origin on WebSocket handshakes. Missing or unexpected
 * origins are rejected so a third-party page cannot subscribe to `/ws`.
 *
 * @param req - Incoming upgrade request.
 * @returns `true` when the upgrade may proceed.
 */
export function isAllowedWebSocketOrigin(req: Request): boolean {
  const originHostname = parseOriginHostname(req.headers.get("Origin"));
  if (!originHostname) return false;
  return isAllowedOriginHost(originHostname, getRequestHostname(req));
}

/**
 * Validates the Origin header for state-changing HTTP API routes.
 *
 * Same-origin browser requests send Origin. Non-browser clients (tests, curl)
 * talking to loopback often omit it; those are allowed only when the request
 * host itself is loopback.
 *
 * @param req - Incoming HTTP request.
 * @returns `true` when the mutation may proceed.
 */
export function isAllowedMutationOrigin(req: Request): boolean {
  const originHeader = req.headers.get("Origin");
  const requestHostname = getRequestHostname(req);

  if (!originHeader) {
    return isLoopbackHostname(requestHostname);
  }

  const originHostname = parseOriginHostname(originHeader);
  if (!originHostname) return false;
  return isAllowedOriginHost(originHostname, requestHostname);
}

/**
 * Returns whether an HTTP method can change server state.
 *
 * @param method - HTTP method string.
 * @returns `true` for POST, PUT, PATCH, and DELETE.
 */
export function isMutatingMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return (
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE"
  );
}
