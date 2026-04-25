import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsPanel } from "../../src/client/SettingsPanel";

const queryClient = new QueryClient();

const mockSettings = {
  llamaServerPath: "/usr/bin/llama-server",
  modelsPath: "/home/user/models",
  theme: "dark",
  autonameEnabled: true,
  fontSize: 16,
};

describe("SettingsPanel", () => {
  beforeEach(() => {
    global.fetch = mock((url) => {
      if (typeof url === "string" && url.includes("/api/settings")) {
        return Promise.resolve(new Response(JSON.stringify(mockSettings)));
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders settings fields with initial values", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("/usr/bin/llama-server")).toBeDefined();
    expect(screen.getByDisplayValue("/home/user/models")).toBeDefined();
    expect((screen.getByLabelText("Autoname Chats") as HTMLInputElement).checked).toBe(true);

    const fontSizeInput = screen.getByLabelText("Font Size (px)");
    expect((fontSizeInput as HTMLInputElement).value).toBe("16");
  });

  it("handles input changes and save button interaction", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPanel />
      </QueryClientProvider>,
    );

    const llamaInput = await screen.findByDisplayValue("/usr/bin/llama-server");
    fireEvent.change(llamaInput, { target: { value: "/new/path" } });
    expect((llamaInput as HTMLInputElement).value).toBe("/new/path");

    const saveBtn = screen.getByText("Save Settings");
    expect(saveBtn).toBeDefined();
    fireEvent.click(saveBtn);
    // Ideally verify mutation call, but mock.module and bun:test mock interactions can be tricky with complex hooks
  });
});
