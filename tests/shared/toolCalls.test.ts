/**
 * @packageDocumentation
 * Tests for persisted vs inference-time tool-call argument shapes.
 */

import { Template } from "@huggingface/jinja";
import { describe, expect, it } from "bun:test";
import {
  parseToolCallArgumentsObject,
  parseToolCallsJson,
  toApiToolCalls,
} from "../../src/shared/toolCalls";

describe("toolCalls", () => {
  it("keeps persisted arguments as JSON strings", () => {
    const parsed = parseToolCallsJson(
      JSON.stringify([
        {
          id: "tc_1",
          type: "function",
          function: { name: "calculate", arguments: '{"expression":"2+2"}' },
        },
      ]),
    );
    expect(parsed?.[0]?.function.arguments).toBe('{"expression":"2+2"}');
  });

  it("deserializes arguments to a mapping at the API boundary", () => {
    const parsed = parseToolCallsJson(
      JSON.stringify([
        {
          id: "tc_1",
          type: "function",
          function: { name: "calculate", arguments: '{"expression":"2+2"}' },
        },
      ]),
    );
    expect(parsed).not.toBeNull();
    const api = toApiToolCalls(parsed!);
    expect(api[0]?.function.arguments).toEqual({ expression: "2+2" });
  });

  it("falls back to an empty mapping for non-object argument payloads", () => {
    expect(parseToolCallArgumentsObject("not-json")).toEqual({});
    expect(parseToolCallArgumentsObject('"a string"')).toEqual({});
    expect(parseToolCallArgumentsObject("[1,2]")).toEqual({});
  });

  it("Gemma 4-style templates reject string arguments and accept mappings", () => {
    const template = new Template(`
{%- for message in messages -%}
  {%- if message.tool_calls -%}
    {%- for tool_call in message.tool_calls -%}
      {%- if tool_call.function.arguments is string -%}
        {{- raise_exception('arguments must be a mapping, not a string') -}}
      {%- elif tool_call.function.arguments is mapping -%}
        {{- tool_call.function.name -}}
      {%- endif -%}
    {%- endfor -%}
  {%- endif -%}
{%- endfor -%}
`);

    expect(() =>
      template.render({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "tc_1",
                type: "function",
                function: { name: "calculate", arguments: '{"expression":"1"}' },
              },
            ],
          },
        ],
      }),
    ).toThrow();

    expect(
      template.render({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "tc_1",
                type: "function",
                function: { name: "calculate", arguments: { expression: "1" } },
              },
            ],
          },
        ],
      }),
    ).toBe("calculate");
  });
});
