#!/usr/bin/env node

if (!process.execArgv.includes("--experimental-strip-types")) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", import.meta.filename, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  await import("../src/cli.ts").then(({ main }) => main());
}
