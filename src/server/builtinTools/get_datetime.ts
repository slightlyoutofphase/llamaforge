/**
 * @packageDocumentation
 * Built-in tool that returns the current date and time.
 */

import type { LlamaForgeTool } from "../../shared/types";

/**
 * Returns the current instant as an ISO-8601 timestamp.
 */
const getDatetimeTool: LlamaForgeTool = {
  name: "get_datetime",
  description: "Get the current date and time in ISO format.",
  parameters: { type: "object", properties: {} },
  /**
   * Returns `{ result }` with an ISO timestamp.
   *
   * @returns The current datetime payload.
   */
  execute() {
    return { result: new Date().toISOString() };
  },
};

export default getDatetimeTool;
