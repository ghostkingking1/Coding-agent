#!/usr/bin/env node

// 入口包装器会同步拉起 TypeScript 子进程；先输出最小启动画面，避免模块加载期间终端无反馈。
const interactiveLaunch = process.argv.length === 2 && process.stdin.isTTY && process.stdout.isTTY;
if (interactiveLaunch) {
  process.stdout.write("\x1b[2J\x1b[Hveil\nLoading workspace...\n\nveil> ");
}

if (!process.execArgv.includes("--experimental-strip-types")) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", import.meta.filename, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else {
  await import("../src/cli.ts").then(({ main }) => main());
}
