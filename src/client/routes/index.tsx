/**
 * @packageDocumentation
 * Defines the client-side routing structure using @tanstack/react-router.
 */

import { createRootRoute, createRoute, createRouter, Link } from "@tanstack/react-router";
import App from "../App";
import { ChatView } from "../components/chat/ChatView";
import { ModelSelector } from "../ModelSelector";

/**
 * Displays a route-level fallback UI when TanStack Router surfaces an error.
 *
 * @param props - Error boundary props containing the routed error.
 * @returns The rendered error state for the current route.
 */
function ErrorFallback({ error }: { error: unknown }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="rounded border border-red-500 bg-red-500/10 p-6 text-red-500">
        <h2 className="mb-2 text-lg font-semibold">Application Error</h2>
        <pre className="text-sm">{error instanceof Error ? error.message : String(error)}</pre>
      </div>
    </div>
  );
}

/**
 * Base root route for the application.
 */
export const rootRoute = createRootRoute({
  component: () => <App />,
  errorComponent: ErrorFallback,
});

/**
 * Home route displaying the model selector.
 */
export const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ModelSelector,
  errorComponent: ErrorFallback,
});

/**
 * Chat route displaying a specific chat session given its ID.
 */
export const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$chatId",
  component: ChatView,
  errorComponent: ErrorFallback,
});

/**
 * Catch-all 404 route for unmatched paths.
 */
function NotFoundPage() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="max-w-md text-sm text-[var(--color-text-secondary)]">
        That path does not match a model registry or chat workspace route.
      </p>
      <Link
        to="/"
        className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white">
        Return to model registry
      </Link>
    </div>
  );
}

export const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "$",
  component: NotFoundPage,
  errorComponent: ErrorFallback,
});

const routeTree = rootRoute.addChildren([modelsRoute, chatRoute, notFoundRoute]);

/**
 * The main application router instance.
 */
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
