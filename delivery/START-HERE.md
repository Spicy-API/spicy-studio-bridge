# Connect your assistant to Spicy Studio

This is the **0.2.1 GitHub preview release**, with a guided connection setup. It has not been published to
npm. Keep this folder in a permanent location. You do not need an API key or to edit a configuration
file for the normal setup.

## 1. Open the connection wizard

- **macOS:** double-click `Connect-macOS.command`.
- **Windows:** double-click `Connect-Windows.cmd`.
- **Linux:** open `Connect-Linux.sh` with your file manager's **Run in Terminal** option. If that
  option is unavailable, open a terminal in this folder and run `sh Connect-Linux.sh`.

If your system asks whether to run the downloaded file, check that you received this package from
SpicyAPI. Do not disable your browser or operating system's security protections.

The wizard needs **Node.js 22.13 or newer**. If it cannot find Node, it gives the official
installer: https://nodejs.org/en/download. Install Node, then reopen the wizard. Node is not bundled
or silently installed. From an existing terminal, the equivalent entry is:

```sh
node connect.mjs
```

## 2. Choose your assistant and sign in

Choose **Codex** or **Claude Code**. The wizard finds the official CLI, including the standard macOS
Codex desktop app when it is not on PATH, and checks its version. If the official CLI is missing,
follow the official installation link shown, then retry. It does not download or run an installer
without you.

If you are not signed in, the wizard offers the official account sign-in. Complete the browser or
terminal prompts belonging to **Codex / OpenAI** or **Claude / Anthropic**, not to SpicyAPI. Your
credentials remain with that official client. The wizard never reads a credential file, asks for an
API key, prints your email, or logs you out.

If your client currently uses API or cloud-provider billing, the wizard says so. You can keep that
billing method explicitly, or choose official account login. Switching login may change the active
account in your official client. Environment or organization settings can still select API billing;
the wizard checks status again and does not call it a subscription login if that remains active. An
unknown login status is not considered success.

Your eligible subscription allowance or API billing is controlled by the official client and plan.
The bridge adds no SpicyAPI LLM charge; this is **not a promise of free model usage**.

## 3. Finish setup, then pair the website

The wizard registers and verifies only the **spicy-studio** connection through the official CLI. It
preserves other MCP connections and asks before replacing an existing same-name entry. Claude Code
uses user scope; project or managed name conflicts need review in the official client.

**Restart or reconnect the official assistant.** Signing in and saving the connection do not pair
the website or start a writing request. Tell the assistant:

> Use studio_connect to connect my Spicy Studio browser. Show me the pairing code.

In Studio on this same computer, choose **My Codex or Claude Code** and enter the code. Allow the
browser's local-network request if prompted. A code works once and expires after ten minutes. Share
the project/request you want help with, then send this second message in the official client:

> Process my next Studio request and return the draft for review.

Review the returned draft before applying it. Image/video generation stays in Studio: choose your
platform model and confirm its displayed price separately. The ordinary ChatGPT website does not
read local MCP settings; this preview needs an official local Codex or Claude Code client.

## Check, retry, or remove the connection

Open a terminal in this folder. Choose the client you use:

```sh
node connect.mjs --client codex
node connect.mjs --client claude
```

Read-only checks never log in or change configuration:

```sh
node connect.mjs --client codex --diagnose
node connect.mjs --client claude --dry-run
```

If the Codex browser sign-in does not complete, try its official device-code flow:

```sh
node connect.mjs --client codex --device-auth
```

To remove only this bridge's saved connection, with confirmation (then disconnect in Studio and
close or restart the official assistant to stop an already-running bridge):

```sh
node connect.mjs --client codex --remove
node connect.mjs --client claude --remove
```

Removal never logs out your official account. An unrelated or project-scoped same-name entry is not
removed. If you confirmed replacing an entry and setup was interrupted between removal and addition,
rerun the wizard to finish. It never rewrites all your MCP settings.

## If you get stuck

- **Cancelled or timed out during sign-in:** reopen the wizard. Ctrl-C requests termination of the
  active login command and its child processes. Close any remaining login browser window. A login
  that already completed remains in your official client; the wizard does not undo it by logging you
  out.
- **Port already in use:** close the other bridge/assistant connection, then reconnect. Keep one
  connection active. The website uses only `127.0.0.1:47321`.
- **Expired code or lost tab:** ask the assistant to call `studio_connect` with `reset: true`.
- **Waiting for the assistant:** send the second message above in the official client.
- **Browser blocks local access:** allow local-network access if supported. Organization/browser
  policies may block it. Do not disable browser security; there is no remote tunnel fallback.
- **Changed Studio account:** the website discards the old pairing; connect again for the new
  account. The bridge never reads your Studio account credentials.
- **Cancelled writing request:** Studio stops accepting the result, but you must also stop the
  running assistant turn in its official client to stop that client's usage.

## Included files

`runtime/` contains the installed bridge and exact runtime dependencies. `connect.mjs` and the three
launchers run the guided setup. `spicyapi-studio-bridge-0.2.1.tgz` is an alternative local npm
installer, not a second service to run. `SHA256SUMS` covers the package, setup scripts, launchers
and guides. `configure.mjs` and `config/` remain optional manual references; the wizard is the
normal route. Runtime dependencies retain their licenses inside `runtime/node_modules/`. See
`README.md` for protocol, privacy and official-source details. Nothing in this package generates
media, proxies an assistant subscription, or automatically starts an assistant writing turn.
