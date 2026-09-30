import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeStore } from "../src/store.js";
import {
  BridgeError,
  MAX_REQUESTS,
  PAIR_MS,
  REQUEST_MS,
  SESSION_MS,
  dramaScriptSchema,
  parseOrigin,
} from "../src/schema.js";

const origin = "https://spicyapi.ai";
const input = {
  kind: "creative",
  project: { id: "board1", title: "A scene" },
  prompt: { system: "Write one original scene.", user: "A reunion in the rain." },
};
function connected(now: () => number = Date.now) {
  const store = new BridgeStore(now);
  const { code } = store.connect();
  assert.ok(code);
  const pair = store.pair(code, origin);
  return { store, pair, code };
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof BridgeError && error.code === code;
}

void test("pairing is one-use and tokens are bound to an exact origin", () => {
  const { store, pair, code } = connected();
  store.authorize(pair.sessionToken, origin);
  assert.throws(
    () => store.authorize(pair.sessionToken, "https://www.spicyapi.ai"),
    errorCode("not_paired"),
  );
  assert.throws(() => store.authorize("wrong", origin), errorCode("not_paired"));
  assert.throws(() => store.pair(code, origin), errorCode("pair_expired"));
  assert.deepEqual(store.connect(), { paired: true });
  store.connect(true);
  assert.throws(() => store.authorize(pair.sessionToken, origin), errorCode("not_paired"));
});

void test("pairing expires and locks after ten attempts until renewed by the host", () => {
  let now = 1000;
  const store = new BridgeStore(() => now);
  const first = store.connect();
  assert.ok(first.code);
  now += PAIR_MS;
  assert.throws(() => store.pair(first.code!, origin), errorCode("pair_expired"));
  const second = store.connect();
  for (let n = 0; n < 10; n++)
    assert.throws(() => store.pair("bad", origin), errorCode("pair_invalid"));
  assert.throws(() => store.pair(second.code!, origin), errorCode("pair_expired"));
  assert.notEqual(store.connect().code, second.code);
});

void test("idempotency prevents double work and conflicting reuse fails", () => {
  const { store } = connected();
  const first = store.create(input, "request_1");
  assert.equal(store.create(input, "request_1").id, first.id);
  assert.throws(
    () => store.create({ ...input, kind: "drama" }, "request_1"),
    errorCode("request_key_conflict"),
  );
  assert.equal(store.next()?.id, first.id);
  assert.equal(store.next(), null);
  assert.equal(store.get(first.id).status, "working");
  const result = { type: "text", text: "A completed creative draft." };
  assert.equal(store.finish(first.id, result).status, "completed");
  assert.equal(store.finish(first.id, result).status, "completed");
  assert.throws(
    () => store.finish(first.id, { ...result, text: "Changed" }),
    errorCode("request_not_working"),
  );
});

void test("cancellation rejects late output without silently repeating a request", () => {
  const { store } = connected();
  const request = store.create(input, "cancel_1");
  store.next();
  assert.equal(store.cancel(request.id).status, "cancelled");
  assert.throws(
    () => store.finish(request.id, { type: "text", text: "late" }),
    errorCode("request_not_working"),
  );
  assert.throws(() => store.fail(request.id, "late failure"), errorCode("request_not_working"));
  assert.equal(store.next(), null);
  assert.throws(() => store.create(input, "cancel_1"), errorCode("request_cancelled"));
});

void test("queue and lifetime bounds clear shared data", () => {
  let now = 1000;
  const { store, pair } = connected(() => now);
  for (let i = 0; i < MAX_REQUESTS; i++) store.create(input, `request_${i}`);
  assert.throws(() => store.create(input, "overflow_key"), errorCode("queue_full"));
  const id = store.next()!.id;
  now += REQUEST_MS;
  assert.throws(() => store.get(id), errorCode("request_missing"));
  assert.equal(store.next(), null);
  store.create(input, "new_request");
  now += SESSION_MS;
  assert.throws(() => store.authorize(pair.sessionToken, origin), errorCode("not_paired"));
  assert.equal(store.isPaired(), false);
});

