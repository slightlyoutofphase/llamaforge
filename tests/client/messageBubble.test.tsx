/**
 * @packageDocumentation
 * Tests for the message bubble component and attachment presentation.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ChatMessage } from "@shared/types";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import {
  MessageBubble,
  resolveEditableMessageContent,
  resolveVideoAttachmentSrc,
} from "../../src/client/components/chat/MessageBubble";
import { useAppStore } from "../../src/client/store";
import { THINKING_TRACE_BODY_CLASS } from "../../src/shared/thinkingDisplay";

describe("MessageBubble Component", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ isGenerating: false });
  });

  it("omits video file URLs while a generation is reading the same path", () => {
    expect(resolveVideoAttachmentSrc("attachments/c1/m1/clip.mp4", true)).toBeUndefined();
    expect(resolveVideoAttachmentSrc("attachments/c1/m1/clip.mp4", false)).toBe(
      "/api/attachments/attachments/c1/m1/clip.mp4",
    );
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

  it("hides extracted video soundtracks that were not user-attached audio", () => {
    const msg: ChatMessage = {
      id: "u1",
      chatId: "c1",
      role: "user",
      content: "Watch this",
      rawContent: "Watch this",
      position: 1,
      createdAt: 1,
      attachments: [
        {
          id: "v1",
          messageId: "u1",
          mimeType: "video/mp4",
          filePath: "attachments/c1/m1/clip.mp4",
          fileName: "clip.mp4",
          createdAt: 1,
        },
        {
          id: "a1",
          messageId: "u1",
          mimeType: "audio/wav",
          filePath: "attachments/c1/m1/clip.extracted-audio.wav",
          fileName: "clip.extracted-audio.wav",
          createdAt: 2,
        },
      ],
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

    expect(container.querySelector("video")).toBeTruthy();
    expect(container.querySelector("audio")).toBeNull();
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

  it("keeps the thinking timer live only until visible answer text arrives", () => {
    const thinkingMsg: ChatMessage = {
      id: "a-live",
      chatId: "c1",
      role: "assistant",
      content: "",
      rawContent: "<think>plan",
      thinkingContent: "plan",
      position: 2,
      createdAt: 2,
    };

    const liveView = render(
      <MessageBubble
        message={thinkingMsg}
        isStreaming={true}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(within(liveView.container).getByText("Thinking")).toBeTruthy();
    liveView.unmount();

    const answeringView = render(
      <MessageBubble
        message={{ ...thinkingMsg, content: "Final answer", rawContent: "Final answer" }}
        isStreaming={true}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(within(answeringView.container).queryByText("Thinking")).toBeNull();
    expect(within(answeringView.container).getByText("Thinking trace")).toBeTruthy();
    expect(
      within(answeringView.container).getByTestId("message-bubble-shell").textContent,
    ).toContain("Final answer");
  });

  it("labels a completed thinking block with thought duration and LM Studio stop-reason pills", () => {
    const msg: ChatMessage = {
      id: "a-think-done",
      chatId: "c1",
      role: "assistant",
      content: "Final answer",
      rawContent: "Final answer",
      thinkingContent: "Reasoning first",
      position: 3,
      createdAt: 3,
      metrics: {
        predictedTokens: 548,
        tokensPerSecond: 57.68,
        promptTokens: 20,
        promptTokensPerSecond: 200,
        cachedPromptTokens: 0,
        evaluatedPromptTokens: 20,
        generationMs: 130,
        thinkingDurationMs: 3200,
        stopReason: "eos",
        draftTokens: 80,
        draftTokensAccepted: 45,
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

    expect(within(view.container).getByText("Thought for 3.2 seconds")).toBeTruthy();
    expect(within(view.container).getByText("57.68 tok/sec")).toBeTruthy();
    expect(within(view.container).getByText("548 tokens")).toBeTruthy();
    expect(within(view.container).getByText("0.13s")).toBeTruthy();
    expect(within(view.container).getByText("Stop reason: EOS Token Found")).toBeTruthy();
    expect(within(view.container).getByText("56.3% draft tokens accepted")).toBeTruthy();
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
    expect(within(view.container).getByText("22.40 tok/sec")).toBeTruthy();
    expect(within(view.container).getByText("48 tokens")).toBeTruthy();
    expect(within(view.container).getByText("Prompt cache: 120 / 180")).toBeTruthy();

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
    expect(bubble?.getAttribute("data-bubble-style")).toBe("compact");
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

    expect(within(view.container).getByText("16 tokens")).toBeTruthy();
    expect(within(view.container).getByText("8.50 tok/sec")).toBeTruthy();
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

  it("does not point the video player at the attachment file while generating", () => {
    const msg: ChatMessage = {
      id: "u-video",
      chatId: "c1",
      role: "user",
      content: "what does this video show?",
      rawContent: "what does this video show?",
      position: 1,
      createdAt: 1,
      attachments: [
        {
          id: "v1",
          messageId: "u-video",
          mimeType: "video/mp4",
          filePath: "attachments/c1/u-video/clip.mp4",
          fileName: "clip.mp4",
          createdAt: 1,
        },
      ],
    };

    useAppStore.setState({ isGenerating: true });
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
    const generatingPlayer = view.container.querySelector("video");
    expect(generatingPlayer).toBeTruthy();
    expect(generatingPlayer?.hasAttribute("src")).toBe(false);
    expect(generatingPlayer?.getAttribute("preload")).toBe("none");

    act(() => {
      useAppStore.setState({ isGenerating: false });
    });
    const idlePlayer = view.container.querySelector("video");
    expect(idlePlayer?.getAttribute("src")).toBe(
      "/api/attachments/attachments/c1/u-video/clip.mp4",
    );
  });

  it("renders thinking traces as compact markdown without pre-wrap gaps", () => {
    const msg: ChatMessage = {
      id: "a-think-gaps",
      chatId: "c1",
      role: "assistant",
      content: "Hello!",
      rawContent: "Hello!",
      thinkingContent: [
        "Thinking Process:",
        "",
        "",
        "",
        "",
        "Analyze the Input:",
        "",
        "",
        'Input: "hello."',
        "",
        "Language: English (implied by the content).",
      ].join("\n"),
      position: 10,
      createdAt: 10,
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

    fireEvent.click(within(view.container).getByRole("button", { name: "Expand thinking trace" }));

    const trace = within(view.container).getByTestId("thinking-trace");
    expect(trace.className.split(/\s+/)).toContain(THINKING_TRACE_BODY_CLASS);
    expect(trace.className).not.toContain("whitespace-pre-wrap");

    const paragraphs = [...trace.querySelectorAll("p")].map((node) => node.textContent);
    expect(paragraphs).toEqual([
      "Thinking Process:",
      "Analyze the Input:",
      'Input: "hello."',
      "Language: English (implied by the content).",
    ]);
    expect(trace.querySelectorAll("p")).toHaveLength(4);
  });

  it("keeps markdown headings inside thinking traces compact instead of pre-wrapped", () => {
    const msg: ChatMessage = {
      id: "a-think-headings",
      chatId: "c1",
      role: "assistant",
      content: "Hello!",
      rawContent: "Hello!",
      thinkingContent: "## Thinking Process\n\n### Analyze the Input\n\nHello.",
      position: 10,
      createdAt: 10,
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

    fireEvent.click(within(view.container).getByRole("button", { name: "Expand thinking trace" }));
    const trace = within(view.container).getByTestId("thinking-trace");
    expect(trace.querySelector("h2")?.textContent).toBe("Thinking Process");
    expect(trace.querySelector("h3")?.textContent).toBe("Analyze the Input");
    expect(trace.querySelector("p")?.textContent).toBe("Hello.");
    expect(trace.className).not.toContain("whitespace-pre-wrap");
  });

  it("still renders markdown emphasis inside thinking traces", () => {
    const msg: ChatMessage = {
      id: "a-think-md",
      chatId: "c1",
      role: "assistant",
      content: "Done",
      rawContent: "Done",
      thinkingContent: "**Step 1:** greet the user",
      position: 11,
      createdAt: 11,
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

    fireEvent.click(within(view.container).getByRole("button", { name: "Expand thinking trace" }));
    expect(view.container.querySelector("[data-testid='thinking-trace'] strong")?.textContent).toBe(
      "Step 1:",
    );
  });

  it("seeds the edit textarea from content that arrived after the bubble first mounted", () => {
    const baseMessage: ChatMessage = {
      id: "a-edit-late",
      chatId: "c1",
      role: "assistant",
      content: "",
      rawContent: "",
      thinkingContent: "planning the greeting",
      position: 12,
      createdAt: 12,
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

    view.rerender(
      <MessageBubble
        message={{
          ...baseMessage,
          content: "Hello! How can I help you today?",
          rawContent: "Hello! How can I help you today?",
        }}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(within(view.container).getByTitle("Edit"));
    const textarea = within(view.container).getByTestId(
      "message-edit-textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Hello! How can I help you today?");
  });

  it("seeds the edit textarea for user messages whose text arrived after mount", () => {
    const baseMessage: ChatMessage = {
      id: "u-edit-late",
      chatId: "c1",
      role: "user",
      content: "",
      rawContent: "",
      position: 13,
      createdAt: 13,
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

    view.rerender(
      <MessageBubble
        message={{ ...baseMessage, content: "hello.", rawContent: "hello." }}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(within(view.container).getByTitle("Edit"));
    const textarea = within(view.container).getByTestId(
      "message-edit-textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello.");
  });

  it("keeps existing text in the editor after cancel and edit again", () => {
    const msg: ChatMessage = {
      id: "u-edit-again",
      chatId: "c1",
      role: "user",
      content: "already here",
      rawContent: "already here",
      position: 14,
      createdAt: 14,
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

    fireEvent.click(within(view.container).getByTitle("Edit"));
    fireEvent.click(within(view.container).getByRole("button", { name: /cancel/i }));
    fireEvent.click(within(view.container).getByTitle("Edit"));
    const textarea = within(view.container).getByTestId(
      "message-edit-textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("already here");
  });

  it("lets a user message generate a model reply after the assistant response is gone", () => {
    const onRegenerate = mock(() => {});
    const msg: ChatMessage = {
      id: "u-pending",
      chatId: "c1",
      role: "user",
      content: "hello.",
      rawContent: "hello.",
      position: 1,
      createdAt: 1,
    };

    const view = render(
      <MessageBubble
        message={msg}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={onRegenerate}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    const generateBtn = within(view.container).getByTitle("Generate response");
    expect(generateBtn).toBeTruthy();
    expect(within(view.container).queryByTitle("Continue generation")).toBeNull();

    fireEvent.click(generateBtn);
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(onRegenerate).toHaveBeenCalledWith("u-pending");
  });

  it("hides generate on a user message while a completion is already in flight", () => {
    useAppStore.setState({ isGenerating: true });
    const view = render(
      <MessageBubble
        message={{
          id: "u-busy",
          chatId: "c1",
          role: "user",
          content: "hello.",
          rawContent: "hello.",
          position: 1,
          createdAt: 1,
        }}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    expect(within(view.container).queryByTitle("Generate response")).toBeNull();
  });

  it("keeps regenerate on assistant messages", () => {
    const onRegenerate = mock(() => {});
    const view = render(
      <MessageBubble
        message={{
          id: "a-regen",
          chatId: "c1",
          role: "assistant",
          content: "Hi there.",
          rawContent: "Hi there.",
          position: 2,
          createdAt: 2,
        }}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={onRegenerate}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(within(view.container).getByTitle("Regenerate"));
    expect(onRegenerate).toHaveBeenCalledWith("a-regen");
  });

  it("invokes delete for assistant messages", () => {
    const onDelete = mock(() => {});
    const view = render(
      <MessageBubble
        message={{
          id: "a-del",
          chatId: "c1",
          role: "assistant",
          content: "Hi there.",
          rawContent: "Hi there.",
          position: 2,
          createdAt: 2,
        }}
        onEdit={() => {}}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={onDelete}
      />,
    );

    fireEvent.click(within(view.container).getByTitle("Delete this and subsequent"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("a-del");
  });

  it("resolves editable text from rawContent when the visible bubble is using that fallback", () => {
    expect(
      resolveEditableMessageContent({
        id: "a-raw",
        chatId: "c1",
        role: "assistant",
        content: "",
        rawContent: "Hello from raw content fallback",
        position: 15,
        createdAt: 15,
      }),
    ).toBe("Hello from raw content fallback");

    expect(
      resolveEditableMessageContent({
        id: "a-think-empty",
        chatId: "c1",
        role: "assistant",
        content: "",
        rawContent: "<think>secret</think>",
        thinkingContent: "secret",
        position: 16,
        createdAt: 16,
      }),
    ).toBe("");
  });

  it("calls onEdit with trimmed text and stays in edit mode until save resolves", async () => {
    let finishSave: (() => void) | undefined;
    const onEdit = mock(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const msg: ChatMessage = {
      id: "u-save",
      chatId: "c1",
      role: "user",
      content: "original",
      rawContent: "original",
      position: 20,
      createdAt: 20,
    };

    render(
      <MessageBubble
        message={msg}
        onEdit={onEdit}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(screen.getByTitle("Edit"));
    fireEvent.change(screen.getByTestId("message-edit-textarea"), {
      target: { value: "  updated prompt  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onEdit).toHaveBeenCalledWith("u-save", "updated prompt");
    expect(screen.getByTestId("message-edit-textarea")).toBeTruthy();

    await act(async () => {
      finishSave?.();
    });
    expect(screen.queryByTestId("message-edit-textarea")).toBeNull();
  });

  it("does not call onEdit when only surrounding whitespace changed", () => {
    const onEdit = mock(() => {});
    const msg: ChatMessage = {
      id: "u-ws",
      chatId: "c1",
      role: "user",
      content: "same text",
      rawContent: "same text",
      position: 21,
      createdAt: 21,
    };

    render(
      <MessageBubble
        message={msg}
        onEdit={onEdit}
        onBranch={() => {}}
        onRegenerate={() => {}}
        onContinue={() => {}}
        onDelete={() => {}}
      />,
    );

    fireEvent.click(screen.getByTitle("Edit"));
    fireEvent.change(screen.getByTestId("message-edit-textarea"), {
      target: { value: "  same text  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("message-edit-textarea")).toBeNull();
  });
});
