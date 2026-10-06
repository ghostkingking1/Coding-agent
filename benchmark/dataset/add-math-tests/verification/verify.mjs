export async function verify({ workspaceRoot }) {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const testRoot = path.join(workspaceRoot, "test");
  let testFiles = [];
  try { testFiles = (await readdir(testRoot)).filter((name) => name.endsWith(".test.mjs")); } catch {}
  if (!testFiles.length) return [{ name: "test_file_exists", passed: false, details: "No test/*.test.mjs file was added" }];
  const file = path.join(testRoot, testFiles[0]);
  const source = await readFile(file, "utf8");
  const coverage = ["below", "above", "inside", "boundary"].every((word) => new RegExp(word, "i").test(source));
  const implementation = await readFile(path.join(workspaceRoot, "clamp.mjs"), "utf8");
  const context = { result: undefined };
  (await import("node:vm")).runInNewContext(`${implementation.replace(/export\s+function\s+/, "function ")}\nresult = clamp;`, context, { timeout: 1000 });
  const clamp = context.result;
  const behavior = clamp(-1, 0, 10) === 0 && clamp(11, 0, 10) === 10 && clamp(5, 0, 10) === 5 && clamp(0, 0, 10) === 0 && clamp(10, 0, 10) === 10;
  const testSourceValid = /node:test/.test(source) && /assert/.test(source);
  return [{ name: "edge_case_test_coverage", passed: coverage && testSourceValid }, { name: "implementation_behavior", passed: behavior }];
}
