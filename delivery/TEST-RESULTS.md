# Studio Bridge 0.2.2 preview verification

Verified on September 30, 2026, using Node.js 24.21.0 on a macOS development host.
No real assistant login, logout, configuration write, subscription reasoning or model API call was performed.

## Completed checks

- **52 wizard tests passed:** isolated fake Codex/Claude CLIs, official argument shapes, account/API/unknown login states, confirmation, preserving other MCP entries, user-scope removal, interrupted setup and retry, read-only modes, path spaces, outdated Node fallback, invalid CLI candidate fallback, restricted/remote MCP configuration, bounded output and cancellation. New in 0.2.2: the recorded Claude Code 2.1.285 `mcp get` layout, the Codex CLI bundled in the ChatGPT desktop app, Cursor / Gemini CLI settings files (backup, comments refused, idempotent, removal), and the Codex `default_tools_approval_mode = "approve"` line on the `spicy-studio` entry only (fresh write, idempotent rerun, existing value kept, unusual files untouched, restore when Codex rejects the key).
- **28 protocol tests passed:** real loopback HTTP, Origin/Host/session checks, pairing limits, replacement pairing codes, modern and legacy stdio MCP, a busy local port reported as a tool error with recovery, request queue, idempotency, expiration, cancellation and late results. New in 0.2.2: `studio_next_request` `wait_seconds` (immediate return, arrival during the wait, timeout with the call-again message, clamping, cancellation, client disconnect, browser disconnect, no leaked waiter or timer).
- **Fixed-port installed-client check passed:** MCP tool discovery, browser pairing, a clearly marked simulated draft round trip and session replacement.

The source-repository test command was:

```sh
npm run verify
```

The desktop bundle (`npm run bundle`) was not rebuilt for this version in this pass; rebuild and run `scripts/check-bundle.mjs` before publishing a release.

## Boundaries

Official Codex and Claude Code command availability was checked using read-only help and official documentation. `cursor-agent --help` was read locally; Gemini CLI was checked against its official documentation only. The full official browser authorization round trip remains for the user to complete in their own client. Login is distinct from website pairing, and pairing does not start an assistant turn.

Windows launcher/process-tree behavior was inspected and its npm-shim branch simulated; it was not tested on a Windows desktop. Linux shell launch was exercised on the macOS host, not on a Linux desktop. Browser/organization local-network restrictions can still block pairing. Cancellation requests termination of the command's process tree but cannot undo a login that completed, close an external browser window, or guarantee control of independently detached processes.

This GitHub preview release is not published to npm. Source validation and release packaging do not
validate a real subscription writing turn or every browser and operating system combination.
