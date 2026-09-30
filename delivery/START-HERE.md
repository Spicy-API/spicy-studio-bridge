# Connect your AI to Spicy Studio

This is the **0.2.2 GitHub preview release**, with a guided connection setup. It has not been published to
npm. Keep this folder in a permanent location. You do not need an API key or to edit a configuration
file for the normal setup.

It works with **Codex**, **Claude Code**, **Cursor** (editor or `cursor-agent`) and **Gemini CLI**. Any other app
that can run local MCP servers can use the manual entry printed by `node configure.mjs --client generic`.

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

## 2. Choose your app

**Codex or Claude Code.** The wizard finds the official CLI, including the Codex CLI inside the macOS ChatGPT or
Codex desktop app when it is not on PATH, and checks its version. If the official CLI is missing, follow the official
installation link shown, then retry. It does not download or run an installer without you.

If you are not signed in, the wizard offers the official account sign-in. Complete the browser or
terminal prompts belonging to **Codex / OpenAI** or **Claude / Anthropic**, not to SpicyAPI. Your
credentials remain with that official client. The wizard never reads a credential file, asks for an
API key, prints your email, or logs you out.

If your client currently uses API or cloud-provider billing, the wizard says so. You can keep that
billing method explicitly, or choose official account login. Switching login may change the active
account in your official client. Environment or organization settings can still select API billing;
the wizard checks status again and does not call it a subscription login if that remains active. An
unknown login status is not considered success.

For Codex, the wizard also adds `default_tools_approval_mode = "approve"` to the `spicy-studio` entry in
`~/.codex/config.toml`, after saving a backup of that file. This lets non-interactive runs such as `codex exec` call
the Studio tools without an approval prompt. It applies to this entry only and does not change your global approval
policy. A value you already chose is kept; change it to `"prompt"` to be asked before each call.

**Cursor or Gemini CLI.** The wizard adds only the `spicy-studio` entry to `~/.cursor/mcp.json` or
`~/.gemini/settings.json`, keeps a backup of the previous file next to it, and leaves every other setting unchanged.
A file with comments is never rewritten; the wizard prints the entry for you to paste instead. Sign in inside Cursor
or Gemini CLI as usual; the wizard does not check or change your sign-in.

Your eligible subscription allowance or API billing is controlled by your assistant app and plan.
The bridge adds no SpicyAPI charge; this is **not a promise of free model usage**.

## 3. Finish setup, then pair the website

**Restart or reconnect your assistant app** (for Cursor, restart the editor or start a new `cursor-agent`
session; for Gemini CLI, start a new `gemini` session). Signing in and saving the connection do not pair the website
or start a writing request. Send the connect message from Studio's "Connect your AI" window, or this one:

> Call the Spicy Studio tool studio_connect with reset set to true, then show me the new pairing code.

In Studio on this same computer, open **Connect your AI** and enter the code. Allow the browser's local-network
request if prompted. A code works once and expires after ten minutes. If you refresh the Studio page later, send the
same message again to get a new code. Then send this second message in your assistant app, before or after you share
the project/request you want help with. The assistant waits for it with `wait_seconds` and picks it up when you share:

> Process my next Spicy Studio request and return the draft for review. If none is waiting yet, call
> studio_next_request with wait_seconds set to 30 and keep calling it until one arrives.

Review the returned draft before applying it. Image/video generation stays in Studio: choose your
platform model and confirm its displayed price separately. Browser-only chat websites cannot read local MCP settings;
this preview needs an assistant app running on this computer.

**Only one assistant session can hold the Studio connection at a time.** If a Studio tool says another session is
already connected, use that session, or close it and ask again in the one you want.

## Check, retry, or remove the connection

Open a terminal in this folder. Choose the app you use:

```sh
node connect.mjs --client codex
node connect.mjs --client claude
node connect.mjs --client cursor
node connect.mjs --client gemini
```

Read-only checks never log in or change configuration:

```sh
node connect.mjs --client codex --diagnose
node connect.mjs --client cursor --dry-run
```

If the Codex browser sign-in does not complete, try its official device-code flow:

```sh
node connect.mjs --client codex --device-auth
```

To remove only this bridge's saved connection, with confirmation (then disconnect in Studio and
close or restart the assistant to stop an already-running bridge):

```sh
node connect.mjs --client codex --remove
node connect.mjs --client gemini --remove
```

Removal never logs out your account. An unrelated or project-scoped same-name entry is not
removed. If you confirmed replacing an entry and setup was interrupted between removal and addition,
rerun the wizard to finish. It never rewrites all your MCP settings.

For any other app, print a ready-to-paste entry with this computer's paths:

```sh
node configure.mjs --client generic
```

## If you get stuck

- **Cancelled or timed out during sign-in:** reopen the wizard. Ctrl-C requests termination of the
  active login command and its child processes. Close any remaining login browser window. A login
  that already completed remains in your official client; the wizard does not undo it by logging you
  out.
- **"Another assistant session is already connected":** use that session, or close it and ask again here. The website
  uses only `127.0.0.1:47321`.
- **Expired code, refreshed page or lost tab:** send the connect message above again (it asks for `reset: true`).
- **Waiting for the assistant:** send the second message above in your assistant app. If it stopped waiting, send it
  again.
- **`codex exec` says a Studio tool "requires approval":** rerun `node connect.mjs --client codex`. It adds
  `default_tools_approval_mode = "approve"` to this entry only.
- **Browser blocks local access:** allow local-network access if supported. Organization/browser
  policies may block it. Do not disable browser security; there is no remote tunnel fallback.
- **Changed Studio account:** the website discards the old pairing; connect again for the new
  account. The bridge never reads your Studio account credentials.
- **Cancelled writing request:** Studio stops accepting the result, but you must also stop the
  running assistant turn in your assistant app to stop that app's usage.

## Included files

`runtime/` contains the installed bridge and exact runtime dependencies. `connect.mjs` and the three
launchers run the guided setup. `spicyapi-studio-bridge-0.2.2.tgz` is an alternative local npm
installer, not a second service to run. `SHA256SUMS` covers the package, setup scripts, launchers
and guides. `configure.mjs` and `config/` remain optional manual references; the wizard is the
normal route. Runtime dependencies retain their licenses inside `runtime/node_modules/`. See
`README.md` for protocol, privacy and official-source details. Nothing in this package generates
media, proxies an assistant subscription, or automatically starts an assistant writing turn.
