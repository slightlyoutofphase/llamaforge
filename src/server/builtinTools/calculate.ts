/**
 * @packageDocumentation
 * Built-in tool that evaluates mathjs expressions with dangerous functions disabled.
 */

import { all, create } from "mathjs";
import type { LlamaForgeTool } from "../../shared/types";

if (!all) {
  throw new Error("mathjs factory map is unavailable.");
}

const math = create(all);
math.import(
  {
    import: () => {
      throw new Error("Function import is disabled");
    },
    createUnit: () => {
      throw new Error("Function createUnit is disabled");
    },
  },
  { override: true },
);

/**
 * Evaluates a mathjs expression supplied by the model.
 */
const calculateTool: LlamaForgeTool = {
  name: "calculate",
  description: "Perform basic mathematical calculations.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The mathjs expression to evaluate (e.g. '2 + 2' or 'sqrt(16)').",
      },
    },
    required: ["expression"],
  },
  /**
   * Evaluates `args.expression` with a sandboxed mathjs instance.
   *
   * @param args - Object expected to contain a string `expression` field.
   * @returns `{ result }` on success.
   * @throws If the expression is missing or mathjs cannot evaluate it.
   */
  execute(args: Record<string, unknown>) {
    const expression = args["expression"];
    if (typeof expression !== "string" || expression.trim().length === 0) {
      throw new Error("calculate requires a non-empty string expression.");
    }
    return { result: math.evaluate(expression) };
  },
};

export default calculateTool;
