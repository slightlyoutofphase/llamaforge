/**
 * @packageDocumentation
 * Tests for the multimodal model-switch guard modal copy and actions.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MultimodalGuardModal } from "../../src/client/components/sidebar/MultimodalGuardModal";

describe("MultimodalGuardModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("explains a vision incompatibility and lists message positions", () => {
    const onClose = mock();
    const onNewChat = mock();
    render(
      <MultimodalGuardModal
        reason="vision"
        incompatibleMessages={[
          { id: "m1", position: 0 },
          { id: "m2", position: 3 },
        ]}
        onClose={onClose}
        onNewChat={onNewChat}
      />,
    );

    expect(screen.getByText(/does not support vision encoders/i)).toBeTruthy();
    expect(screen.getByText("Incompatible media found in message at position 1")).toBeTruthy();
    expect(screen.getByText("Incompatible media found in message at position 4")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancel switch/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /start new chat/i }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("explains combined vision and audio incompatibility and disables new chat while locked", () => {
    render(
      <MultimodalGuardModal
        reason="both"
        incompatibleMessages={[]}
        isNewChatDisabled
        onClose={() => {}}
        onNewChat={() => {}}
      />,
    );

    expect(screen.getByText(/does not support vision or audio encoders/i)).toBeTruthy();
    expect(screen.getByText("Multiple messages contain incompatible media.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /start new chat/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
