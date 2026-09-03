/**
 * @packageDocumentation
 * Vite build configuration for the LlamaForge client application.
 */

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * Returns the Vite configuration object based on the current mode.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");

  const manualChunks = (id: string) => {
    if (!id.includes("node_modules")) return undefined;
    if (
      id.includes("@uiw/react-codemirror") ||
      id.includes("@codemirror") ||
      id.includes("codemirror")
    ) {
      return "codemirror";
    }
    if (
      id.includes("react-markdown") ||
      id.includes("remark-") ||
      id.includes("rehype-") ||
      id.includes("highlight.js") ||
      id.includes("katex")
    ) {
      return "markdown";
    }
    if (id.includes("pdfjs-dist")) {
      return "pdfjs";
    }
    if (id.includes("@tanstack")) {
      return "tanstack";
    }
    return "vendor";
  };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
        "@shared": path.resolve(__dirname, "./src/shared"),
      },
    },
    build: {
      outDir: "dist/client",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks,
        },
      },
    },
    server: {
      host: env.LLAMAFORGE_DEV_HOST || process.env.LLAMAFORGE_DEV_HOST || "127.0.0.1",
      port: 3000,
      hmr: process.env.DISABLE_HMR !== "true",
      proxy: {
        "/api": {
          target: "http://127.0.0.1:11435",
          changeOrigin: false,
        },
        "/ws": {
          target: "ws://127.0.0.1:11435",
          ws: true,
        },
      },
    },
  };
});
