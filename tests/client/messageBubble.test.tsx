/**
 * @packageDocumentation
 * Tests for the message bubble component and attachment presentation.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ChatMessage } from "@shared/types";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MessageBubble } from "../../src/client/components/chat/MessageBubble";

describe("MessageBubble Component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders user messages with attachments", () => {
    const msg: ChatMessage = {
      id: "u1",
      chatId: "c1",
      role: "user",
      content: "Here is an image",
      rawContent: "Here is an image",
      position: 1,
      createdAt: 1,
      attachments: [
        {
          id: "a1",
          messageId: "u1",
          mimeType: "image/jpeg",
          filePath: "/test/image.jpg",
          fileName: "image.jpg",
          createdAt: 1,
        },
      ],
    };

    render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText("Here is an image")).toBeTruthy();
    expect(screen.getByAltText("image.jpg")).toBeTruthy(); // Attachments use filename as alt text
  });

  it("renders assistant messages with markdown", () => {
    const msg: ChatMessage = {
      id: "a1",
      chatId: "c1",
      role: "assistant",
      content: "**Bold text** and *italic*",
      rawContent: "**Bold text** and *italic*",
      position: 2,
      createdAt: 2,
    };

    const { container } = render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    // Markdown transforms "**Bold text**" into strong
    expect(container.querySelector("strong")?.textContent).toBe("Bold text");
    expect(container.querySelector("em")?.textContent).toBe("italic");
  });

  it("renders thinking content when present", () => {
    const msg: ChatMessage = {
      id: "a2",
      chatId: "c1",
      role: "assistant",
      content: "Final answer",
      rawContent: "Final answer",
      thinkingContent: "I am thinking",
      position: 3,
      createdAt: 3,
    };

    render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText("Final answer")).toBeTruthy();
    // Thinking block is collapsed by default.
    const button = screen.getByRole("button", { name: "Expand thinking trace" });
    expect(button).toBeTruthy();

    fireEvent.click(button);

    expect(screen.getByText("I am thinking")).toBeTruthy();
  });

  it("renders thinking above the assistant response and shows persisted response metrics", () => {
    const msg: ChatMessage = {
      id: "a2b",
      chatId: "c1",
      role: "assistant",
      content: "Final answer",
      rawContent: "Final answer",
      thinkingContent: "Reasoning first",
      position: 3,
      createdAt: 3,
      metrics: {
        predictedTokens: 48,
        tokensPerSecond: 22.4,
        promptTokens: 300,
        promptTokensPerSecond: 700,
        cachedPromptTokens: 120,
        evaluatedPromptTokens: 180,
      },
    };

    const view = render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    const thinkingButton = within(view.container).getByRole("button", {
      name: "Expand thinking trace",
    });
    const bubble = within(view.container).getByTestId("message-bubble-shell");
    expect(thinkingButton.compareDocumentPosition(bubble)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(view.container).getByText("22.4 tokens/sec")).toBeTruthy();
    expect(within(view.container).getByText("48 output tokens")).toBeTruthy();
    expect(within(view.container).getByText("Prompt cache reuse: 120 / 180 tokens")).toBeTruthy();

    const actions = within(view.container).getByTestId("message-actions");
    expect(actions.parentElement?.className).not.toContain("absolute");
    expect(view.container.querySelector('[data-testid="message-actions"]')).toBeTruthy();
  });

  it("falls back to rawContent when assistant content is empty and there is no thinking trace", () => {
    const msg: ChatMessage = {
      id: "a3",
      chatId: "c1",
      role: "assistant",
      content: "",
      rawContent: "Hello from raw content fallback",
      position: 4,
      createdAt: 4,
    };

    render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText("Hello from raw content fallback")).toBeTruthy();
  });

  it("does not render raw thinking JSON in the main assistant bubble", () => {
    const msg: ChatMessage = {
      id: "a4",
      chatId: "c1",
      role: "assistant",
      content: "",
      rawContent: '<think>{"story": "raw json"}</think>',
      thinkingContent: '{"story": "raw json"}',
      position: 5,
      createdAt: 5,
    };

    const view = render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(within(view.container).queryByText('{"story": "raw json"}')).toBeNull();

    const button = within(view.container).getByRole("button", {
      name: /Expand thinking trace/i,
    });
    fireEvent.click(button);
    expect(within(view.container).getByText('{"story": "raw json"}')).toBeTruthy();
  });

  it("applies the requested bubble style", () => {
    const msg: ChatMessage = {
      id: "u2",
      chatId: "c1",
      role: "user",
      content: "Styled message",
      rawContent: "Styled message",
      position: 6,
      createdAt: 6,
    };

    render(
      <MessageBubble
        bubbleStyle="compact"
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    const bubble = screen.getAllByTestId("message-bubble-shell").at(-1);
    expect(bubble).toBeTruthy();
    expect(bubble.getAttribute("data-bubble-style")).toBe("compact");
  });

  it("renders assistant messages even when toolCallsJson is malformed", () => {
    const msg: ChatMessage = {
      id: "a5",
      chatId: "c1",
      role: "assistant",
      content: "Safe render",
      rawContent: "Safe render",
      toolCallsJson: "{broken",
      position: 7,
      createdAt: 7,
    };

    render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(screen.getByText("Safe render")).toBeTruthy();
  });

  it("rerenders when assistant metrics arrive after the initial render", () => {
    const baseMessage: ChatMessage = {
      id: "a6",
      chatId: "c1",
      role: "assistant",
      content: "Streaming response",
      rawContent: "Streaming response",
      position: 8,
      createdAt: 8,
    };

    const view = render(
      <MessageBubble
        message={baseMessage}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(within(view.container).queryByText("16 output tokens")).toBeNull();

    view.rerender(
      <MessageBubble
        message={{
          ...baseMessage,
          metrics: {
            predictedTokens: 16,
            tokensPerSecond: 8.5,
            promptTokens: 120,
            promptTokensPerSecond: 60,
            cachedPromptTokens: 40,
            evaluatedPromptTokens: 80,
          },
        }}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(within(view.container).getByText("16 output tokens")).toBeTruthy();
    expect(within(view.container).getByText("8.5 tokens/sec")).toBeTruthy();
  });

  it("rerenders when attachments change without changing message text", () => {
    const baseMessage: ChatMessage = {
      id: "u3",
      chatId: "c1",
      role: "user",
      content: "Same text",
      rawContent: "Same text",
      position: 9,
      createdAt: 9,
    };

    const view = render(
      <MessageBubble
        message={baseMessage}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(within(view.container).queryByAltText("updated-image.png")).toBeNull();

    view.rerender(
      <MessageBubble
        message={{
          ...baseMessage,
          attachments: [
            {
              id: "attachment-1",
              messageId: "u3",
              mimeType: "image/png",
              filePath: "/files/updated-image.png",
              fileName: "updated-image.png",
              createdAt: 9,
            },
          ],
        }}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(within(view.container).getByAltText("updated-image.png")).toBeTruthy();
  });
});
