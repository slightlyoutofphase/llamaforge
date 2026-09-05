/**
 * @packageDocumentation
 * Discovers and loads TypeScript tool modules for built-in and user tools.
 *
 * Built-ins are statically imported so they remain available after the server
 * bundle is compiled. User tools are default-exported `*.ts` files loaded from
 * the project `tools/` directory and `{appData}/tools`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isValidToolName, toStoredToolDefinition } from "../shared/toolModule";
import type { AvailableTool, LlamaForgeTool, ToolDefinition } from "../shared/types";
import calculateTool from "./builtinTools/calculate";
import getDatetimeTool from "./builtinTools/get_datetime";
import { logWarn } from "./logger";
import { resolveAppDataPath } from "./persistence/db";

const USER_TOOLS_DIR_ENV = "LLAMAFORGE_TOOLS_DIR";
const MAX_USER_TOOL_FILES = 200;
const MAX_USER_TOOL_FILE_BYTES = 1_048_576;

const builtinTools: LlamaForgeTool[] = [getDatetimeTool, calculateTool];

let userToolDirectoryOverride: string[] | null = null;

/**
 * Overrides the user-tool search path for tests.
 *
 * Passing `null` restores the default directories. Passing an empty array
 * disables user-tool discovery entirely.
 *
 * @param directories - Absolute directories to scan, or `null` to reset.
 * @returns No return value.
 * @internal
 */
export function __setUserToolDirectories(directories: string[] | null): void {
  userToolDirectoryOverride = directories;
}

/**
 * Returns whether an unknown value matches {@link LlamaForgeTool}.
 *
 * @param value - Candidate default export from a tool module.
 * @returns `true` when the value can be executed as a LlamaForge tool.
 */
export function isLlamaForgeTool(value: unknown): value is LlamaForgeTool {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["name"] === "string" &&
    isValidToolName(candidate["name"]) &&
    typeof candidate["description"] === "string" &&
    typeof candidate["parameters"] === "object" &&
    candidate["parameters"] !== null &&
    !Array.isArray(candidate["parameters"]) &&
    typeof candidate["execute"] === "function"
  );
}

/**
 * Reads an error message from an unknown thrown value.
 *
 * @param error - Caught failure.
 * @returns A human-readable message.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns whether `child` resolves inside `parent` after symlink expansion.
 *
 * @param parent - Directory that must contain the file.
 * @param child - File path to check.
 * @returns `true` when `child` is inside `parent`.
 */
function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Directories scanned for user TypeScript tools, in override-priority order.
 * Later directories win when two files export the same `name`.
 *
 * @returns Absolute directory paths; missing folders are skipped at scan time.
 */
export function getUserToolDirectories(): string[] {
  if (userToolDirectoryOverride) {
    return userToolDirectoryOverride.map((directory) => path.resolve(directory));
  }

  const directories: string[] = [];
  const envDirectory = process.env[USER_TOOLS_DIR_ENV]?.trim();
  if (envDirectory) {
    directories.push(path.resolve(envDirectory));
  }
  directories.push(path.resolve(process.cwd(), "tools"));
  directories.push(resolveAppDataPath("tools"));

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const directory of directories) {
    const key = process.platform === "win32" ? directory.toLowerCase() : directory;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(directory);
  }
  return unique;
}

/**
 * Lists `*.ts` tool files in a directory without recursing.
 *
 * @param directory - Absolute tools folder.
 * @returns Absolute file paths that look like tool modules.
 */
async function listToolFiles(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      logWarn("Failed to read user tools directory", { directory, error: errorMessage(error) });
    }
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    files.push(path.join(directory, entry.name));
    if (files.length >= MAX_USER_TOOL_FILES) {
      logWarn(
        "User tools directory has more than the maximum number of files; extra files are ignored.",
        {
          directory,
          max: MAX_USER_TOOL_FILES,
        },
      );
      break;
    }
  }
  files.sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  return files;
}

/**
 * Dynamically imports a user tool TypeScript file and validates its default export.
 *
 * @param filePath - Absolute path to a `.ts` file inside a tools directory.
 * @param directory - The tools directory the file was listed from.
 * @returns The loaded tool, or `null` when the file is invalid.
 */
