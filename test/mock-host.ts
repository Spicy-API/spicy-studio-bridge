import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { BridgeStore } from "../src/store.js";
import { startBridgeHttp } from "../src/http.js";
import { createBridgeMcpFactory } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { parseOrigin, type CreativeRequest } from "../src/schema.js";

// This development-only host never calls a model. Its output is deliberately marked DEMO.
async function main() {
  const child = process.argv[2] === "--bridge-child";
  const args = process.argv.slice(child ? 3 : 2);
  const origins = (args.length ? args : ["http://127.0.0.1:3012", "http://127.0.0.1:3187"]).map(
    parseOrigin,
  );
  if (
    origins.some(
      (origin) => !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname),
    )
  )
    throw new Error("The demo host only accepts local development origins.");
  if (child) {
    const store = new BridgeStore();
    const http = await startBridgeHttp(store, { origins });
    const mcp = serveStdio(createBridgeMcpFactory(store, http.baseUrl), {
      legacy: "serve",
      transport: new StdioServerTransport(process.stdin, process.stdout),
    });
    const close = () => {
      void Promise.allSettled([mcp.close(), http.close()]).then(() => process.stdin.pause());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    process.stdin.once("end", close);
    return;
  }
  const client = new Client({ name: "studio-demo-host", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), "--bridge-child", ...origins],
    env: { PATH: process.env.PATH ?? "" },
    stderr: "pipe",
  });
  await client.connect(transport);
  const connection = await client.callTool({ name: "studio_connect", arguments: {} });
  console.log("DEMO ONLY: no model or subscription is used.");
  console.log(JSON.stringify(connection.structuredContent));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (command: string) => {
    if (command.trim() === "reset")
      void client
        .callTool({ name: "studio_connect", arguments: { reset: true } })
        .then((result) => console.log(JSON.stringify(result.structuredContent)));
  });
  let closing = false;
  const close = () => {
    closing = true;
    process.stdin.pause();
    void client.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  while (!closing) {
    const response = await client.callTool({ name: "studio_next_request", arguments: {} });
    const request = (response.structuredContent as { request?: CreativeRequest | null }).request;
    if (request) {
      const result =
        request.kind === "creative"
          ? {
              type: "text",
              text: "DEMO: A fixed creative draft from the local test host. No AI model was called.",
            }
          : {
              type: "drama",
              script: {
                version: 1,
                title: "DEMO — Last Train",
                logline: "DEMO: Two adults reunite.",
                style: "Cinematic, warm light.",
                characters: [
                  {
                    id: "c1",
                    name: "Alex",
                    description: "An adult in their thirties in an evening coat.",
                  },
                ],
                shots: [
                  {
                    id: "s1",
                    title: "Arrival",
                    description: "Rain at the station.",
                    prompt: "Alex turns toward a familiar adult silhouette.",
                    characterIds: ["c1"],
                    durationSeconds: 6,
                    dialogue: [],
                  },
                ],
              },
            };
      const submitted = await client.callTool({
        name: "studio_submit_result",
        arguments: { id: request.id, result },
      });
      console.log(
        submitted.isError
          ? "Demo request was not accepted."
          : "Demo draft returned for browser review.",
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}
void main().catch(() => {
  console.error("The demo host stopped. Reconnect it if needed.");
  process.exitCode = 1;
});
