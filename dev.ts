// Dev script: starts Bun server + Tauri desktop app
// Usage: bun run dev

const server = Bun.spawn(["bun", "--hot", "index.ts"], {
  cwd: `${import.meta.dir}/server`,
  stdout: "inherit",
  stderr: "inherit",
});

const desktop = Bun.spawn(["bun", "run", "tauri", "dev"], {
  cwd: `${import.meta.dir}/desktop`,
  stdout: "inherit",
  stderr: "inherit",
});

function cleanup() {
  server.kill();
  desktop.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

await Promise.race([server.exited, desktop.exited]);
cleanup();
