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

  it("renders browse buttons for file and directory path inputs", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    const browseButtons = screen.getAllByRole("button", { name: /browse/i });
    expect(browseButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("opens directory picker and appends llama-server executable when browse button is clicked", async () => {
    const showDirectoryPicker = mock().mockResolvedValue({
      name: "bin",
      path: "/opt/bin",
    });
    (window as any).showDirectoryPicker = showDirectoryPicker;

    await act(async () => {
      render(<SettingsPanel />);
    });

    const browseButtons = screen.getAllByRole("button", { name: /browse/i });
    const llamaBrowse = browseButtons[0];

    await act(async () => {
      fireEvent.click(llamaBrowse);
    });

    expect(showDirectoryPicker).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("/opt/bin/llama-server")).toBeDefined();
  });

  it("opens directory picker when browse button is clicked for models path", async () => {
    const showDirectoryPicker = mock().mockResolvedValue({
      name: "models",
    });
    (window as any).showDirectoryPicker = showDirectoryPicker;

    await act(async () => {
      render(<SettingsPanel />);
    });

    const browseButtons = screen.getAllByRole("button", { name: /browse/i });
    // Models path is the second browse button
    const modelsBrowse = browseButtons[1];

    await act(async () => {
      fireEvent.click(modelsBrowse);
    });

    expect(showDirectoryPicker).toHaveBeenCalled();
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

  it("renders browse buttons for all optional binary path fields", async () => {
    await act(async () => {
      render(<SettingsPanel />);
    });

    expect(screen.getByRole("button", { name: /browse for nvidia-smi/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /browse for rocm-smi/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /browse for sysctl/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /browse for system_profiler/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /browse for powershell/i })).toBeDefined();
  });

  it("opens directory picker and appends nvidia-smi executable when browse button is clicked", async () => {
    const showDirectoryPicker = mock().mockResolvedValue({
      name: "bin",
      path: "/usr/bin",
    });
    (window as any).showDirectoryPicker = showDirectoryPicker;

    await act(async () => {
      render(<SettingsPanel />);
    });

    const nvidiaBrowse = screen.getByRole("button", { name: /browse for nvidia-smi/i });

    await act(async () => {
      fireEvent.click(nvidiaBrowse);
    });

    expect(showDirectoryPicker).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("/usr/bin/nvidia-smi")).toBeDefined();
  });

  it("opens directory picker and appends rocm-smi executable when browse button is clicked", async () => {
    const showDirectoryPicker = mock().mockResolvedValue({
      name: "bin",
      path: "/usr/bin",
    });
    (window as any).showDirectoryPicker = showDirectoryPicker;

    await act(async () => {
      render(<SettingsPanel />);
    });

    const rocmBrowse = screen.getByRole("button", { name: /browse for rocm-smi/i });

    await act(async () => {
      fireEvent.click(rocmBrowse);
    });

    expect(showDirectoryPicker).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("/usr/bin/rocm-smi")).toBeDefined();
  });

  it("opens directory picker and appends sysctl executable when browse button is clicked", async () => {
    const showDirectoryPicker = mock().mockResolvedValue({
      name: "sbin",
      path: "/usr/sbin",
    });
    (window as any).showDirectoryPicker = showDirectoryPicker;

    await act(async () => {
      render(<SettingsPanel />);
    });

    const sysctlBrowse = screen.getByRole("button", { name: /browse for sysctl/i });

    await act(async () => {
      fireEvent.click(sysctlBrowse);
    });

    expect(showDirectoryPicker).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("/usr/sbin/sysctl")).toBeDefined();
  });

  it("opens directory picker and appends system_profiler executable when browse button is clicked", async () => {
    const showDirectoryPicker = mock().mockResolvedValue({
      name: "bin",
      path: "/usr/bin",
    });
    (window as any).showDirectoryPicker = showDirectoryPicker;

    await act(async () => {
      render(<SettingsPanel />);
    });

    const profilerBrowse = screen.getByRole("button", { name: /browse for system_profiler/i });

    await act(async () => {
      fireEvent.click(profilerBrowse);
    });

    expect(showDirectoryPicker).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("/usr/bin/system_profiler")).toBeDefined();
  });

  it("opens directory picker and appends powershell executable when browse button is clicked", async () => {
    const showDirectoryPicker = mock().mockResolvedValue({
      name: "System32",
      path: "C:\\Windows\\System32",
    });
    (window as any).showDirectoryPicker = showDirectoryPicker;

    await act(async () => {
      render(<SettingsPanel />);
    });

    const psBrowse = screen.getByRole("button", { name: /browse for powershell/i });

    await act(async () => {
      fireEvent.click(psBrowse);
    });

    expect(showDirectoryPicker).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("C:\\Windows\\System32\\powershell.exe")).toBeDefined();
  });
});
