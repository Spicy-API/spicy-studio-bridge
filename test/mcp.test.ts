import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createBridgeMcpFactory } from "../src/mcp.js";
import { BridgeStore } from "../src/store.js";

type NextResult = { request: { id: string; status: string } | null; message?: string };

for (const era of ["legacy", "modern"] as const) {
  void test(
    `real stdio ${era} protocol completes browser-to-assistant-to-browser round trip`,
    { timeout: 15000 },
    async () => {
      const client = new Client(
        { name: "studio-bridge-test", version: "1.0.0" },
        { versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } } },
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "--port", "0"],
        env: { PATH: process.env.PATH ?? "" },
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
          "studio_connect",
          "studio_fail_request",
          "studio_get_request",
          "studio_next_request",
          "studio_submit_result",
        ]);
        const connection = (await client.callTool({ name: "studio_connect", arguments: {} }))
          .structuredContent as { baseUrl: string; code: string };
        assert.match(connection.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.match(connection.code, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
        const headers: Record<string, string> = {
          Origin: "https://spicyapi.ai",
          "Content-Type": "application/json",
        };
        const pairing = await fetch(connection.baseUrl + "/v1/pair", {
          method: "POST",
          headers,
          body: JSON.stringify({ code: connection.code }),
        });
        assert.equal(pairing.status, 200);
        const { sessionToken } = (await pairing.json()) as { sessionToken: string };
        headers.Authorization = `Bearer ${sessionToken}`;
        headers["Idempotency-Key"] = "protocol_test_1";
        const queued = await fetch(connection.baseUrl + "/v1/requests", {
          method: "POST",
          headers,
          body: JSON.stringify({
            kind: "creative",
            project: { id: "test-board", title: "Rain scene" },
            prompt: { system: "Write an original scene.", user: "Two adults meet at a station." },
          }),
        });
        assert.equal(queued.status, 200);
        const request = (await queued.json()) as { id: string };
        const claimed = await client.callTool({ name: "studio_next_request", arguments: {} });
        assert.equal(
          (claimed.structuredContent as { request: { id: string; status: string } }).request.id,
          request.id,
        );
        const finished = await client.callTool({
          name: "studio_submit_result",
          arguments: {
            id: request.id,
            result: { type: "text", text: "An original scene draft for review." },
          },
        });
        assert.notEqual(finished.isError, true);
        const returned = await fetch(`${connection.baseUrl}/v1/requests/${request.id}`, {
          headers,
        });
        const value = (await returned.json()) as { status: string; result: { text: string } };
        assert.equal(value.status, "completed");
        assert.equal(value.result.text, "An original scene draft for review.");
        const missing = await client.callTool({
          name: "studio_get_request",
          arguments: { id: "11111111-1111-4111-8111-111111111111" },
        });
        assert.equal(missing.isError, true);
        await fetch(connection.baseUrl + "/v1/session", { method: "DELETE", headers });
      } finally {
        await client.close();
      }
    },
  );
}

