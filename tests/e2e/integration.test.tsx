import { beforeAll, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import * as React from "react";
import App from "../../src/client/App";

const queryClient = new QueryClient();

// Mock tanstack router so we don't need full Provider setup that fails in happy-dom headless
mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: any) => <a href="#test">{children}</a>,
  Outlet: () => <div data-testid="outlet">Mock Outlet</div>,
  useLocation: () => ({ pathname: "/" }),
}));

describe("E2E Integration", () => {
  beforeAll(() => {
    global.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/hardware")) {
        return Promise.resolve(
          new Response(JSON.stringify({ totalRamBytes: 0, cpuThreads: 0, gpus: [] })),
        );
      }
      if (url.includes("/api/server/status")) {
        return Promise.resolve(new Response(JSON.stringify({ status: "idle", config: null })));
      }
      return Promise.resolve(new Response(JSON.stringify([])));
    };
    global.WebSocket = class {
      onopen: any;
      onclose: any;
      onmessage: any;
      close() {}
      send() {}
    } as any;
  });

  it("mounts the root component directly and verifies it renders without errors", async () => {
    let container: HTMLElement | null = null;
    const act = (React as any).act || ((cb: any) => cb());
    await act(async () => {
      const result = render(
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>,
      );
      container = result.container;
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container).not.toBeNull();
    if (container) {
      expect((container as HTMLElement).textContent).toContain("LF");
    }
  });
});
