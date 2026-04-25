/**
 * @packageDocumentation
 * Defines the client-side routing structure using @tanstack/react-router.
 */

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import App from "../App";
import { ChatView } from "../components/chat/ChatView";
import { ModelSelector } from "../ModelSelector";

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

const routeTree = rootRoute.addChildren([modelsRoute, chatRoute]);

/**
 * The main application router instance.
 */
export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
