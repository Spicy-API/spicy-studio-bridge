import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { startBridgeHttp } from "../src/http.js";
import { BridgeStore } from "../src/store.js";
import { MAX_BODY_BYTES } from "../src/schema.js";

const origin = "https://spicyapi.ai";
const input = {
  kind: "creative",
  project: { id: "board1", title: "A scene" },
  prompt: { system: "Write an original scene.", user: "A reunion." },
};

void test("real HTTP pairing, preflight, authenticated queue, cancellation, and disconnect", async () => {
  const store = new BridgeStore();
  const bridge = await startBridgeHttp(store, { port: 0 });
  const headers: Record<string, string> = { Origin: origin, "Content-Type": "application/json" };
  const api = (path: string, init: RequestInit = {}) =>
    fetch(bridge.baseUrl + path, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.timeout(5000),
    });
  try {
    const health = await api("/v1/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      name: "spicyapi-studio-bridge",
      version: "0.2.1",
      kinds: ["drama", "creative"],
      paired: false,
    });
    const preflight = await api("/v1/requests", {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,idempotency-key",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
    assert.equal(preflight.headers.has("access-control-allow-credentials"), false);
    assert.equal(
      (await api("/v1/requests", { method: "POST", body: JSON.stringify(input) })).status,
      401,
    );
    const code = store.connect().code!;
    const pair = await api("/v1/pair", { method: "POST", body: JSON.stringify({ code }) });
    assert.equal(pair.status, 200);
    const token = ((await pair.json()) as { sessionToken: string }).sessionToken;
    headers.Authorization = `Bearer ${token}`;
    const created = await api("/v1/requests", {
      method: "POST",
      headers: { "Idempotency-Key": "http_request_1" },
      body: JSON.stringify(input),
    });
    assert.equal(created.status, 200);
    const request = (await created.json()) as { id: string; status: string };
    assert.equal(request.status, "queued");
    assert.equal(store.next()?.id, request.id);
    assert.equal((await api(`/v1/requests/${request.id}`)).status, 200);
    assert.equal(
      (await api(`/v1/requests/${request.id}`, { headers: { Origin: "https://www.spicyapi.ai" } }))
        .status,
      401,
    );
    const cancelled = await api(`/v1/requests/${request.id}`, { method: "DELETE" });
    assert.equal(((await cancelled.json()) as { status: string }).status, "cancelled");
    assert.throws(() => store.finish(request.id, { type: "text", text: "late" }));
    assert.equal((await api("/v1/session", { method: "DELETE" })).status, 200);
    assert.equal((await api(`/v1/requests/${request.id}`)).status, 401);
    assert.equal(store.isPaired(), false);
  } finally {
    await bridge.close();
  }
});

void test("real HTTP denies foreign origins, DNS rebinding, unsafe preflight, query tokens, and oversized bodies", async () => {
  const store = new BridgeStore();
  const bridge = await startBridgeHttp(store, { port: 0 });
  try {
    for (const untrusted of [
      "null",
      "*",
      "https://evil.example",
      "https://spicyapi.ai.evil.example",
    ]) {
      const response = await fetch(bridge.baseUrl + "/v1/health", {
        headers: { Origin: untrusted },
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.has("access-control-allow-origin"), false);
    }
    assert.equal((await fetch(bridge.baseUrl + "/v1/health")).status, 403);
    const rebinding = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        bridge.baseUrl + "/v1/health",
        { headers: { Origin: origin, Host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(rebinding, 403);
    const invalidHeaders = await fetch(bridge.baseUrl + "/v1/requests", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "cookie",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(invalidHeaders.status, 403);
    assert.equal(invalidHeaders.headers.has("access-control-allow-private-network"), false);
    const queryToken = await fetch(bridge.baseUrl + "/v1/health?token=secret", {
      headers: { Origin: origin },
    });
    assert.equal(queryToken.status, 404);
    const large = await fetch(bridge.baseUrl + "/v1/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x".repeat(MAX_BODY_BYTES) }),
    });
    assert.equal(large.status, 413);
    const contentType = await fetch(bridge.baseUrl + "/v1/pair", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "text/plain" },
      body: "anything",
    });
    assert.equal(contentType.status, 415);
  } finally {
    await bridge.close();
  }
});

void test("HTTP cancellation by key prevents a late POST and bounds tombstone access", async () => {
  const store = new BridgeStore();
  const bridge = await startBridgeHttp(store, { port: 0 });
  const code = store.connect().code!;
  const paired = store.pair(code, origin);
  const headers = {
    Origin: origin,
    "Content-Type": "application/json",
    Authorization: `Bearer ${paired.sessionToken}`,
    "Idempotency-Key": "cancel_before_post",
  };
  try {
    const cancel = await fetch(bridge.baseUrl + "/v1/requests", { method: "DELETE", headers });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { cancelled: true, request: null });
    const late = await fetch(bridge.baseUrl + "/v1/requests", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(late.status, 409);
    assert.equal(
      ((await late.json()) as { error: { code: string } }).error.code,
      "request_cancelled",
    );
    assert.equal(store.next(), null);
    const unauthorized = await fetch(bridge.baseUrl + "/v1/requests", {
      method: "DELETE",
      headers: { ...headers, Authorization: "Bearer wrong" },
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    await bridge.close();
  }
});
