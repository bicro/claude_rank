#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(__dirname, "node_modules"))) {
  execSync("npm install --production", { cwd: __dirname, stdio: "ignore" });
}

await import("./mcp-server.mjs");
