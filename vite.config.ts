import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react(), tailwindcss()],
    define: {
      "process.env.GEMINI_API_KEY": JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
        "@shared": path.resolve(__dirname, "./src/shared"),
      },
    },
    build: {
      outDir: "dist/client",
      emptyOutDir: true,
    },
    server: {
      host: "0.0.0.0",
      port: 3000,
      hmr: process.env.DISABLE_HMR !== "true",
      proxy: {
        "/api": {
          target: "http://127.0.0.1:11435",
          changeOrigin: true,
        },
        "/ws": {
          target: "ws://127.0.0.1:11435",
          ws: true,
        },
      },
    },
  };
});
