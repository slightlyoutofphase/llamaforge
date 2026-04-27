/**
 * @packageDocumentation
 * Tests for the chat input bar behavior.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InputBar } from "../../src/client/components/chat/InputBar";

describe("InputBar Component", () => {
  beforeEach(() => {
    mock.restore();
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

    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.click(sendButton);

    expect(onSend).toHaveBeenCalledWith("Hello", []);
    expect(onStop).not.toHaveBeenCalled();
  });
});
