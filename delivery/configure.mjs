import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error("Use Node.js 22.13 or newer, then run this script again.");
  process.exit(1);
}
const entry = fileURLToPath(
  new URL("./runtime/node_modules/@spicyapi/studio-bridge/dist/src/cli.js", import.meta.url),
);
if (!existsSync(entry)) {
  console.error(
    "The runtime folder is missing. Restore the complete delivery folder before continuing.",
  );
  process.exit(1);
}
const checked = spawnSync(process.execPath, [entry, "--version"], {
  encoding: "utf8",
  timeout: 10000,
  windowsHide: true,
});
if (checked.status !== 0 || checked.stdout.trim() !== "0.2.1") {
  console.error(
    "The included bridge did not pass its local version check. Restore the delivery folder.",
  );
  process.exit(1);
}
console.log("Bridge 0.2.1 is ready. Nothing was installed, connected, or billed.\n");
console.log("Codex MCP configuration (TOML):\n");
console.log(
  `[mcp_servers.spicy-studio]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}]\n`,
);
console.log("Claude Code project configuration (.mcp.json):\n");
console.log(
  JSON.stringify(
    { mcpServers: { "spicy-studio": { type: "stdio", command: process.execPath, args: [entry] } } },
    null,
    2,
  ),
);
console.log(
  "\nKeep this folder in place. Copy only the configuration for your client, then reconnect that client.",
);