void test(
  "studio_next_request wait_seconds waits for a shared request over real stdio and HTTP",
  { timeout: 20000 },
  async () => {
    const client = new Client({ name: "studio-wait-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "--port", "0"],
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const next = async (args: Record<string, unknown>) => {
      const started = Date.now();
      const response = await client.callTool({ name: "studio_next_request", arguments: args });
      assert.notEqual(response.isError, true);
      const text = (response.content as { type: string; text: string }[])[0]!.text;
      return { value: response.structuredContent as NextResult, text, elapsed: Date.now() - started };
    };
    try {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find((item) => item.name === "studio_next_request");
      const property = (tool?.inputSchema.properties as Record<string, { description?: string }>).wait_seconds;
      assert.match(property?.description ?? "", /0 to 50/);
      const connection = (await client.callTool({ name: "studio_connect", arguments: {} }))
        .structuredContent as { baseUrl: string; code: string };
      const headers: Record<string, string> = {
        Origin: "https://spicyapi.ai",
        "Content-Type": "application/json",
      };
      const pairing = await fetch(connection.baseUrl + "/v1/pair", {
        method: "POST",
        headers,
        body: JSON.stringify({ code: connection.code }),
      });
      headers.Authorization = `Bearer ${((await pairing.json()) as { sessionToken: string }).sessionToken}`;

      // Default and negative waits return at once and tell the model how to keep waiting.
      for (const args of [{}, { wait_seconds: 0 }, { wait_seconds: -3 }, { wait_seconds: null }]) {
        const empty = await next(args);
        assert.equal(empty.value.request, null);
        assert.ok(empty.elapsed < 900, `returned at once for ${JSON.stringify(args)}`);
        assert.match(empty.text, /call studio_next_request again with wait_seconds set to 30/i);
      }

      // An out-of-range wait is clamped, not rejected, and resolves as soon as the browser shares a request.
      const waiting = next({ wait_seconds: 999 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const queued = await fetch(connection.baseUrl + "/v1/requests", {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "wait_mode_test_1" },
        body: JSON.stringify({
          kind: "creative",
          project: { id: "wait-board", title: "Night train" },
          prompt: { system: "Write an original scene.", user: "Two adults share a late train." },
        }),
      });
      const shared = (await queued.json()) as { id: string; status: string };
      assert.equal(shared.status, "queued");
      const arrived = await waiting;
      assert.equal(arrived.value.request?.id, shared.id);
      assert.equal(arrived.value.request?.status, "working");
      assert.ok(arrived.elapsed >= 250 && arrived.elapsed < 5000);

      // A wait that expires returns an empty answer with the instruction to call again.
      const expired = await next({ wait_seconds: 1.8 });
      assert.equal(expired.value.request, null);
      assert.ok(expired.elapsed >= 900 && expired.elapsed < 5000);
      assert.match(expired.value.message ?? "", /within 1 second\. Call studio_next_request again with wait_seconds/);
      await fetch(connection.baseUrl + "/v1/session", { method: "DELETE", headers });
    } finally {
      await client.close();
    }
  },
);

void test("a cancelled or disconnected MCP call stops waiting and leaves no waiter behind", { timeout: 15000 }, async () => {
  const store = new BridgeStore();
  const { code } = store.connect();
  store.pair(code, "https://spicyapi.ai");
  const connect = async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = await createBridgeMcpFactory(store, "http://127.0.0.1:47321")({ era: "legacy" });
    await server.connect(serverSide);
    const client = new Client({ name: "studio-cancel-test", version: "1.0.0" });
    await client.connect(clientSide);
    return { client, server };
  };
  const settled = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return condition();
  };
  const first = await connect();
  try {
    const controller = new AbortController();
    const cancelled = first.client.callTool(
      { name: "studio_next_request", arguments: { wait_seconds: 40 } },
      { signal: controller.signal },
    );
    assert.ok(await settled(() => store.waiting === 1));
    controller.abort();
    await assert.rejects(cancelled);
    assert.ok(await settled(() => store.waiting === 0), "cancellation must remove the waiter");

    const dropped = first.client.callTool({ name: "studio_next_request", arguments: { wait_seconds: 40 } });
    assert.ok(await settled(() => store.waiting === 1));
    await first.client.close();
    await assert.rejects(dropped);
    assert.ok(await settled(() => store.waiting === 0), "closing the client must remove the waiter");
  } finally {
    await first.client.close();
    await first.server.close();
  }
  // Nothing was claimed by the abandoned calls.
  const request = store.create(
    {
      kind: "creative",
      project: { id: "cancel-board", title: "A scene" },
      prompt: { system: "Write an original scene.", user: "A reunion." },
    },
    "after_cancelled_waits",
  );
  assert.equal(store.get(request.id).status, "queued");
});
