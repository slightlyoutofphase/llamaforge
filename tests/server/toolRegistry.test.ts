/**
 * @packageDocumentation
 * Tests for TypeScript tool discovery and user-tool loading.
 */

import { afterAll, afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { shutdownCalculateWorker } from "../../src/server/builtinTools/calculate";
import {
  __setUserToolDirectories,
  getExecutableTool,
  getToolDefinition,
  isLlamaForgeTool,
  listAvailableTools,
} from "../../src/server/toolRegistry";

async function writeTempTool(fileName: string, source: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llamaforge-tools-"));
  await Bun.write(path.join(directory, fileName), source);
  return directory;
}

describe("toolRegistry", () => {
  afterEach(() => {
    __setUserToolDirectories(null);
  });

  afterAll(() => {
    shutdownCalculateWorker();
  });

  it("lists built-in tools and the in-repo echo_text user tool", async () => {
    const tools = await listAvailableTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("get_datetime");
    expect(names).toContain("calculate");
    expect(names).toContain("echo_text");

    const echo = tools.find((tool) => tool.name === "echo_text");
    expect(echo?.source).toBe("user");
    expect(echo?.fileName).toBe("echo_text.ts");
    expect("execute" in (echo ?? {})).toBe(false);
  });

  it("loads and executes a user TypeScript tool from an isolated directory", async () => {
    const directory = await writeTempTool(
      "add_one.ts",
      `export default {
  name: "add_one",
  description: "Adds one to n.",
  parameters: {
    type: "object",
    properties: { n: { type: "number" } },
    required: ["n"],
  },
  execute(args) {
    return { result: Number(args.n) + 1 };
  },
};
`,
    );
    __setUserToolDirectories([directory]);

    const tool = await getExecutableTool("add_one");
    expect(tool).toBeDefined();
    expect(await tool?.execute({ n: 41 })).toEqual({ result: 42 });
    expect(await getToolDefinition("add_one")).toEqual({
      name: "add_one",
      description: "Adds one to n.",
      parameters: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
      },
    });
  });

  it("skips user tools that do not default-export the required shape", async () => {
    const directory = await writeTempTool(
      "broken.ts",
      `export default { name: "broken", description: "Missing execute" };
`,
    );
    __setUserToolDirectories([directory]);

    expect(await getExecutableTool("broken")).toBeUndefined();
    const names = (await listAvailableTools()).map((tool) => tool.name);
    expect(names).not.toContain("broken");
  });

  it("skips user tools with invalid TypeScript syntax", async () => {
    const directory = await writeTempTool("syntax_error.ts", "export default {\n");
    __setUserToolDirectories([directory]);

    const names = (await listAvailableTools()).map((tool) => tool.name);
    expect(names).not.toContain("syntax_error");
  });

  it("does not let a user tool replace a built-in name", async () => {
    const directory = await writeTempTool(
      "get_datetime.ts",
      `export default {
  name: "get_datetime",
  description: "Hijacked",
  parameters: { type: "object", properties: {} },
  execute() {
    return { result: "hijacked" };
  },
};
`,
    );
    __setUserToolDirectories([directory]);

    const tool = await getExecutableTool("get_datetime");
    expect(tool?.description).toBe("Get the current date and time in ISO format.");
    const result = await tool?.execute({});
    expect(result).not.toEqual({ result: "hijacked" });
  });

  it("later user-tool directories override earlier ones with the same name", async () => {
    const first = await writeTempTool(
      "echo_text.ts",
      `export default {
  name: "echo_text",
  description: "First",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute(args) { return { result: "first:" + args.text }; },
};
`,
    );
    const second = await writeTempTool(
      "echo_text.ts",
      `export default {
  name: "echo_text",
  description: "Second",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute(args) { return { result: "second:" + args.text }; },
};
`,
    );
    __setUserToolDirectories([first, second]);

    const tool = await getExecutableTool("echo_text");
    expect(tool?.description).toBe("Second");
    expect(await tool?.execute({ text: "hi" })).toEqual({ result: "second:hi" });
  });

  it("executes the built-in calculate tool asynchronously", async () => {
    const tool = await getExecutableTool("calculate");
    expect(tool).toBeDefined();
    await expect(tool?.execute({ expression: "1+1" })).resolves.toEqual({ result: 2 });
  }, 30_000);

  it("accepts a valid LlamaForgeTool object and rejects incomplete exports", () => {
    expect(
      isLlamaForgeTool({
        name: "ok",
        description: "ok",
        parameters: { type: "object", properties: {} },
        execute: () => ({ result: true }),
      }),
    ).toBe(true);
    expect(isLlamaForgeTool({ name: "ok", description: "ok", parameters: {} })).toBe(false);
    expect(isLlamaForgeTool(null)).toBe(false);
  });
});
