import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { InputBar } from "../../src/client/components/chat/InputBar";

mock.module("react-dropzone", () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: () => ({}),
    isDragActive: false,
    open: () => {},
  }),
}));

describe("InputBar component", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders textarea correctly", async () => {
    render(<InputBar onSend={() => {}} onStop={() => {}} isActive={true} isGenerating={false} />);
    const textarea = await screen.findByPlaceholderText("Type your message...");
    expect(textarea).not.toBeNull();
  });
});
