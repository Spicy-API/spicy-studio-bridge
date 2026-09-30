import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

void test(
  "fixed-port delivery supports both development origins and isolates replaced sessions",
  { timeout: 15000 },
  async () => {
    const origins = ["http://127.0.0.1:3012", "http://127.0.0.1:3187"];
    const client = new Client({ name: "studio-delivery-check", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./mock-host.js", import.meta.url)),
        "--bridge-child",
        ...origins,
      ],
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args });
    const base = "http://127.0.0.1:47321";
    let token = "";
    const request = (
      path: string,
      method = "GET",
      body?: unknown,
      key?: string,
      origin = origins[0]!,
    ) =>
      fetch(base + path, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const draft = {
      kind: "creative",
      project: { id: "delivery-project", title: "DEMO" },
      prompt: { system: "Write a reviewable draft.", user: "DEMO only; no model call." },
    };
    try {
      await client.connect(transport);
      const connection = (await call("studio_connect")).structuredContent as {
        baseUrl: string;
        code: string;
      };
      assert.equal(connection.baseUrl, base);
      assert.equal(
        (await request("/v1/health", "GET", undefined, undefined, "https://spicyapi.ai")).status,
        403,
      );
      const pairing = await request("/v1/pair", "POST", { code: connection.code });
      assert.equal(pairing.status, 200);
      token = ((await pairing.json()) as { sessionToken: string }).sessionToken;
      assert.equal(
        (
          await request(
            "/v1/requests/11111111-1111-4111-8111-111111111111",
            "GET",
            undefined,
            undefined,
            origins[1],
          )
        ).status,
        401,
      );
      const queued = await request("/v1/requests", "POST", draft, "delivery_result");
      const value = (await queued.json()) as { id: string };
      const next = (await call("studio_next_request")).structuredContent as {
        request: { id: string };
      };
      assert.equal(next.request.id, value.id);
      assert.notEqual(
        (
          await call("studio_submit_result", {
            id: value.id,
            result: { type: "text", text: "DEMO result; no model was called." },
          })
        ).isError,
        true,
      );
      const completed = await request(`/v1/requests/${value.id}`);
      assert.equal(((await completed.json()) as { status: string }).status, "completed");
      assert.equal(
        (await request("/v1/requests", "DELETE", undefined, "delivery_late_post")).status,
        200,
      );
      assert.equal(
        (await request("/v1/requests", "POST", draft, "delivery_late_post")).status,
        409,
      );
      const pending = (await (
        await request("/v1/requests", "POST", draft, "delivery_cancelled")
      ).json()) as { id: string };
      await call("studio_next_request");
      assert.equal((await request(`/v1/requests/${pending.id}`, "DELETE")).status, 200);
      assert.equal(
        (
          await call("studio_submit_result", {
            id: pending.id,
            result: { type: "text", text: "Late draft" },
          })
        ).isError,
        true,
      );
      // The website disconnects on account changes; the bridge never infers an account from request text.
      const oldToken = token;
      assert.equal((await request("/v1/session", "DELETE")).status, 200);
      assert.equal((await request(`/v1/requests/${value.id}`)).status, 401);
      const replacement = (await call("studio_connect", { reset: true })).structuredContent as {
        code: string;
      };
      const second = await request(
        "/v1/pair",
        "POST",
        { code: replacement.code },
        undefined,
        origins[1],
      );
      token = ((await second.json()) as { sessionToken: string }).sessionToken;
      assert.notEqual(token, oldToken);
      assert.equal(
        (await request(`/v1/requests/${value.id}`, "GET", undefined, undefined, origins[1])).status,
        404,
      );
      assert.equal(
        ((await call("studio_next_request")).structuredContent as { request: unknown }).request,
        null,
      );
      assert.equal(
        (
          await request(
            "/v1/requests",
            "POST",
            { ...draft, userId: "another-account" },
            "delivery_forged_user",
            origins[1],
          )
        ).status,
        400,
      );
    } finally {
      await client.close();
    }
  },
);
