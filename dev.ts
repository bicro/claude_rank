// Dev script: starts FastAPI backend + Bun server
// Usage: bun run dev.ts

import { $ } from "bun";

// Start FastAPI backend on port 8000 (internal, proxied through Bun)
const backend = Bun.spawn(
  ["uvicorn", "app.main:app", "--port", "8001", "--reload"],
  {
    cwd: `${import.meta.dir}/backend`,
    stdout: "inherit",
    stderr: "inherit",
  }
);

// Start Bun auth + website server on port 3000
const server = Bun.spawn(["bun", "--hot", "index.ts"], {
  cwd: `${import.meta.dir}/server`,
  stdout: "inherit",
  stderr: "inherit",
});

// Handle cleanup
process.on("SIGINT", () => {
  backend.kill();
  server.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  backend.kill();
  server.kill();
  process.exit(0);
});

// Wait for both
await Promise.all([backend.exited, server.exited]);
