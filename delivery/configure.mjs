import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { spawnSync } from "node:child_process";
import { BRIDGE_VERSION, SERVER_NAME, codexConfigSnippet, connectionSnippet } from "./lib/connect-core.mjs";

// Prints ready-to-paste connection settings with the absolute paths of this computer. Nothing is installed or changed.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error("Use Node.js 22.13 or newer, then run this script again.");
  process.exit(1);
}
const args = process.argv.slice(2);
const clients = ["codex", "claude", "cursor", "gemini", "generic"];
const chosen = args[0] === "--client" ? args[1] : args.length ? "invalid" : "all";
if (chosen !== "all" && !clients.includes(chosen)) {
  console.error(`Usage: node configure.mjs [--client ${clients.join("|")}]`);
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
if (checked.status !== 0 || checked.stdout.trim() !== BRIDGE_VERSION) {
  console.error(
    "The included bridge did not pass its local version check. Restore the delivery folder.",
  );
  process.exit(1);
}
const node = process.execPath;
const json = connectionSnippet(node, entry);
const sections = {
  codex: [
    "Codex (CLI, IDE extension and desktop app share ~/.codex/config.toml). Guided setup: node connect.mjs --client codex\n" +
      'The last line lets codex exec call the Studio tools without an approval prompt. It applies to this entry only; use "prompt" to be asked each time.',
    codexConfigSnippet(node, entry),
  ],
  claude: [
    "Claude Code. Guided setup: node connect.mjs --client claude. Or run this official command:",
    `claude mcp add --scope user --transport stdio ${SERVER_NAME} -- ${JSON.stringify(node)} ${JSON.stringify(entry)}`,
  ],
  cursor: [
    "Cursor editor and cursor-agent read ~/.cursor/mcp.json. Guided setup: node connect.mjs --client cursor. Or merge:",
    json,
  ],
  gemini: [
    "Gemini CLI reads ~/.gemini/settings.json. Guided setup: node connect.mjs --client gemini. Or merge:",
    json,
  ],
  generic: [
    "Any app that runs local (stdio) MCP servers. Add this entry to its MCP settings; some apps use a different top-level key:",
    json,
  ],
};
console.log(`Bridge ${BRIDGE_VERSION} is ready. Nothing was installed, connected, or billed.\n`);
for (const name of chosen === "all" ? clients : [chosen]) {
  const [title, body] = sections[name];
  console.log(`${title}\n\n${body}\n`);
}
console.log(
  "Keep this folder in place. Copy only the configuration for your app, then restart or reconnect that app.",
);
