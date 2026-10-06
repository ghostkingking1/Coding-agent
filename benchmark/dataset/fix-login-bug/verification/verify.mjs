import path from "node:path";
import vm from "node:vm";

export async function verify({ workspaceRoot }) {
  const source = await (await import("node:fs/promises")).readFile(path.join(workspaceRoot, "auth.mjs"), "utf8");
  const context = { result: undefined };
  vm.runInNewContext(`${source.replace(/export\s+function\s+/, "function ")}\nresult = authenticate;`, context, { timeout: 1000 });
  const authenticate = context.result;
  return [
    { name: "valid_credentials", passed: authenticate({ password: "s3cret", locked: false }, "s3cret") === true },
    { name: "wrong_password_rejected", passed: authenticate({ password: "s3cret", locked: false }, "wrong") === false },
    { name: "locked_account_rejected", passed: authenticate({ password: "s3cret", locked: true }, "s3cret") === false }
  ];
}
