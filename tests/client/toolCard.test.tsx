/**
 * @packageDocumentation
 * Tests for tool-call cards, including argument editing after delayed payloads.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ChatMessage } from "@shared/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolCard } from "../../src/client/components/chat/ToolCard";
import { useAppStore } from "../../src/client/store";
import { asFetch } from "../fixtures";

const assistantMessage: ChatMessage = {
  id: "asst-1",
  chatId: "c1",
  role: "assistant",
  content: "Using a tool",
  rawContent: "Using a tool",
  position: 1,
  createdAt: 1,
};

/**
 * Enables the ToolCard action row so Edit / Approve controls are visible.
 *
 * @returns No return value.
 */
function enableToolApproval() {
  useAppStore.setState({
    isWaitingForToolApproval: true,
    messages: [assistantMessage],
  });
}

describe("ToolCard", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({
      isWaitingForToolApproval: false,
      messages: [],
      notifications: [],
      currentChatId: null,
    });
  });

  it("shows arguments that arrived after the card first mounted", () => {
    enableToolApproval();
    const toolCall = {
      id: "tc-1",
      type: "function" as const,
      function: { name: "calculate", arguments: "" },
    };

    const view = render(
      <ToolCard messageId="asst-1" toolCall={toolCall} onApprove={() => {}} onReject={() => {}} />,
    );

    expect(screen.getByTestId("tool-args-preview").textContent).toBe("");

    view.rerender(
      <ToolCard
        messageId="asst-1"
        toolCall={{
          ...toolCall,
          function: { name: "calculate", arguments: '{"expression":"2+2"}' },
        }}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    expect(screen.getByTestId("tool-args-preview").textContent).toBe('{"expression":"2+2"}');
  });

  it("seeds the argument editor from the latest payload on first edit", () => {
    enableToolApproval();
    const toolCall = {
      id: "tc-1",
      type: "function" as const,
      function: { name: "calculate", arguments: "" },
    };

    const view = render(
      <ToolCard messageId="asst-1" toolCall={toolCall} onApprove={() => {}} onReject={() => {}} />,
    );

    view.rerender(
      <ToolCard
        messageId="asst-1"
        toolCall={{
          ...toolCall,
          function: { name: "calculate", arguments: '{"expression":"1+1"}' },
        }}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const editor = screen.getByTestId("tool-args-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe('{"expression":"1+1"}');
  });

  it("restores original arguments when argument editing is cancelled", () => {
    enableToolApproval();
    render(
      <ToolCard
        messageId="asst-1"
        toolCall={{
          id: "tc-1",
          type: "function",
          function: { name: "calculate", arguments: '{"expression":"2+2"}' },
        }}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByTestId("tool-args-editor"), {
      target: { value: '{"expression":"9+9"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel edit/i }));

    expect(screen.getByTestId("tool-args-preview").textContent).toBe('{"expression":"2+2"}');
  });

  it("shows a notification and keeps the buttons when approval fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetch(
      mock(
        async () =>
          new Response(JSON.stringify({ error: "No tool approval is pending." }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    useAppStore.setState({
      isWaitingForToolApproval: true,
      currentChatId: "c1",
      messages: [assistantMessage],
      notifications: [],
    });
    render(
      <ToolCard
        messageId="asst-1"
        toolCall={{
          id: "tc-1",
          type: "function",
          function: { name: "calculate", arguments: "{}" },
        }}
        onApprove={(id, args) => {
          void useAppStore.getState().approveToolCall("asst-1", id, true, args);
        }}
        onReject={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => {
      expect(
        useAppStore.getState().notifications.some((note) => note.message.includes("pending")),
      ).toBe(true);
    });
    expect(screen.getByRole("button", { name: /approve/i })).toBeDefined();
    expect(screen.getByText("Awaiting Action")).toBeDefined();
    globalThis.fetch = originalFetch;
  });
});
