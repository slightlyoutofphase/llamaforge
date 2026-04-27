/**
 * @packageDocumentation
 * Tests for the message bubble component and attachment presentation.
 */

import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@shared/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { MessageBubble } from "../../src/client/components/chat/MessageBubble";

describe("MessageBubble Component", () => {
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

    expect(screen.queryByText('{"story": "raw json"}')).toBeNull();

    const button = screen.getByRole("button", { name: /Expand thinking trace/i });
    fireEvent.click(button);
    expect(screen.getByText('{"story": "raw json"}')).toBeTruthy();
  });
});
