import path from "node:path";
import vm from "node:vm";

export async function verify({ workspaceRoot }) {
  const source = await (await import("node:fs/promises")).readFile(path.join(workspaceRoot, "slug.mjs"), "utf8");
  const context = { result: undefined };
  vm.runInNewContext(`${source.replace(/export\s+function\s+/, "function ")}\nresult = slugify;`, context, { timeout: 1000 });
  const slugify = context.result;
  return [
    { name: "spaces_and_case", passed: slugify("  Hello World  ") === "hello-world" },
    { name: "punctuation_runs", passed: slugify("A---B / C") === "a-b-c" },
    { name: "empty_input", passed: slugify(" !!! ") === "" }
  ];
}