void test("strict input does not accept execution, account credentials, or extra project data", () => {
  const { store } = connected();
  for (const bad of [
    { ...input, apiKey: "secret" },
    { ...input, command: "sh" },
    { ...input, project: { ...input.project, history: [] } },
    { ...input, prompt: { system: "ok", user: "x".repeat(48001) } },
  ]) {
    assert.throws(() => store.create(bad, "request_bad"), errorCode("invalid_request"));
  }
});

const script = {
  version: 1,
  title: "A reunion",
  logline: "Two adults reunite.",
  style: "Cinematic",
  characters: [{ id: "c1", name: "Alex", description: "An adult in a covered evening coat." }],
  shots: [
    {
      id: "s1",
      title: "Arrival",
      description: "A rain-soaked station",
      prompt: "Alex sees a familiar silhouette.",
      characterIds: ["c1"],
      durationSeconds: 6,
      dialogue: [{ characterId: "c1", text: "You came." }],
    },
  ],
};

void test("drama output validates identity, references, duration, and unknown fields", () => {
  assert.equal(dramaScriptSchema.safeParse(script).success, true);
  assert.equal(
    dramaScriptSchema.safeParse({
      ...script,
      characters: [],
      shots: [{ ...script.shots[0], characterIds: [], dialogue: [], narration: "" }],
    }).success,
    true,
  );
  for (const bad of [
    { ...script, characters: [...script.characters, ...script.characters] },
    { ...script, model: "pretend-model" },
    { ...script, shots: [{ ...script.shots[0], characterIds: ["missing"] }] },
    { ...script, shots: [{ ...script.shots[0], durationSeconds: 121 }] },
    {
      ...script,
      shots: Array.from({ length: 6 }, (_, i) => ({
        ...script.shots[0],
        id: `s${i}`,
        durationSeconds: 101,
      })),
    },
    { ...script, title: "bad\u0000title" },
  ])
    assert.equal(dramaScriptSchema.safeParse(bad).success, false);
  const { store } = connected();
  const request = store.create({ ...input, kind: "drama" }, "drama_req");
  store.next();
  assert.throws(
    () => store.finish(request.id, { type: "text", text: "wrong type" }),
    errorCode("invalid_result"),
  );
  assert.equal(store.finish(request.id, { type: "drama", script }).status, "completed");
});

void test("origin options never allow wildcard, null, paths, or insecure remote origins", () => {
  for (const good of [
    origin,
    "http://localhost:3000",
    "http://127.0.0.1:3100",
    "https://preview.example.com",
  ])
    assert.equal(parseOrigin(good), good);
  for (const bad of [
    "null",
    "*",
    "https://*.example.com",
    "http://remote.example.com",
    origin + "/",
    origin + "/studio",
    "https://user:pass@example.com",
    "https://example.com?token=x",
  ])
    assert.throws(() => parseOrigin(bad));
});

void test("cancel by request key blocks a late submission before it receives an ID", () => {
  const { store } = connected();
  assert.deepEqual(store.cancelKey("late_key"), { cancelled: true, request: null });
  assert.throws(() => store.create(input, "late_key"), errorCode("request_cancelled"));
  assert.equal(store.next(), null);
  const created = store.create(input, "known_key");
  assert.equal(store.cancelKey("known_key").request?.id, created.id);
  assert.equal(store.get(created.id).status, "cancelled");
  assert.equal(store.cancelKey("known_key").cancelled, true);
  const completed = store.create(input, "done_key");
  store.next();
  store.finish(completed.id, { type: "text", text: "A draft" });
  assert.equal(store.cancelKey("done_key").cancelled, false);
  assert.equal(store.get(completed.id).status, "completed");
});

void test("cancellation tombstones are bounded and expire with request lifetime", () => {
  let now = 1000;
  const { store } = connected(() => now);
  for (let n = 0; n < MAX_REQUESTS; n++) store.cancelKey(`cancel_${n}`);
  assert.throws(() => store.cancelKey("overflow_key"), errorCode("queue_full"));
  assert.throws(() => store.create(input, "cancel_0"), errorCode("request_cancelled"));
  now += REQUEST_MS;
  assert.equal(store.create(input, "cancel_0").status, "queued");
});
