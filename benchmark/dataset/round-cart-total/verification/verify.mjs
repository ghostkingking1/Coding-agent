import path from "node:path";
import vm from "node:vm";

export async function verify({ workspaceRoot }) {
  const source = await (await import("node:fs/promises")).readFile(path.join(workspaceRoot, "cart.mjs"), "utf8");
  const context = { result: undefined };
  vm.runInNewContext(`${source.replace(/export\s+function\s+/, "function ")}\nresult = cartTotal;`, context, { timeout: 1000 });
  const cartTotal = context.result;
  const items = [{ price: 0.1, quantity: 1 }, { price: 0.2, quantity: 1 }];
  const before = JSON.stringify(items);
  return [
    { name: "rounds_to_cents", passed: cartTotal(items, 0) === 0.3 },
    { name: "applies_tax", passed: cartTotal([{ price: 10, quantity: 2 }], 0.075) === 21.5 },
    { name: "does_not_mutate", passed: JSON.stringify(items) === before }
  ];
}
