# Studio Bridge 0.2.0 preview verification

Verified on September 30, 2026, using Node.js 22.22.1 on a macOS development host.
No real assistant login, logout, configuration write, subscription reasoning or model API call was performed.

## Completed checks

- **36 wizard tests passed:** isolated fake Codex/Claude CLIs, official argument shapes, account/API/unknown login states, confirmation, preserving other MCP entries, user-scope removal, interrupted setup and retry, read-only modes, path spaces, outdated Node fallback, invalid CLI candidate fallback, restricted/remote MCP configuration, bounded output and cancellation.
- **15 protocol tests passed:** real loopback HTTP, Origin/Host/session checks, pairing limits, modern and legacy stdio MCP, request queue, idempotency, expiration, cancellation and late results.
- **Independent installed-folder check passed:** bridge version, wizard help, macOS launcher, checksums, MCP tool discovery, browser pairing and a clearly marked simulated draft round trip.
- Targeted lint, TypeScript build, Unix launcher syntax checks and patch whitespace checks passed.
- The complete installed delivery tree was scanned for development-user identifiers and absolute home paths, including runtime lock files and source maps. No such matches were found. SpicyAPI's package and delivery text are English; upstream Zod includes its original Chinese/Japanese locale and test files.

The source-repository test commands were:

```sh
npm run build
node --test test/connect.test.mjs
node --test dist/test/*.test.js
npm run test:delivery
```

## Boundaries

Official Codex and Claude Code command availability was checked using read-only help and official documentation. The full official browser authorization round trip remains for the user to complete in their own client. Login is distinct from website pairing, and pairing does not start an assistant turn.

Windows launcher/process-tree behavior was inspected and its npm-shim branch simulated; it was not tested on a Windows desktop. Linux shell launch was exercised on the macOS host, not on a Linux desktop. Browser/organization local-network restrictions can still block pairing. Cancellation requests termination of the command's process tree but cannot undo a login that completed, close an external browser window, or guarantee control of independently detached processes.

This GitHub preview release is not published to npm. Source validation and release packaging do not
validate a real subscription writing turn or every browser and operating system combination.
