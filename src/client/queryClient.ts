/**
 * @packageDocumentation
 * Shared TanStack Query client so the WebSocket reconnect path can invalidate
 * server-backed queries without importing the React entry point.
 */

import { QueryClient } from "@tanstack/react-query";

/** Application query client used by the React tree and reconnect reloads. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
