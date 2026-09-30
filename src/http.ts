import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  BridgeError,
  DEFAULT_ORIGINS,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  VERSION,
  parseOrigin,
  requestIdSchema,
} from "./schema.js";
import type { BridgeStore } from "./store.js";

export interface BridgeHttpHandle {
  baseUrl: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" ||
    request.headers["content-encoding"]
  ) {
    throw new BridgeError(
      "invalid_content_type",
      "Send uncompressed JSON to the local connection.",
      415,
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onAborted);
    };
    const fail = (error: BridgeError) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        fail(new BridgeError("request_too_large", "Share a shorter creative request.", 413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new BridgeError("invalid_json", "The request must be complete JSON."));
      }
    };
    const onAborted = () =>
      fail(new BridgeError("request_interrupted", "The request was interrupted. Try again.", 400));
    const timer = setTimeout(
      () => fail(new BridgeError("request_timeout", "The request took too long. Try again.", 408)),
      5000,
    );
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onAborted);
  });
}

export async function startBridgeHttp(
  store: BridgeStore,
  options: { port?: number; origins?: readonly string[] } = {},
): Promise<BridgeHttpHandle> {
  const origins = new Set((options.origins ?? DEFAULT_ORIGINS).map(parseOrigin));
  if (!origins.size) throw new Error("Allow at least one exact Studio website origin.");
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Choose a valid local port.");
  let actualPort = port;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (
        request.socket.remoteAddress !== "127.0.0.1" ||
        request.headers.host !== `127.0.0.1:${actualPort}`
      ) {
        throw new BridgeError(
          "invalid_host",
          "Use the exact local address shown by your assistant.",
          403,
        );
      }
      const origin = request.headers.origin;
      if (!origin || !origins.has(origin))
        throw new BridgeError(
          "origin_not_allowed",
          "This website is not allowed to connect. Use your Studio website.",
          403,
        );
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        const method = request.headers["access-control-request-method"];
        const headers = (request.headers["access-control-request-headers"] ?? "")
          .toString()
          .toLowerCase()
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean);
        if (
          !method ||
          !["GET", "POST", "DELETE"].includes(method) ||
          headers.some((h) => !["content-type", "authorization", "idempotency-key"].includes(h))
        ) {
          throw new BridgeError(
            "preflight_rejected",
            "This browser request is not supported.",
            403,
          );
        }
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, Idempotency-Key",
        );
        response.setHeader("Access-Control-Max-Age", "600");
        if (request.headers["access-control-request-private-network"] === "true")
          response.setHeader("Access-Control-Allow-Private-Network", "true");
        response.writeHead(204);
        response.end();
        return;
      }
      const path = request.url ?? "";
      if (!/^\/v1\/[a-z0-9/-]+$/.test(path))
        throw new BridgeError("not_found", "This local endpoint does not exist.", 404);
      if (request.method === "GET" && path === "/v1/health") {
        json(response, 200, {
          name: "spicyapi-studio-bridge",
          version: VERSION,
          kinds: ["drama", "creative"],
          paired: store.isPaired(),
        });
        return;
      }
      if (request.method === "POST" && path === "/v1/pair") {
        const body = z
          .strictObject({ code: z.string().min(1).max(32) })
          .safeParse(await readBody(request));
        if (!body.success)
          throw new BridgeError("invalid_pair", "Copy the connection code from your assistant.");
        json(response, 200, store.pair(body.data.code, origin));
        return;
      }
      const authorization = request.headers.authorization ?? "";
      store.authorize(authorization.startsWith("Bearer ") ? authorization.slice(7) : "", origin);
      if (request.method === "DELETE" && path === "/v1/session") {
        store.disconnect();
        json(response, 200, { disconnected: true });
        return;
      }
      if (request.method === "DELETE" && path === "/v1/requests") {
        const key = request.headers["idempotency-key"];
        json(response, 200, store.cancelKey(typeof key === "string" ? key : ""));
        return;
      }
      if (request.method === "POST" && path === "/v1/requests") {
        const key = request.headers["idempotency-key"];
        const body = await readBody(request);
        // Pairing may have changed while the body was arriving.
        store.authorize(authorization.slice(7), origin);
        json(response, 200, store.create(body, typeof key === "string" ? key : ""));
        return;
      }
      const match = /^\/v1\/requests\/([^/]+)$/.exec(path);
      if (match && requestIdSchema.safeParse(match[1]).success) {
        if (request.method === "GET") {
          json(response, 200, store.get(match[1]!));
          return;
        }
        if (request.method === "DELETE") {
          json(response, 200, store.cancel(match[1]!));
          return;
        }
      }
      throw new BridgeError("not_found", "This local endpoint does not exist.", 404);
    } catch (error) {
      if (response.destroyed) return;
      const safe =
        error instanceof BridgeError
          ? error
          : new BridgeError(
              "connection_error",
              "The local connection could not complete this request.",
              500,
            );
      response.setHeader("Connection", "close");
      json(response, safe.status, { error: { code: safe.code, message: safe.message } });
      if (!request.complete) response.once("finish", () => request.destroy());
    }
  };
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 10000, headersTimeout: 10000 },
    (request, response) => {
      void handle(request, response);
    },
  );
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start the local connection.");
  actualPort = address.port;
  // Expired projects leave memory even if the browser stops polling.
  const sweep = setInterval(() => store.isPaired(), 15000);
  sweep.unref();
  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    async close() {
      clearInterval(sweep);
      store.disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
