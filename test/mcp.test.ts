import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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
