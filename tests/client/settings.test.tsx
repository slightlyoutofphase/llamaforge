/**
 * @packageDocumentation
 * Tests for the settings panel and application configuration flows.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAppStore } from "../../src/client/store";

const mockSettings = {
  llamaServerPath: "/usr/bin/llama-server",
  modelsPath: "/home/user/models",
  theme: "dark",
  autonameEnabled: true,
  fontSize: 16,
};

describe("SettingsPanel", () => {
  let SettingsPanel: typeof import("../../src/client/SettingsPanel").SettingsPanel;
  let updateSettingsMutate: ReturnType<typeof mock>;

  beforeEach(async () => {
    updateSettingsMutate = mock().mockImplementation(async (_data, options) => {
      if (options?.onSuccess) {
        options.onSuccess();
      }
      return undefined;
    });

    await mock.module("../../src/client/queries", () => ({
      useSettings: () => ({ data: mockSettings, isLoading: false }),
      useUpdateSettings: () => ({ mutate: updateSettingsMutate, isPending: false }),
    }));

    useAppStore.setState({ fetchModels: mock().mockResolvedValue(undefined) });

    const imported = await import("../../src/client/SettingsPanel");
    SettingsPanel = imported.SettingsPanel;
  });

  afterEach(() => {
    cleanup();
    mock.restore();
  });

  it("renders settings fields with initial values", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    expect(await screen.findByDisplayValue("/usr/bin/llama-server")).toBeDefined();
    expect(screen.getByDisplayValue("/home/user/models")).toBeDefined();
    expect((screen.getByLabelText("Autoname Chats") as HTMLInputElement).checked).toBe(true);

    const fontSizeInput = screen.getByLabelText("Font Size (px)");
    expect((fontSizeInput as HTMLInputElement).value).toBe("16");
  });

  it("handles input changes and save button interaction", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const llamaInput = await screen.findByDisplayValue("/usr/bin/llama-server");
    await act(async () => {
      fireEvent.change(llamaInput, { target: { value: "/new/path" } });
    });
    expect((llamaInput as HTMLInputElement).value).toBe("/new/path");

    const saveBtn = screen.getByText("Save Settings");
    expect(saveBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(updateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ llamaServerPath: "/new/path" }),
      expect.anything(),
    );
  });

  it("refreshes the model list after saving settings", async () => {
    const fetchModelsSpy = mock().mockResolvedValue(undefined);
    useAppStore.setState({ fetchModels: fetchModelsSpy });

    await act(async () => {
      render(<SettingsPanel />);
    });

    const modelsInput = await screen.findByDisplayValue("/home/user/models");
    await act(async () => {
      fireEvent.change(modelsInput, { target: { value: "/new/models" } });
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Save Settings"));
    });

    expect(updateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ modelsPath: "/new/models" }),
      expect.anything(),
    );
    expect(fetchModelsSpy).toHaveBeenCalled();
  });
});
