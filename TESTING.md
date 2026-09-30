# Verification and platform boundaries

The source contains isolated fake-CLI tests and real loopback HTTP/MCP protocol tests. They do not
log in, log out, edit a real assistant configuration, call an LLM, or generate paid media.

```sh
npm ci --ignore-scripts
npm run verify
npm run bundle
```

`verify` checks the English public-source guard (including rejection controls), strict TypeScript,
36 setup-wizard cases, 15 protocol cases, and the fixed-port installed-client flow. Source tests
exercise official command arguments, account/API/unknown authentication, replacement confirmation,
configuration isolation, paths with spaces, cancellation, timeouts, pairing, queue ownership,
idempotency and late results. The fixed-port test needs local port 47321 to be available.

The 0.2.0 implementation was tested on macOS with Node.js 22.22.1. Read-only official CLI help was
checked separately. The package contains JavaScript and platform launchers; no native Node addon
or bundled Node runtime is included. Node.js 22.13 or newer is required on macOS, Windows and Linux.

Windows launcher and process-tree branches were simulated and reviewed, not tested on a Windows
desktop. The Linux shell launcher was exercised on a macOS host, not on a Linux desktop. GitHub CI
runs Node 22 and 24 on Ubuntu when triggered; a prepared workflow is not itself evidence of a
completed CI run. A real official account login and subscription writing turn still require the
user's own client. Browser and organization local-network restrictions may block website pairing.

The bundle retains upstream licenses, code and runtime locale translations. Only source maps and
Zod source-test directories are removed. A successful build or fake draft does not establish
model quality, subscription eligibility, or cross-platform desktop authorization behavior.