async function loadUserToolFile(
  filePath: string,
  directory: string,
): Promise<LlamaForgeTool | null> {
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(filePath);
  } catch (error: unknown) {
    logWarn("Skipping user tool that could not be resolved", {
      filePath,
      error: errorMessage(error),
    });
    return null;
  }

  const resolvedDirectory = await fs.realpath(directory).catch(() => directory);
  if (!isPathInside(resolvedDirectory, resolvedPath)) {
    logWarn("Skipping user tool outside its tools directory", { filePath: resolvedPath });
    return null;
  }

  let stats: import("node:fs").Stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (error: unknown) {
    logWarn("Skipping user tool that could not be stat'd", {
      filePath: resolvedPath,
      error: errorMessage(error),
    });
    return null;
  }
  if (!stats.isFile()) {
    return null;
  }
  if (stats.size > MAX_USER_TOOL_FILE_BYTES) {
    logWarn("Skipping user tool larger than the size limit", {
      filePath: resolvedPath,
      size: stats.size,
      max: MAX_USER_TOOL_FILE_BYTES,
    });
    return null;
  }

  try {
    const moduleUrl = `${pathToFileURL(resolvedPath).href}?mtime=${stats.mtimeMs}`;
    const loaded: unknown = await import(moduleUrl);
    if (typeof loaded !== "object" || loaded === null) {
      logWarn("Skipping user tool with a non-object module export", { filePath: resolvedPath });
      return null;
    }
    const candidate = (loaded as { default?: unknown }).default;
    if (!isLlamaForgeTool(candidate)) {
      logWarn(
        "Skipping user tool that does not default-export { name, description, parameters, execute }",
        { filePath: resolvedPath },
      );
      return null;
    }
    return candidate;
  } catch (error: unknown) {
    logWarn("Failed to import user tool", { filePath: resolvedPath, error: errorMessage(error) });
    return null;
  }
}

type LoadedTool = {
  tool: LlamaForgeTool;
  source: AvailableTool["source"];
  fileName: string;
};

/**
 * Loads built-in tools plus every valid user TypeScript tool module.
 *
 * @returns Tools keyed by function name. Built-ins win on collisions.
 */
async function loadToolCatalog(): Promise<Map<string, LoadedTool>> {
  const catalog = new Map<string, LoadedTool>();

  for (const tool of builtinTools) {
    if (!isLlamaForgeTool(tool)) {
      logWarn("Ignoring malformed built-in tool", {
        name: String((tool as { name?: unknown }).name),
      });
      continue;
    }
    catalog.set(tool.name, {
      tool,
      source: "builtin",
      fileName: `${tool.name}.ts`,
    });
  }

  for (const directory of getUserToolDirectories()) {
    const files = await listToolFiles(directory);
    for (const filePath of files) {
      const tool = await loadUserToolFile(filePath, directory);
      if (!tool) continue;
      const existing = catalog.get(tool.name);
      if (existing?.source === "builtin") {
        logWarn("User tool is ignored because a built-in tool already uses that name", {
          name: tool.name,
          filePath,
        });
        continue;
      }
      catalog.set(tool.name, {
        tool,
        source: "user",
        fileName: path.basename(filePath),
      });
    }
  }

  return catalog;
}

/**
 * Converts a loaded tool into the client-facing discovery record.
 *
 * @param loaded - Catalog entry.
 * @returns Metadata without the `execute` implementation.
 */
function toAvailableTool(loaded: LoadedTool): AvailableTool {
  return {
    ...toStoredToolDefinition(loaded.tool),
    source: loaded.source,
    fileName: loaded.fileName,
  };
}

/**
 * Lists every executable tool currently discoverable by the server.
 *
 * @returns Built-in tools first, then user tools in name order.
 */
export async function listAvailableTools(): Promise<AvailableTool[]> {
  const catalog = await loadToolCatalog();
  const builtins: AvailableTool[] = [];
  const userTools: AvailableTool[] = [];
  for (const loaded of catalog.values()) {
    const available = toAvailableTool(loaded);
    if (loaded.source === "builtin") {
      builtins.push(available);
    } else {
      userTools.push(available);
    }
  }
  userTools.sort((left, right) => left.name.localeCompare(right.name));
  return [...builtins, ...userTools];
}

/**
 * Looks up an executable tool by function name.
 *
 * @param name - Tool function name from a model tool call.
 * @returns The loaded module, or `undefined` when no matching tool exists.
 */
export async function getExecutableTool(name: string): Promise<LlamaForgeTool | undefined> {
  const catalog = await loadToolCatalog();
  return catalog.get(name)?.tool;
}

/**
 * Looks up the persistable definition for a tool name.
 *
 * @param name - Tool function name.
 * @returns The schema advertised to the model, or `undefined` when missing.
 */
export async function getToolDefinition(name: string): Promise<ToolDefinition | undefined> {
  const tool = await getExecutableTool(name);
  return tool ? toStoredToolDefinition(tool) : undefined;
}
