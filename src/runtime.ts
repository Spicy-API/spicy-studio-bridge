import { BridgeError, DEFAULT_PORT } from "./schema.js";
import { startBridgeHttp, type BridgeHttpHandle } from "./http.js";
import type { BridgeStore } from "./store.js";

export interface BridgeConnection {
  /** Resolve the local browser address, starting the loopback server on first use. */
  ensure(): Promise<string>;
}

type Starter = (
  store: BridgeStore,
  options: { port?: number; origins?: readonly string[] },
) => Promise<BridgeHttpHandle>;

/**
 * Starts the loopback HTTP server lazily, on the first tool call, instead of when the assistant launches the bridge.
 *
 * Every assistant session starts its own bridge process, but only one process can own the fixed port that the
 * Studio website connects to. Binding on first use means sessions that never use Studio never compete for it, and
 * a busy port becomes a clear tool error instead of a failed MCP server. A later call retries, so closing the other
 * session is enough to continue here.
 */
export class BridgeRuntime implements BridgeConnection {
  private handle: BridgeHttpHandle | undefined;
  private pending: Promise<BridgeHttpHandle> | undefined;
  private closed = false;

  constructor(
    private readonly store: BridgeStore,
    private readonly options: { port?: number; origins?: readonly string[] } = {},
    private readonly start: Starter = startBridgeHttp,
  ) {}

  get baseUrl(): string | undefined {
    return this.handle?.baseUrl;
  }

  async ensure(): Promise<string> {
    if (this.closed) throw new BridgeError("bridge_closed", "The Studio connection has closed. Restart your assistant session.", 503);
    if (this.handle) return this.handle.baseUrl;
    const pending = (this.pending ??= this.start(this.store, this.options));
    try {
      const handle = await pending;
      if (this.closed) {
        await handle.close();
        throw new BridgeError("bridge_closed", "The Studio connection has closed. Restart your assistant session.", 503);
      }
      this.handle = handle;
      return handle.baseUrl;
    } catch (error) {
      throw portError(error, this.options.port ?? DEFAULT_PORT);
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const handle = this.handle ?? (await this.pending?.catch(() => undefined));
    this.handle = undefined;
    await handle?.close();
  }
}

export function portError(error: unknown, port: number): BridgeError {
  if (error instanceof BridgeError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "EADDRINUSE") {
    return new BridgeError(
      "port_in_use",
      `Another assistant session on this computer is already connected to Spicy Studio (local port ${port}). ` +
        "Use that session, or close it and ask again here.",
      409,
    );
  }
  return new BridgeError(
    "port_unavailable",
    "The local Studio connection could not start. Close other assistant sessions that use Spicy Studio, then try again.",
    500,
  );
}
