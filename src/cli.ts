#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DEFAULT_ORIGINS, DEFAULT_PORT, VERSION, parseOrigin } from "./schema.js";
import { BridgeStore } from "./store.js";
import { BridgeRuntime } from "./runtime.js";
import { createBridgeMcpFactory } from "./mcp.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    console.log(VERSION);
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      [
        "Studio local bridge",
        "",
        "Configure your assistant app (Codex, Claude Code, Cursor, Gemini CLI or any local MCP client) to run this file",
        "with Node.js 22.13 or newer.",
        "",
        "Options:",
        "  --port PORT       Local port (default 47321)",
        "  --origin ORIGIN   Add one exact HTTPS or local development origin (repeatable)",
        "  --version",
        "",
        "The bridge never reads assistant credentials or launches a model. The local port opens on the first Studio tool",
        "call, so only the session you actually use holds it. Ask your assistant to call studio_connect, then paste its",
        "code into Studio.",
      ].join("\n"),
    );
    return;
  }
  let port = DEFAULT_PORT;
  const origins: string[] = [...DEFAULT_ORIGINS];
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index],
      value = args[index + 1];
    if (!value) throw new Error("An option value is missing. Run with --help for instructions.");
    if (option === "--origin") origins.push(parseOrigin(value));
    else if (option === "--port" && /^\d{1,5}$/.test(value) && Number(value) <= 65535)
      port = Number(value);
    else throw new Error("Unsupported option. Run with --help for instructions.");
  }
  const store = new BridgeStore();
  // The port is bound on the first tool call. A busy port no longer stops the MCP server from starting.
  const runtime = new BridgeRuntime(store, { port, origins });
  const mcp = serveStdio(createBridgeMcpFactory(store, runtime), {
    legacy: "serve",
    maxSubscriptions: 8,
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 1024 * 1024,
    }),
    onerror: () => {
      console.error(
        "The assistant connection encountered an invalid message. Reconnect if needed.",
      );
    },
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void Promise.allSettled([mcp.close(), runtime.close()]).then(() => {
      process.stdin.pause();
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  process.stdin.once("close", close);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The Studio connection could not start.");
  process.exitCode = 1;
});
