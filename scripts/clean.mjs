import { rm } from "node:fs/promises";

const buildArtifactPaths = [
  ".next",
  "out",
  "dist",
  "docs",
  "docs_html",
  ".tmp-compiled-smoke",
  ".playwright",
  ".tmp-tests",
  "test-results",
];

await Promise.all(
  buildArtifactPaths.map(async (artifactPath) => {
    await rm(artifactPath, { force: true, recursive: true });
  }),
);

console.log(`Removed build artifacts: ${buildArtifactPaths.join(", ")}.`);
