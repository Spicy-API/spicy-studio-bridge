import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeStore } from "../src/store.js";
import {
  BridgeError,
  MAX_REQUESTS,
  MAX_WAIT_SECONDS,
  PAIR_MS,
  REQUEST_MS,
  SESSION_MS,
  clampWaitSeconds,
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
  store.connect(true);
  assert.throws(() => store.authorize(pair.sessionToken, origin), errorCode("not_paired"));
});

void test("a refreshed page can pair again: a replacement code keeps the old browser until it is used", () => {
  const { store, pair } = connected();
  const request = store.create(input, "before_refresh");
  const replacement = store.connect();
  assert.equal(replacement.paired, true);
  assert.equal(replacement.replacesExisting, true);
  assert.match(replacement.code, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  // Asking again before it is used returns the same code rather than rotating it.
  assert.equal(store.connect().code, replacement.code);
  // The current browser keeps working until someone enters the new code.
  store.authorize(pair.sessionToken, origin);
  assert.equal(store.get(request.id).status, "queued");
  // Wrong guesses still count and lock the code.
  assert.throws(() => store.pair("0000-0000-0000", origin), errorCode("pair_invalid"));
  const next = store.pair(replacement.code, "https://www.spicyapi.ai");
  assert.notEqual(next.sessionToken, pair.sessionToken);
  assert.throws(() => store.authorize(pair.sessionToken, origin), errorCode("not_paired"));
  store.authorize(next.sessionToken, "https://www.spicyapi.ai");
  assert.throws(() => store.get(request.id), errorCode("request_missing"));
  // Single use: the same code cannot pair a third browser.
  assert.throws(() => store.pair(replacement.code, origin), errorCode("pair_expired"));
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

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Active timers in this process; a finished wait must not leave one behind. */
const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

void test("waiting returns an already queued request at once without registering a waiter", async () => {
  const { store } = connected();
  const queued = store.create(input, "wait_ready");
  const started = Date.now();
  assert.equal((await store.waitForNext(30000))?.id, queued.id);
  assert.ok(Date.now() - started < 1000);
  assert.equal(store.waiting, 0);
  assert.equal(await store.waitForNext(0), null);
});

void test("a wait resolves when the browser shares a request, and the browser still sees it queued", async () => {
  const { store } = connected();
  const baseline = timers();
  const pending = store.waitForNext(30000);
  await pause(20);
  assert.equal(store.waiting, 1);
  const created = store.create(input, "wait_arrives");
  assert.equal(created.status, "queued");
  const claimed = await pending;
  assert.equal(claimed?.id, created.id);
  assert.equal(claimed?.status, "working");
  assert.equal(store.get(created.id).status, "working");
  assert.equal(store.waiting, 0);
  assert.equal(timers(), baseline);
  // An idempotent browser retry does not wake anyone or create a second request.
  assert.equal(store.create(input, "wait_arrives").id, created.id);
});

void test("a wait returns null after its timeout and clears its waiter and timer", async () => {
  const { store } = connected();
  const baseline = timers();
  const started = Date.now();
  const pending = store.waitForNext(80);
  assert.equal(timers(), baseline + 1);
  assert.equal(await pending, null);
  assert.ok(Date.now() - started >= 70);
  assert.equal(store.waiting, 0);
  assert.equal(timers(), baseline);
  // A request shared after the timeout stays queued for the next call.
  const later = store.create(input, "after_timeout");
  assert.equal(store.get(later.id).status, "queued");
});

void test("an aborted wait (cancelled MCP call or closed client) leaves no waiter, timer or claimed request", async () => {
  const { store } = connected();
  const baseline = timers();
  const controller = new AbortController();
  const pending = store.waitForNext(30000, controller.signal);
  await pause(10);
  assert.equal(store.waiting, 1);
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(store.waiting, 0);
  assert.equal(timers(), baseline);
  const created = store.create(input, "after_abort");
  assert.equal(store.get(created.id).status, "queued");
  assert.equal(store.next()?.id, created.id);
  // An already cancelled call returns at once without registering a waiter.
  assert.equal(await store.waitForNext(30000, AbortSignal.abort()), null);
  assert.equal(store.waiting, 0);
  assert.equal(timers(), baseline);
});

void test("a request claimed at the moment the call is cancelled is put back in the queue", async () => {
  const { store } = connected();
  const controller = new AbortController();
  const pending = store.waitForNext(30000, controller.signal);
  await pause(10);
  const created = store.create(input, "claimed_then_cancelled");
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(store.get(created.id).status, "queued");
  assert.equal(store.next()?.id, created.id);
});

void test("disconnecting or shutting down ends every wait with not_paired and clears it", async () => {
  const { store } = connected();
  const baseline = timers();
  const first = store.waitForNext(30000);
  const second = store.waitForNext(30000);
  await pause(10);
  assert.equal(store.waiting, 2);
  store.disconnect();
  await assert.rejects(first, errorCode("not_paired"));
  await assert.rejects(second, errorCode("not_paired"));
  assert.equal(store.waiting, 0);
  assert.equal(timers(), baseline);
  // Waiting without a paired browser fails at once, as a plain next() does.
  await assert.rejects(store.waitForNext(30000), errorCode("not_paired"));
  assert.equal(store.waiting, 0);
});

void test("two waiters share one request: one claims it and the other keeps waiting", async () => {
  const { store } = connected();
  const first = store.waitForNext(30000);
  const second = store.waitForNext(150);
  await pause(10);
  const created = store.create(input, "one_for_two");
  assert.equal((await first)?.id, created.id);
  assert.equal(store.waiting, 1);
  assert.equal(await second, null);
  assert.equal(store.waiting, 0);
});

void test("wait_seconds is clamped to whole seconds between 0 and the maximum", () => {
  assert.equal(MAX_WAIT_SECONDS, 50);
  for (const [value, expected] of [
    [undefined, 0],
    [null, 0],
    [Number.NaN, 0],
    [-5, 0],
    [0, 0],
    [2.9, 2],
    [30, 30],
    [50, 50],
    [51, 50],
    [999, 50],
    [Number.POSITIVE_INFINITY, 50],
    [Number.NEGATIVE_INFINITY, 0],
  ] as const)
    assert.equal(clampWaitSeconds(value), expected, String(value));
});
