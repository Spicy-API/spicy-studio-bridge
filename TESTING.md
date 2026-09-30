# Verification and platform boundaries

The source contains isolated fake-CLI tests and real loopback HTTP/MCP protocol tests. They do not
log in, log out, edit a real assistant configuration, call an LLM, or generate paid media.

```sh
npm ci --ignore-scripts
npm run verify
npm run bundle
```

`verify` checks the English public-source guard (including rejection controls), strict TypeScript,
52 setup-wizard cases, 28 protocol cases, and the fixed-port installed-client flow. Source tests
exercise official command arguments, account/API/unknown authentication, replacement confirmation,
configuration isolation, paths with spaces, cancellation, timeouts, pairing and replacement pairing
codes, queue ownership, idempotency, late results and a busy local port. Cursor and Gemini CLI setup is
tested against temporary settings files (other settings kept, backups, files with comments refused,
removal of only this entry). The Claude Code check uses the recorded `claude mcp get` layout of Claude
Code 2.1.285. The fixed-port test needs local port 47321 to be available.

`studio_next_request` with `wait_seconds` is tested in the store and over real stdio and HTTP: an already queued
request returns at once, a request shared during the wait resolves it (the browser still receives `queued`), an expired
wait returns `request: null` with the instruction to call again with `wait_seconds` set to 30, out-of-range values are
clamped, and cancelled calls, closed clients, browser disconnects and shutdown leave no waiter or timer behind. A request
claimed at the moment its call is cancelled goes back to the queue.

The Codex tool-approval line is tested against a temporary `CODEX_HOME`: a fresh write adds
`default_tools_approval_mode = "approve"` to the `spicy-studio` table only (the global policy and other servers keep
their values), a second run writes nothing, a value the user already chose is kept (also when the entry is replaced),
a file with duplicate tables is never edited, and the backup is restored when Codex no longer loads the file. The
real Codex CLI 0.159.0 was checked the same way against a temporary `CODEX_HOME`: `codex mcp add` rewrites the entry
without this key, `codex mcp get` (text output) shows it, and Codex refuses to load `config.toml` when the value is not
`auto`, `prompt`, `writes` or `approve`.

The 0.2.2 implementation was tested on macOS with Node.js 24.21.0. Read-only official CLI help was
checked separately (`cursor-agent --help` and `cursor-agent mcp --help`, version 2025.09.12). Gemini CLI
was not installed on the test machine; its setup follows the official documentation and the settings-file
tests. The package contains JavaScript and platform launchers; no native Node addon or bundled Node
runtime is included. Node.js 22.13 or newer is required on macOS, Windows and Linux.

Windows launcher and process-tree branches were simulated and reviewed, not tested on a Windows
desktop. The Linux shell launcher was exercised on a macOS host, not on a Linux desktop. GitHub CI
runs Node 22 and 24 on Ubuntu when triggered; a prepared workflow is not itself evidence of a
completed CI run. A real account login and subscription writing turn still require the user's own
assistant app. Browser and organization local-network restrictions may block website pairing.

The bundle retains upstream licenses, code and runtime locale translations. Only source maps and
Zod source-test directories are removed. A successful build or fake draft does not establish
model quality, subscription eligibility, or cross-platform desktop authorization behavior.
