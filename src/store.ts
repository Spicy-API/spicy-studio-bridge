import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  BridgeError,
  MAX_REQUESTS,
  PAIR_MS,
  REQUEST_MS,
  SESSION_MS,
  requestInputSchema,
  resultSchema,
  type CreativeRequest,
} from "./schema.js";

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class BridgeStore {
  private pairCode = "";
  private pairExpires = 0;
  private pairAttempts = 0;
  private session: { token: string; origin: string; expiresAt: number } | undefined;
  private readonly requests = new Map<string, CreativeRequest>();
  private readonly dedupe = new Map<
    string,
    { id: string | null; body: string | null; expiresAt: number; cancelled: boolean }
  >();
  /** Pending waitForNext calls. Each entry re-checks the queue when something changes. */
  private readonly waiters = new Set<() => void>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Number of pending waits; lets tests prove that no waiter or timer is left behind. */
  get waiting(): number {
    return this.waiters.size;
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private sweep(): void {
    const now = this.now();
    if (this.session && this.session.expiresAt <= now) this.disconnect();
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(id);
    }
    for (const [key, value] of this.dedupe) {
      if (value.expiresAt <= now || (value.id !== null && !this.requests.has(value.id)))
        this.dedupe.delete(key);
    }
  }

  isPaired(): boolean {
    this.sweep();
    return this.session !== undefined;
  }

  /**
   * Issue a short-lived, single-use pairing code.
   * When a browser is already paired, the code is a replacement: the current browser keeps working until the new
   * code is entered, and only then is it disconnected. This lets a refreshed Studio page pair again without
   * weakening anything: codes are still only visible to the assistant host, single-use, expire after ten minutes,
   * lock after ten wrong attempts, and the new session is bound to the origin that entered the code.
   * reset=true disconnects the current browser immediately and clears its shared requests.
   */
  connect(reset = false): { paired: boolean; code: string; expiresAt: number; replacesExisting?: boolean } {
    this.sweep();
    if (reset) this.disconnect();
    if (this.pairExpires <= this.now() || this.pairAttempts >= 10 || !this.pairCode) {
      this.pairCode = randomBytes(6).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
      this.pairExpires = this.now() + PAIR_MS;
      this.pairAttempts = 0;
    }
    const code = { code: this.pairCode, expiresAt: this.pairExpires };
    return this.session ? { paired: true, ...code, replacesExisting: true } : { paired: false, ...code };
  }

  pair(code: string, origin: string): { sessionToken: string; expiresAt: number } {
    this.sweep();
    if (!this.pairCode || this.pairExpires <= this.now() || this.pairAttempts >= 10) {
      throw new BridgeError("pair_expired", "Ask your assistant for a new connection code.", 401);
    }
    this.pairAttempts++;
    if (!sameSecret(code.trim().toUpperCase(), this.pairCode)) {
      throw new BridgeError(
        "pair_invalid",
        "The connection code does not match. Copy it from your assistant.",
        401,
      );
    }
    // A replacement code ends the previous browser session and everything it shared.
    this.requests.clear();
    this.dedupe.clear();
    this.session = {
      token: randomBytes(32).toString("base64url"),
      origin,
      expiresAt: this.now() + SESSION_MS,
    };
    this.pairCode = "";
    this.pairExpires = 0;
    this.pairAttempts = 0;
    return { sessionToken: this.session.token, expiresAt: this.session.expiresAt };
  }

  authorize(token: string, origin: string): void {
    this.sweep();
    if (!this.session || this.session.origin !== origin || !sameSecret(token, this.session.token)) {
      throw new BridgeError("not_paired", "Connect this website to your assistant again.", 401);
    }
  }

  disconnect(): void {
    this.session = undefined;
    this.pairCode = "";
    this.pairExpires = 0;
    this.pairAttempts = 0;
    this.requests.clear();
    this.dedupe.clear();
    // Waiting assistant calls end now with a not_paired error instead of waiting for a browser that is gone.
    // Closing the local server on shutdown also disconnects, so no wait timer outlives the process.
    this.wake();
  }

  create(value: unknown, key: string): CreativeRequest {
    this.requireSession();
    this.validateKey(key);
    const parsed = requestInputSchema.safeParse(value);
    if (!parsed.success)
      throw new BridgeError(
        "invalid_request",
        "Share a project title and a shorter, valid creative request.",
      );
    const body = JSON.stringify(parsed.data);
    const previous = this.dedupe.get(key);
    if (previous) {
      if (previous.cancelled)
        throw new BridgeError(
          "request_cancelled",
          "This request was cancelled. Use a new request key only if you want to start again.",
          409,
        );
      if (previous.body !== body)
        throw new BridgeError(
          "request_key_conflict",
          "This request key was already used. Create a new request.",
          409,
        );
      return this.get(previous.id!);
    }
    if (this.dedupe.size >= MAX_REQUESTS) {
      throw new BridgeError(
        "queue_full",
        "The local queue is full. Reconnect to clear it, or wait for old requests to expire.",
        429,
      );
    }
    const now = this.now();
    const request: CreativeRequest = {
      ...parsed.data,
      id: randomUUID(),
      status: "queued",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + REQUEST_MS,
    };
    this.requests.set(request.id, request);
    this.dedupe.set(key, { id: request.id, body, expiresAt: request.expiresAt, cancelled: false });
    // Copy first so the browser always receives the queued state, even when a waiting assistant claims it at once.
    const created = structuredClone(request);
    this.wake();
    return created;
  }

  private requireSession(): void {
    this.sweep();
    if (!this.session)
      throw new BridgeError(
        "not_paired",
        "First connect the Studio website using studio_connect.",
        401,
      );
  }

  get(id: string): CreativeRequest {
    this.requireSession();
    const request = this.requests.get(id);
    if (!request)
      throw new BridgeError(
        "request_missing",
        "This request expired or was removed. Send a new request from Studio.",
        404,
      );
    return structuredClone(request);
  }

  next(): CreativeRequest | null {
    this.requireSession();
    // Never reclaim working requests automatically and consume subscription usage twice.
    const request = [...this.requests.values()].find((item) => item.status === "queued");
    if (!request) return null;
    request.status = "working";
    request.updatedAt = this.now();
    return structuredClone(request);
  }

  /**
   * Like next(), but when nothing is queued it waits up to waitMs for the browser to share a request.
   * There is no polling: the wait is woken by create() and disconnect(), and ends on timeout or when signal aborts.
   * Every exit path removes the waiter and clears its timer.
   */
  async waitForNext(waitMs: number, signal?: AbortSignal): Promise<CreativeRequest | null> {
    const ready = this.next();
    if (ready || waitMs <= 0 || signal?.aborted) return ready;
    const claimed = await new Promise<CreativeRequest | null>((resolve, reject) => {
      let done = false;
      const finish = (value: CreativeRequest | null, error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(wakeUp);
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve(value);
        else reject(error instanceof Error ? error : new Error(String(error)));
      };
      // Another waiter may win the same request; then this one keeps waiting.
      const check = (final = false) => {
        if (done) return;
        try {
          const request = this.next();
          if (request || final) finish(request);
        } catch (error) {
          finish(null, error);
        }
      };
      const wakeUp = () => check();
      const onAbort = () => finish(null);
      const timer = setTimeout(() => check(true), waitMs);
      this.waiters.add(wakeUp);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // A cancelled call never delivers its result, so put the request back instead of leaving it working forever.
    if (claimed && signal?.aborted) {
      const request = this.requests.get(claimed.id);
      if (request?.status === "working" && request.updatedAt === claimed.updatedAt) {
        request.status = "queued";
        request.updatedAt = this.now();
      }
      return null;
    }
    return claimed;
  }

  finish(id: string, value: unknown): CreativeRequest {
    const request = this.get(id);
    const parsed = resultSchema.safeParse(value);
    if (!parsed.success || (request.kind === "drama") !== (parsed.data?.type === "drama")) {
      throw new BridgeError(
        "invalid_result",
        "Return a valid result matching the requested format. Check IDs, cast references, and duration limits.",
      );
    }
    if (
      request.status === "completed" &&
      JSON.stringify(request.result) === JSON.stringify(parsed.data)
    )
      return request;
    this.requireWorking(request);
    request.status = "completed";
    request.result = parsed.data;
    request.updatedAt = this.now();
    this.requests.set(id, request);
    return structuredClone(request);
  }

  fail(id: string, message: string): CreativeRequest {
    const request = this.get(id);
    if (request.status === "failed" && request.error?.message === message) return request;
    this.requireWorking(request);
    if (!message.trim() || message.length > 500)
      throw new BridgeError("invalid_error", "Describe the problem in 500 characters or fewer.");
    request.status = "failed";
    request.error = { code: "assistant_failed", message };
    request.updatedAt = this.now();
    this.requests.set(id, request);
    return structuredClone(request);
  }

  cancel(id: string): CreativeRequest {
    const request = this.get(id);
    if (request.status === "queued" || request.status === "working") {
      request.status = "cancelled";
      request.updatedAt = this.now();
      this.requests.set(id, request);
      for (const value of this.dedupe.values()) if (value.id === id) value.cancelled = true;
    }
    return structuredClone(request);
  }

  cancelKey(key: string): { cancelled: boolean; request: CreativeRequest | null } {
    this.requireSession();
    this.validateKey(key);
    const previous = this.dedupe.get(key);
    if (previous?.id) {
      const request = this.cancel(previous.id);
      return { cancelled: request.status === "cancelled", request };
    }
    if (!previous && this.dedupe.size >= MAX_REQUESTS)
      throw new BridgeError(
        "queue_full",
        "The local queue is full. Reconnect to clear shared requests.",
        429,
      );
    if (!previous)
      this.dedupe.set(key, {
        id: null,
        body: null,
        expiresAt: this.now() + REQUEST_MS,
        cancelled: true,
      });
    return { cancelled: true, request: null };
  }

  private validateKey(key: string): void {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
      throw new BridgeError("invalid_request_key", "Use a new request key for each creative task.");
  }

  private requireWorking(request: CreativeRequest): void {
    if (request.status !== "working")
      throw new BridgeError(
        "request_not_working",
        "The request is no longer in progress. Do not submit a late result or retry it automatically.",
        409,
      );
  }
}
