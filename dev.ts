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

const result = await Promise.race([
  server.exited.then((code) => ({ process: "server", code })),
  desktop.exited.then((code) => ({ process: "desktop", code })),
]);
console.log(`[dev] ${result.process} exited with code ${result.code}`);
cleanup();
