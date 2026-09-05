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

    useAppStore.setState({
      fetchModels: mock().mockResolvedValue(undefined),
      rescanModels: mock().mockResolvedValue(undefined),
    });

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
    expect(
      (screen.getByLabelText("Reload Last Used Model Automatically") as HTMLInputElement).checked,
    ).toBe(false);
    expect((screen.getByLabelText("Include Audio From Videos") as HTMLInputElement).checked).toBe(
      false,
    );

    const fontSizeInput = screen.getByRole("slider");
    expect((fontSizeInput as HTMLInputElement).value).toBe("16");
  });

  it("handles input changes and auto-saves after debounce", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const llamaInput = await screen.findByDisplayValue("/usr/bin/llama-server");
    await act(async () => {
      fireEvent.change(llamaInput, { target: { value: "/new/path" } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect((llamaInput as HTMLInputElement).value).toBe("/new/path");

    expect(updateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ llamaServerPath: "/new/path" }),
      expect.anything(),
    );
  });

  it("refreshes the model list after saving a new models path", async () => {
    const fetchModelsSpy = mock().mockResolvedValue(undefined);
    useAppStore.setState({ fetchModels: fetchModelsSpy });

    await act(async () => {
      render(<SettingsPanel />);
    });

    const modelsInput = await screen.findByDisplayValue("/home/user/models");
    await act(async () => {
      fireEvent.change(modelsInput, { target: { value: "/new/models" } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(updateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ modelsPath: "/new/models" }),
      expect.anything(),
    );
    expect(fetchModelsSpy).toHaveBeenCalled();
  });

  it("does not rescan models for unrelated settings changes", async () => {
    const fetchModelsSpy = mock().mockResolvedValue(undefined);
    useAppStore.setState({ fetchModels: fetchModelsSpy });

    await act(async () => {
      render(<SettingsPanel />);
    });

    const llamaInput = await screen.findByDisplayValue("/usr/bin/llama-server");
    await act(async () => {
      fireEvent.change(llamaInput, { target: { value: "/different/path" } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(fetchModelsSpy).not.toHaveBeenCalled();
  });

  it("saves includeVideoAudio when the video audio toggle is changed", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const toggle = screen.getByLabelText("Include Audio From Videos") as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await act(async () => {
      fireEvent.click(toggle);
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(toggle.checked).toBe(true);
    expect(updateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ includeVideoAudio: true }),
      expect.anything(),
    );
  });

  it("keeps freeform numeric fields local until they become valid numbers", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const serverPortInput = screen.getByLabelText("Bun Server Port") as HTMLInputElement;

    await act(async () => {
      fireEvent.change(serverPortInput, { target: { value: "" } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(serverPortInput.value).toBe("");
    expect(updateSettingsMutate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(serverPortInput, { target: { value: "12001" } });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(updateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ serverPort: 12001 }),
      expect.anything(),
    );
  });

  it("renders text inputs for llama-server and models paths", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    expect(screen.getByLabelText(/llama-server path/i)).toBeDefined();
    expect(screen.getByLabelText(/models root directory/i)).toBeDefined();
  });

  it("accepts a typed llama-server path", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const llamaInput = await screen.findByDisplayValue("/usr/bin/llama-server");
    await act(async () => {
      fireEvent.change(llamaInput, { target: { value: "/opt/bin/llama-server" } });
    });
    expect(await screen.findByDisplayValue("/opt/bin/llama-server")).toBeDefined();
  });

  it("accepts a typed models path", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const modelsInput = await screen.findByDisplayValue("/home/user/models");
    await act(async () => {
      fireEvent.change(modelsInput, { target: { value: "/data/models" } });
    });
    expect(await screen.findByDisplayValue("/data/models")).toBeDefined();
  });

  it("saves settings and triggers rescanModels when rescan button is clicked with a changed path", async () => {
    const rescanModelsSpy = mock().mockResolvedValue(undefined);
    useAppStore.setState({ rescanModels: rescanModelsSpy });

    await act(async () => {
      render(<SettingsPanel />);
    });

    const modelsInput = await screen.findByDisplayValue("/home/user/models");
    await act(async () => {
      fireEvent.change(modelsInput, { target: { value: "/updated/models" } });
    });

    const rescanButton = screen.getByRole("button", { name: /rescan models/i });
    expect(rescanButton).toBeDefined();

    await act(async () => {
      fireEvent.click(rescanButton);
    });

    expect(updateSettingsMutate).toHaveBeenCalledWith(
      expect.objectContaining({ modelsPath: "/updated/models" }),
      expect.anything(),
    );
    expect(rescanModelsSpy).toHaveBeenCalled();
  });

  it("rescan models button has active press visual feedback classes", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const rescanButton = screen.getByRole("button", { name: /rescan models/i });
    expect(rescanButton.className).toContain("active:");
  });

  it("exposes optional binary path fields as text inputs", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    expect(screen.getByLabelText(/nvidia-smi path/i)).toBeDefined();
    expect(screen.getByLabelText(/rocm-smi path/i)).toBeDefined();
    expect(screen.getByLabelText(/sysctl path/i)).toBeDefined();
    expect(screen.getByLabelText(/system_profiler path/i)).toBeDefined();
    expect(screen.getByLabelText(/powershell path/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /browse for/i })).toBeNull();
  });
});
