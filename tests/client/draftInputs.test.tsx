/**
 * @packageDocumentation
 * Tests for draft inputs that wait to parse until the text is complete.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  formatStopStrings,
  NumberDraftInput,
  parseSequenceBreakers,
  parseStopStrings,
  parseTensorSplit,
  parseToolArguments,
  presetDraftIsDirty,
  resolvePresetEditorState,
} from "../../src/client/components/DraftInputs";

/**
 * Holds draft state so a minus sign can be typed before the integer is complete.
 *
 * @returns The number field under test.
 */
function MinusSignHarness() {
  const [value, setValue] = useState(-1);
  return (
    <NumberDraftInput
      id="seed"
      integer
      value={value}
      onCommit={(next) => {
        if (typeof next === "number") setValue(next);
      }}
    />
  );
}

describe("draft field parsers", () => {
  it("keeps a trailing comma out of the stored stop strings", () => {
    expect(parseStopStrings("a,")).toEqual(["a"]);
    expect(formatStopStrings(["a"])).toBe("a");
  });

  it("rejects a tensor split that contains an empty piece", () => {
    expect(parseTensorSplit("3,")).toEqual({ ok: true, value: [3] });
    expect(parseTensorSplit("3,,1").ok).toBe(false);
    expect(parseTensorSplit("").ok).toBe(true);
  });

  it("requires sequence breakers to be a JSON array of strings", () => {
    expect(parseSequenceBreakers('["\\n"]').ok).toBe(true);
    expect(parseSequenceBreakers("{").ok).toBe(false);
    expect(parseSequenceBreakers("[1]").ok).toBe(false);
  });

  it("requires tool arguments to be a JSON object", () => {
    expect(parseToolArguments('{"expression":"2+2"}').ok).toBe(true);
    expect(parseToolArguments("[").ok).toBe(false);
    expect(parseToolArguments("[]").ok).toBe(false);
  });

  it("does not treat a fresh server timestamp as an unsaved edit", () => {
    const draft = {
      id: "p1",
      name: "LFM3",
      updatedAt: 1,
      config: { gpuLayers: -1, contextSize: 32768 },
    };
    const saved = {
      config: { contextSize: 32768, gpuLayers: -1 },
      name: "LFM3",
      id: "p1",
      updatedAt: 99,
      createdAt: 1,
    };
    expect(presetDraftIsDirty(draft, saved)).toBe(false);
    expect(
      presetDraftIsDirty(draft, { ...saved, config: { gpuLayers: 10, contextSize: 32768 } }),
    ).toBe(true);
    expect(
      presetDraftIsDirty(
        { ...draft, temperature: 0.1, repeatPenalty: 1.1 },
        { ...draft, temperature: 0.10000000149011612, repeatPenalty: 1.100000023841858 },
      ),
    ).toBe(false);
    expect(presetDraftIsDirty({ temperature: 0.1 }, { temperature: 0.15 })).toBe(true);
  });

  it("adopts the saved server row and keeps a newer local edit", () => {
    const sent = { id: "p1", name: "LFM3", updatedAt: 1, config: { gpuLayers: -1 } };
    const pending = { current: JSON.stringify(sent) };
    const fromServer = { ...sent, updatedAt: 50, config: { gpuLayers: -1 } };
    expect(resolvePresetEditorState(sent, fromServer, pending)).toEqual({
      ...fromServer,
      config: { gpuLayers: -1 },
    });
    expect(pending.current).toBeNull();

    const edited = { ...sent, config: { gpuLayers: 12 } };
    const stillPending = { current: JSON.stringify(sent) };
    expect(resolvePresetEditorState(edited, fromServer, stillPending)).toBe(edited);
    expect(stillPending.current).toBe(JSON.stringify(sent));
  });
});

describe("NumberDraftInput", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps a minus sign until a complete integer is entered", () => {
    render(<MinusSignHarness />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("-1");
    fireEvent.change(input, { target: { value: "-" } });
    expect(input.value).toBe("-");
    fireEvent.change(input, { target: { value: "-2" } });
    fireEvent.blur(input);
    expect(input.value).toBe("-2");
  });
});
