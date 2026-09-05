/**
 * @packageDocumentation
 * Example user tool. LlamaForge loads `*.ts` files from this folder (and from
 * `{dataDir}/tools`) and executes their default export inside the Bun server.
 *
 * Required default-export shape:
 * `{ name: string, description: string, parameters: object, execute(args) }`.
 */

/**
 * Echoes the provided text back to the model. Used as the in-repo example of a
 * user-defined TypeScript tool.
 */
const echoTextTool = {
  name: "echo_text",
  description: "Return the provided text unchanged.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to echo back to the model.",
      },
    },
    required: ["text"],
  },
  /**
   * Returns the `text` argument as `{ result }`.
   *
   * @param args - Object expected to contain a string `text` field.
   * @returns The echoed payload.
   */
  execute(args: Record<string, unknown>) {
    const text = args["text"];
    if (typeof text !== "string") {
      throw new Error("echo_text requires a string text argument.");
    }
    return { result: text };
  },
};

export default echoTextTool;
