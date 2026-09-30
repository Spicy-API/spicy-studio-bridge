import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const folder = resolve(process.argv[2]);
const entry = join(folder, "runtime/node_modules/@spicyapi/studio-bridge/dist/src/cli.js");
assert.equal(execFileSync(process.execPath, [entry, "--version"], { encoding: "utf8" }).trim(), "0.2.0");
assert.match(execFileSync(process.execPath, [join(folder, "connect.mjs"), "--help"], { encoding: "utf8" }), /Studio connection wizard/);
for (const name of ["@spicyapi/studio-bridge", "@modelcontextprotocol/server", "@modelcontextprotocol/core", "zod"]) {
  assert.ok(existsSync(join(folder, "runtime/node_modules", name, "LICENSE")));
}
const manifest = readFileSync(join(folder, "SHA256SUMS"), "utf8").trim().split("\n");
assert.ok(manifest.length > 50);
for (const line of manifest) {
  const [expected, name] = line.split("  ");
  assert.ok(name && !name.startsWith("/") && !name.split("/").includes(".."));
  assert.equal(createHash("sha256").update(readFileSync(join(folder, name))).digest("hex"), expected);
}

const client = new Client({ name: "studio-release-check", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--port", "0"], env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" });
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true);
  return result.structuredContent;
};
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["studio_connect", "studio_next_request", "studio_submit_result"]) assert.ok(names.includes(name));
  const connection = await call("studio_connect");
  let token;
  const request = async (path, method = "GET", body) => {
    const response = await fetch(connection.baseUrl + path, { method, headers: { Origin: "https://spicyapi.ai", "Content-Type": "application/json", "Idempotency-Key": "release_smoke_request", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok);
    return response.json();
  };
  token = (await request("/v1/pair", "POST", { code: connection.code })).sessionToken;
  const draft = await request("/v1/requests", "POST", { kind: "creative", project: { id: "release-demo", title: "DEMO" }, prompt: { system: "Return a draft for review.", user: "DEMO only; no model call." } });
  assert.equal((await call("studio_next_request")).request.id, draft.id);
  await call("studio_submit_result", { id: draft.id, result: { type: "text", text: "Simulated release verification draft." } });
  assert.equal((await request(`/v1/requests/${draft.id}`)).status, "completed");
  await request("/v1/session", "DELETE");
} finally { await client.close(); }
console.log(`Installed bundle passed checksums, licenses, wizard help and MCP/browser round trip (${manifest.length} files). No model was called.`);
