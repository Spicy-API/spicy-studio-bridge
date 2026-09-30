import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BridgeRuntime, portError } from "../src/runtime.js";
import { BridgeError } from "../src/schema.js";
import { BridgeStore } from "../src/store.js";

type ToolError = { error: { code: string; message: string } };

void test(
  "a busy Studio port does not break the MCP server; tools explain it and a later call recovers",
  { timeout: 15000 },
  async () => {
    // Another session already owns the port (simulated with a plain listener on a free port).
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    const client = new Client({ name: "studio-busy-port-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "--port", String(port)],
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 5);
      const busy = await client.callTool({ name: "studio_connect", arguments: {} });
      assert.equal(busy.isError, true);
      const error = (busy.structuredContent as ToolError).error;
      assert.equal(error.code, "port_in_use");
      assert.match(error.message, /Another assistant session/);
      const next = await client.callTool({ name: "studio_next_request", arguments: {} });
      assert.equal((next.structuredContent as ToolError).error.code, "port_in_use");
      // Closing the other session is enough; no restart is needed here.
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      const recovered = await client.callTool({ name: "studio_connect", arguments: {} });
      assert.notEqual(recovered.isError, true);
      assert.equal((recovered.structuredContent as { baseUrl: string }).baseUrl, `http://127.0.0.1:${port}`);
    } finally {
      await client.close();
      if (blocker.listening) blocker.close();
    }
  },
);

void test("the runtime starts the local server once, shares a pending start and maps failures", async () => {
  let starts = 0;
  const handle = { baseUrl: "http://127.0.0.1:1234", close: () => Promise.resolve() };
  const runtime = new BridgeRuntime(new BridgeStore(), {}, async () => {
    starts++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return handle;
  });
  const [first, second] = await Promise.all([runtime.ensure(), runtime.ensure()]);
  assert.equal(first, handle.baseUrl);
  assert.equal(second, handle.baseUrl);
  assert.equal(starts, 1);
  assert.equal(await runtime.ensure(), handle.baseUrl);
  assert.equal(starts, 1);
  await runtime.close();
  await assert.rejects(runtime.ensure(), (error: unknown) => error instanceof BridgeError && error.code === "bridge_closed");
  const busy = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
  assert.equal(portError(busy, 47321).code, "port_in_use");
  assert.match(portError(busy, 47321).message, /47321/);
  assert.equal(portError(new Error("boom"), 47321).code, "port_unavailable");
});
