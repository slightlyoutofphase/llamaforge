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
} from "../../src/client/components/DraftInputs";

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
});

describe("NumberDraftInput", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps a minus sign until a complete integer is entered", () => {
    function Harness() {
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

    render(<Harness />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("-1");
    fireEvent.change(input, { target: { value: "-" } });
    expect(input.value).toBe("-");
    fireEvent.change(input, { target: { value: "-2" } });
    fireEvent.blur(input);
    expect(input.value).toBe("-2");
  });
});
