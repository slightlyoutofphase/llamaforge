/**
 * @packageDocumentation
 * Tests for the chat input bar behavior.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let lastOnDrop: ((acceptedFiles: File[]) => void) | undefined;
let lastOnDropRejected:
  ((rejections: { file: File; errors: { code: string }[] }[]) => void) | undefined;

mock.module("react-dropzone", () => ({
  useDropzone: ({
    onDrop,
    onDropRejected,
  }: {
    onDrop: (acceptedFiles: File[]) => void;
    onDropRejected?: (rejections: { file: File; errors: { code: string }[] }[]) => void;
  }) => {
    lastOnDrop = onDrop;
    lastOnDropRejected = onDropRejected;
    return {
      getRootProps: () => ({}),
      getInputProps: () => ({}),
      isDragActive: false,
      open: () => {},
    };
  },
}));

import { InputBar } from "../../src/client/components/chat/InputBar";
import { useAppStore } from "../../src/client/store";

/** {@link InputBar} send callback used by these tests. */
type SendHandler = (content: string, files: File[]) => void | Promise<void>;

describe("InputBar Component", () => {
  beforeEach(() => {
    mock.restore();
    lastOnDrop = undefined;
    lastOnDropRejected = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it("calls onStop when the stop button is clicked during generation", () => {
    const onSend = mock();
    const onStop = mock();

    render(<InputBar onSend={onSend} isGenerating={true} isActive={true} onStop={onStop} />);

    const buttons = screen.getAllByRole("button");
    const stopButton = buttons[buttons.length - 1];
    expect(stopButton).toBeDefined();
    if (!stopButton) {
      throw new Error("expected a stop button");
    }
    fireEvent.click(stopButton);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends a message when not generating and input is provided", () => {
    const onSend = mock();
    const onStop = mock();

    render(<InputBar onSend={onSend} isGenerating={false} isActive={true} onStop={onStop} />);

    const textarea = screen.getByPlaceholderText("Type your message...");
    const buttons = screen.getAllByRole("button");
    const sendButton = buttons[buttons.length - 1];
    expect(sendButton).toBeDefined();
    if (!sendButton) {
      throw new Error("expected a send button");
    }

    fireEvent.change(textarea, { target: { value: "Hello" } });
    return act(async () => {
      fireEvent.click(sendButton);
    }).then(() => {
      expect(onSend).toHaveBeenCalledWith("Hello", []);
      expect(onStop).not.toHaveBeenCalled();
    });
  });

  it("creates image preview URLs once and revokes them after send", async () => {
    const onSend = mock();
    const onStop = mock();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURLMock = mock((file: Blob | MediaSource) => `blob:${(file as File).name}`);
    const revokeObjectURLMock = mock();

    URL.createObjectURL = createObjectURLMock as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURLMock as typeof URL.revokeObjectURL;

    try {
      render(<InputBar onSend={onSend} isGenerating={false} isActive={true} onStop={onStop} />);

      const file = new File(["img"], "preview.png", { type: "image/png" });
      act(() => {
        lastOnDrop?.([file]);
      });

      expect(createObjectURLMock).toHaveBeenCalledTimes(1);
      expect(screen.getByAltText("preview.png")).toBeTruthy();

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.change(textarea, { target: { value: "Describe this" } });
      expect(createObjectURLMock).toHaveBeenCalledTimes(1);

      const buttons = screen.getAllByRole("button");
      const sendButton = buttons[buttons.length - 1];
      expect(sendButton).toBeDefined();
      if (!sendButton) {
        throw new Error("expected a send button");
      }
      await act(async () => {
        fireEvent.click(sendButton);
      });

      expect(onSend).toHaveBeenCalledWith("Describe this", [file]);
      expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:preview.png");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  it("keeps attachments mounted until an async send completes", async () => {
    let resolveSend: (() => void) | undefined;
    const onSend = mock<SendHandler>(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const onStop = mock();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURLMock = mock((file: Blob | MediaSource) => `blob:${(file as File).name}`);
    const revokeObjectURLMock = mock();

    URL.createObjectURL = createObjectURLMock as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURLMock as typeof URL.revokeObjectURL;

    try {
      render(<InputBar onSend={onSend} isGenerating={false} isActive={true} onStop={onStop} />);

      const file = new File(["img"], "delayed.png", { type: "image/png" });
      act(() => {
        lastOnDrop?.([file]);
      });

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.change(textarea, { target: { value: "Wait for send" } });

      const buttons = screen.getAllByRole("button");
      const sendButton = buttons[buttons.length - 1];
      expect(sendButton).toBeDefined();
      if (!sendButton) {
        throw new Error("expected a send button");
      }
      await act(async () => {
        fireEvent.click(sendButton);
        await Promise.resolve();
      });

      expect(onSend).toHaveBeenCalledTimes(1);
      const firstCall = onSend.mock.calls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall?.[0]).toBe("Wait for send");
      expect(firstCall?.[1]).toHaveLength(1);
      expect(firstCall?.[1]?.[0]?.name).toBe(file.name);
      expect(firstCall?.[1]?.[0]?.type).toBe(file.type);
      expect(screen.getByAltText("delayed.png")).toBeTruthy();
      expect((textarea as HTMLTextAreaElement).value).toBe("Wait for send");
      expect(revokeObjectURLMock).not.toHaveBeenCalled();

      await act(async () => {
        resolveSend?.();
        await Promise.resolve();
      });

      expect(screen.queryByAltText("delayed.png")).toBeNull();
      expect(
        (screen.getByPlaceholderText("Type your message...") as HTMLTextAreaElement).value,
      ).toBe("");
      expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:delayed.png");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  it("discards unsent text and attachments when the conversation identity changes", async () => {
    const onSend = mock();
    const onStop = mock();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURLMock = mock((file: Blob | MediaSource) => `blob:${(file as File).name}`);
    const revokeObjectURLMock = mock();

    URL.createObjectURL = createObjectURLMock as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURLMock as typeof URL.revokeObjectURL;

    try {
      const view = render(
        <InputBar
          conversationId="chat-a"
          onSend={onSend}
          isGenerating={false}
          isActive={true}
          onStop={onStop}
        />,
      );

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.change(textarea, { target: { value: "Draft for chat A" } });

      const file = new File(["img"], "chat-a.png", { type: "image/png" });
      act(() => {
        lastOnDrop?.([file]);
      });
      expect(screen.getByAltText("chat-a.png")).toBeTruthy();

      view.rerender(
        <InputBar
          conversationId="chat-b"
          onSend={onSend}
          isGenerating={false}
          isActive={true}
          onStop={onStop}
        />,
      );

      expect(
        (screen.getByPlaceholderText("Type your message...") as HTMLTextAreaElement).value,
      ).toBe("");
      expect(screen.queryByAltText("chat-a.png")).toBeNull();
      expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:chat-a.png");
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  it("does not send while history is locked", async () => {
    const onSend = mock();
    const onStop = mock();
    render(
      <InputBar
        onSend={onSend}
        isGenerating={false}
        isActive={true}
        historyLocked={true}
        onStop={onStop}
      />,
    );

    expect(screen.getByPlaceholderText("Updating chat history...")).toBeTruthy();
    const sendButton = screen.getAllByRole("button").at(-1);
    if (!sendButton) throw new Error("expected a send button");
    fireEvent.click(sendButton);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("reports an error when a dropped file is larger than 10MB", () => {
    useAppStore.setState({ errorMessage: null });
    render(<InputBar onSend={mock()} isGenerating={false} isActive={true} onStop={mock()} />);
    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 8)], "huge.mp4", {
      type: "video/mp4",
    });
    act(() => {
      lastOnDrop?.([oversized]);
    });
    expect(useAppStore.getState().errorMessage).toBe("Attachments must be 10MB or smaller.");
  });

  it("does not send when Enter is pressed during IME composition", () => {
    const onSend = mock();
    render(<InputBar onSend={onSend} isGenerating={false} isActive={true} onStop={mock()} />);
    const textarea = screen.getByPlaceholderText("Type your message...");
    fireEvent.change(textarea, { target: { value: "日本語" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the composer editable while a reply is generating", () => {
    render(<InputBar onSend={mock()} isGenerating={true} isActive={true} onStop={mock()} />);
    const textarea = screen.getByPlaceholderText("Type your message...") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: "next question" } });
    expect(textarea.value).toBe("next question");
  });

  it("renders a video preview instead of an image for video attachments", () => {
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = mock(() => "blob:clip.mp4") as typeof URL.createObjectURL;
    try {
      render(<InputBar onSend={mock()} isGenerating={false} isActive={true} onStop={mock()} />);
      act(() => {
        lastOnDrop?.([new File(["video"], "clip.mp4", { type: "video/mp4" })]);
      });
      expect(screen.getByLabelText("clip.mp4").tagName).toBe("VIDEO");
      expect(screen.queryByRole("img", { name: "clip.mp4" })).toBeNull();
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
    }
  });

  it("reports files the composer will not accept", () => {
    useAppStore.setState({ errorMessage: null });
    render(<InputBar onSend={mock()} isGenerating={false} isActive={true} onStop={mock()} />);
    act(() => {
      lastOnDropRejected?.([
        {
          file: new File(["{}"], "notes.json", { type: "application/json" }),
          errors: [{ code: "file-invalid-type" }],
        },
      ]);
    });
    expect(useAppStore.getState().errorMessage).toContain("notes.json");
  });
});
