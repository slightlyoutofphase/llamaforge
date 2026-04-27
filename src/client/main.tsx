/**
 * @packageDocumentation
 * The primary entry point for the React application.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./routes/index";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import "./index.css";
import { logError } from "./logger";

const queryClient = new QueryClient();

const rootElement = document.getElementById("root");
if (!rootElement) {
  logError("Failed to find the root element.");
  throw new Error("Failed to find the root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
