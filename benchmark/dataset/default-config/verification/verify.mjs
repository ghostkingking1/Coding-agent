import path from "node:path";
import vm from "node:vm";

export async function verify({ workspaceRoot }) {
  const source = await (await import("node:fs/promises")).readFile(path.join(workspaceRoot, "config.mjs"), "utf8");
  const context = { result: undefined };
  vm.runInNewContext(`${source.replace(/export\s+function\s+/, "function ")}\nresult = withDefaults;`, context, { timeout: 1000 });
  const withDefaults = context.result;
  const config = { enabled: false, count: 0, label: null };
  const defaults = { enabled: true, count: 5, label: "default", extra: "x" };
  const beforeConfig = JSON.stringify(config), beforeDefaults = JSON.stringify(defaults);
  const result = withDefaults(config, defaults);
  return [
    { name: "preserves_falsy_values", passed: result.enabled === false && result.count === 0 && result.label === null },
    { name: "fills_missing_values", passed: result.extra === "x" },
    { name: "does_not_mutate_inputs", passed: JSON.stringify(config) === beforeConfig && JSON.stringify(defaults) === beforeDefaults }
  ];
}
