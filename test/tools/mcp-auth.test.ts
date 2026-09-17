import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { MemoryCredentialStore, OAuthAuthenticator } from "../../src/tools/mcp-auth.ts";

function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }

test("OAuth login uses PKCE S256 and stores only the credential", async () => {
  const store = new MemoryCredentialStore();
  let authorizationUrl = "";
  let tokenBody = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-authorization-server")) return json({ authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" });
    if (url.endsWith("/token")) { tokenBody = String(init?.body); return json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 }); }
    throw new Error(`unexpected URL ${url}`);
  };
  const credential = await new OAuthAuthenticator(store, fetchImpl).login({
    serverId: "server",
    endpoint: "https://mcp.example/mcp",
    clientId: "client",
    fetch: fetchImpl,
    browserLauncher: { open: (url) => { authorizationUrl = url; } },
    waitForAuthorizationCode: async (url) => ({ code: "auth-code", state: new URL(url).searchParams.get("state")! }),
  });
  const url = new URL(authorizationUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const verifier = new URLSearchParams(tokenBody).get("code_verifier")!;
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(url.searchParams.get("code_challenge"), expected);
  assert.equal(credential.accessToken, "access");
  assert.equal((await store.get("server:https://mcp.example"))?.accessToken, "access");
});

test("OAuth rejects a state mismatch", async () => {
  const fetchImpl: typeof fetch = async (input) => String(input).includes("/.well-known/") ? json({ authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" }) : json({ access_token: "never" });
  await assert.rejects(() => new OAuthAuthenticator(new MemoryCredentialStore(), fetchImpl).login({ serverId: "server", endpoint: "https://mcp.example/mcp", clientId: "client", fetch: fetchImpl, waitForAuthorizationCode: async () => ({ code: "code", state: "wrong" }) }), /state mismatch/);
});
