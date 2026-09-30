# Changelog

## 0.2.2 (2026-09-30)

- **The assistant can wait for a request.** `studio_next_request` accepts `wait_seconds` (0 to 50, default 0; other
  values are clamped). When nothing is queued it waits for the browser to share a request instead of returning at once,
  without polling, and ends early when the call is cancelled, the client or browser disconnects, or the bridge shuts
  down. An empty answer tells the model to call again with `wait_seconds` set to 30, so it no longer gives up when the
  user sends the message before sharing. The setup wizard, MCP instructions and guides use this in their next-request
  message.
- **Codex non-interactive runs.** The Codex setup now adds `default_tools_approval_mode = "approve"` to the
  `[mcp_servers.spicy-studio]` table in `config.toml` (after a backup), so `codex exec` no longer rejects the Studio
  tools with "requires approval, but approval policy is never". It applies to this entry only; the global approval
  policy is unchanged. A value the user already chose is kept and reported, unusual files are left untouched, and the
  previous file is restored if Codex no longer loads it. `configure.mjs` and `config/codex.example.toml` include the
  line.
- **More assistant apps.** Guided setup for Cursor (editor and `cursor-agent`, `~/.cursor/mcp.json`) and Gemini CLI
  (`~/.gemini/settings.json`): the wizard adds only the `spicy-studio` entry, keeps a timestamped backup of the previous
  file, never rewrites a file with comments, and reads the entry back. `node configure.mjs --client <codex|claude|cursor|gemini|generic>`
  prints a ready-to-paste entry for one app, including any other local stdio MCP client.
- **Claude Code verification fix.** Claude Code 2.1.x prints an empty `Environment:` heading and a "To remove this
  server" hint in `claude mcp get`; the wizard no longer reads that as a conflicting entry and reports success.
- **Codex in the ChatGPT desktop app.** The wizard now finds the Codex CLI bundled at
  `ChatGPT.app/Contents/Resources/codex-cli` (using its `codex-package.json` entrypoint) when `codex` is not on PATH.
- **Pairing after a page refresh.** `studio_connect` always returns a code. When a browser is already paired, the code
  is a replacement that ends the previous session only once it is entered; `reset: true` still disconnects immediately.
  Codes remain single-use, expire after ten minutes, lock after ten wrong attempts and bind the session to the entering
  origin.
- **Several assistant sessions.** The local port opens on the first Studio tool call instead of at startup. When another
  session already holds it, the MCP server still starts and every tool returns a clear `port_in_use` error; a later call
  succeeds once the other session closes.
- **Content instructions match Studio.** The MCP instructions ask for original fiction with clearly adult characters
  and no real, identifiable people.
- The wizard and `configure.mjs` read the bridge version from one constant.

## 0.2.1

- GitHub preview release with guided setup for Codex and Claude Code, browser pairing and the five Studio MCP tools.
