import { rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";

async function buildClient() {
  await rm("dist/client", { recursive: true, force: true });

  // Static HTML build: bun processes <script src> + <link rel="stylesheet">, hashes assets, etc.
  // Paths are resolved relative to the HTML file.
  await Bun.build({
    entrypoints: ["./index.html"],
    outdir: "./dist/client",
    target: "browser", // default, but explicit is nice
    format: "esm", // default

    minify: true,
    splitting: true, // off by default

    // If you use process.env.PUBLIC_* in client code:
    env: "PUBLIC_*", // prefix-style env inlining

    // Needed if your CSS contains @import "tailwindcss"; etc.
    plugins: [tailwind],
  });
}

async function buildServer() {
  await rm("dist/server", { recursive: true, force: true });

  await Bun.build({
    entrypoints: ["./src/server/index.ts"],
    outdir: "./dist/server",
    target: "bun", // same as: bun build ... --target bun
    format: "esm", // default

    // optional, but common:
    // sourcemap: "linked", // if you want stack traces mapped
    minify: true,
  });
}

try {
  await buildClient();
  await buildServer();
  console.log("Build complete: dist/client + dist/server");
} catch (e) {
  // Bun.build throws an AggregateError on failure (per docs); printing it is usually enough.
  console.error(e);
  process.exit(1);
}
