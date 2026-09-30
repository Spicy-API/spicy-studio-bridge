# SpicyAPI Studio Bridge: connect Codex, Claude Code, Cursor or Gemini CLI to Spicy Studio

**SpicyAPI Studio Bridge** connects [Spicy Studio](https://spicyapi.ai/create) to an AI assistant app on your
computer using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro):
**OpenAI Codex**, **Anthropic Claude Code**, **Cursor** (editor or `cursor-agent`), **Google Gemini CLI**, or any other
app that can run a local (stdio) MCP server. Share a selected story or creative request, receive a text or structured
short-drama draft, and review it in Studio before applying it. SpicyAPI maintains this MIT-licensed connection tool.

The guided setup registers one local MCP connection named `spicy-studio`. You do not provide a SpicyAPI API key. Your
eligible subscription allowance or API billing stays with your assistant app; this bridge does not turn a consumer
subscription into an API and does not include image or video generation.

## Download and start

Download the named **SpicyAPI-Studio-Bridge-&lt;version&gt;.zip** from the
[latest GitHub preview release](https://github.com/Spicy-API/spicy-studio-bridge/releases/latest), extract the complete
folder to a permanent location, and open **START-HERE.md**. Choose the named release ZIP, not GitHub's automatic source
archive. Runtime dependencies are included; **Node.js 22.13+ and your assistant app are still required**. This package
is not published to npm.

- macOS: open `Connect-macOS.command`.
- Windows: open `Connect-Windows.cmd`.
- Linux: use **Run in Terminal** for `Connect-Linux.sh`, or run `sh Connect-Linux.sh`.
- Any supported terminal: run `node connect.mjs` in the extracted folder.

The launcher asks which app you use. Then reopen that app and send the connect message shown below. Pair the code in
Studio ("Connect your AI"). Then send the next-request message below in your assistant app, before or after you share a
request: the assistant waits for it with `wait_seconds`. Sharing from the website does not start an assistant turn.

The connect message the website gives you asks for a fresh code every time, so a refreshed Studio page can pair again:

> Call the Spicy Studio tool studio_connect with reset set to true, then show me the new pairing code.

The next-request message:

> Process my next Spicy Studio request and return the draft for review. If none is waiting yet, call
> studio_next_request with wait_seconds set to 30 and keep calling it until one arrives.

## Guided setup: no API key or manual configuration

Node.js 22.13 or newer is required; missing prerequisites receive official installation links. The wizard does not
silently install anything.

### Codex and Claude Code

1. Choose Codex or Claude Code. The wizard detects the official CLI, including the Codex CLI bundled inside the macOS
   ChatGPT or Codex desktop app when PATH does not include it, and checks its login through the official status
   command. No credential files, email addresses or authentication JSON are displayed.
2. If needed, choose official browser sign-in. Codex uses `codex login`; Claude uses `claude auth login --claudeai`.
   API/provider billing is identified separately and requires an explicit decision to keep it or try account login. The
   wizard never logs you out, requests an API key, claims an unknown status is signed in, or bypasses organization
   settings.
3. Only the `spicy-studio` entry is registered through the official MCP commands (`codex mcp add`,
   `claude mcp add --scope user`) and read back for verification. Same-name replacement requires confirmation. Other
   connections are preserved.
4. For Codex, the wizard then adds `default_tools_approval_mode = "approve"` to the `[mcp_servers.spicy-studio]` table
   of `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) after saving a timestamped backup. Without it,
   non-interactive runs such as `codex exec` reject every Studio tool call ("requires approval, but approval policy is
   never"). The setting applies to this entry only: your global `approval_policy` and other servers are unchanged. A
   value you already chose for this entry is kept and reported, a file with an unusual layout is left untouched and you
   get the line to add, and if Codex cannot read the file after the edit (for example an older Codex without this key)
   the previous file is restored. Set it to `"prompt"` to be asked before each Studio tool call.

### Cursor and Gemini CLI

Cursor (the editor and `cursor-agent`) reads MCP servers from `~/.cursor/mcp.json`; `cursor-agent` has an
`mcp list` command but no `mcp add` command. Gemini CLI reads `mcpServers` from `~/.gemini/settings.json`. For these
two apps the wizard:

1. Adds only the `spicy-studio` entry to that file and keeps every other setting.
2. Saves a timestamped backup of the previous file next to it before writing, then writes atomically and reads the
   entry back for verification.
3. Refuses to rewrite a file it cannot parse as plain JSON (for example a file with comments) and prints the entry for
   you to paste instead.
4. Does not check or change your sign-in. Sign in inside Cursor or Gemini CLI as usual.

Restart Cursor (or start a new `cursor-agent` session; `cursor-agent mcp list` shows the connection) or start a new
`gemini` session (`/mcp` shows the connection).

### Any other MCP client

Studio Bridge is a standard stdio MCP server, so it should work with any client that supports local stdio MCP servers
(for example Claude Desktop, VS Code, Zed, Windsurf or opencode). Only Codex, Claude Code, Cursor and Gemini CLI have
guided setup; other clients have not been tested. Print the exact paths for your computer:

```sh
node configure.mjs --client generic
```

and add the printed entry to your client's MCP settings. Most clients use this shape:

```json
{
  "mcpServers": {
    "spicy-studio": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/SpicyAPI-Studio-Bridge/runtime/node_modules/@spicyapi/studio-bridge/dist/src/cli.js"]
    }
  }
}
```

The client must run on the same computer as the browser. Cloud agents, remote shells and browser-only chat apps cannot
reach a local bridge.

### Terminal commands

```sh
node connect.mjs --client codex
node connect.mjs --client claude
node connect.mjs --client cursor
node connect.mjs --client gemini
node connect.mjs --client codex --diagnose
node connect.mjs --client cursor --dry-run
node connect.mjs --client codex --device-auth
node connect.mjs --client gemini --remove
node configure.mjs --client generic
```

Diagnostics and dry runs never log in or change configuration. Removal asks first and removes only this bridge's entry,
not your login. Claude project/local/managed collisions are left untouched. A confirmed replacement interrupted after
removal can be finished by rerunning the wizard. Captured CLI output is bounded and private; only the official
interactive login owns its terminal prompts. Ctrl-C and timeouts request termination of the active official command and
its child processes. Close any remaining login browser window. They cannot undo a login already saved by that official
client.

Removing configuration does not stop a bridge already running in an assistant session. Disconnect in Studio, then close
or restart that session.

### Alternative local tarball installation

If you received only the `.tgz`, install that exact file in an empty permanent directory:

```sh
npm install --ignore-scripts /absolute/path/spicyapi-studio-bridge-<version>.tgz
node node_modules/@spicyapi/studio-bridge/delivery/connect.mjs
```

This resolves pinned dependencies but does not publish anything. Do not use `npx ...@latest` as an MCP startup
command. The included `configure.mjs` and `config/` examples are optional manual references. The bridge itself is
started by your assistant app; there is no separate daemon to start.

## Frequently asked questions

### What can Studio Bridge help me create?

It passes a selected Studio request to your assistant and returns a reviewable creative text or structured short-drama
script with characters and scenes. It does not produce images, video clips, voice tracks or a finished movie. Generate
those separately in Studio with a model you choose and its displayed price.

### Can I use my existing subscription?

Yes, when your assistant app's login and plan permit that use. Writing runs in the unmodified assistant app and uses its
normal allowance, limits and policies. An API or cloud-provider login can instead incur that provider's charges. Studio
Bridge adds no SpicyAPI charge and promises no free or unlimited model access. For Codex and Claude Code the wizard
reports the detected login type; see the
[Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) and
[Claude Code authentication guide](https://code.claude.com/docs/en/authentication).

### Do I need to copy an API key, OAuth token or configuration file?

No API key or manual JSON/TOML edit is required for guided setup. The wizard calls official login and MCP configuration
commands for Codex and Claude Code (for Codex it also adds one tool-approval line to the `spicy-studio` entry in
`config.toml`, with a backup), and edits only the `spicy-studio` entry (with a backup) for Cursor and Gemini CLI.
It never reads credential files or asks you to paste an OAuth token. Other clients need the entry pasted into their
settings once.

### How is this different from the SpicyAPI API-key MCP server?

Choose the tool based on what the assistant should do:

| Tool | Purpose | Authentication and execution |
| --- | --- | --- |
| **Studio Bridge** (this repository) | Return a selected Studio story or creative draft for your review | Your assistant app's own login plus one-use browser pairing; no SpicyAPI API key and no model execution API |
| **[SpicyAPI MCP](https://github.com/Spicy-API/spicy-mcp)** | Inspect the platform catalog, obtain quotes and create image/video tasks through the SpicyAPI API | A SpicyAPI API key; paid actions require the tool's confirmation flow |

They are separate packages. Installing one does not configure the other.

### Which computers and assistant apps work?

The launchers target macOS, Windows and Linux with Node.js 22.13+. Guided setup covers Codex, Claude Code, Cursor and
Gemini CLI; any other client that runs local stdio MCP servers should work with the generic entry. The Studio browser
must run on the same computer and be allowed to reach `127.0.0.1:47321`. Browser-only chat websites and mobile apps
cannot run a local bridge. Windows/Linux desktop login has not been tested on physical systems; see
[verification limits](TESTING.md).

### Will the website automatically run my assistant or charge for media?

No. After pairing, send the next-request message in your assistant app. It can wait for your request with
`wait_seconds`, but only after you ask it to. Review its returned draft before applying it. This bridge has no media generation or billing tool. Images and videos require a separate Studio
model choice and price confirmation.

### What project data is shared, and does it stay offline?

Only the selected project title/ID and request text are queued in the local bridge, in memory. Your assistant receives
that text when it retrieves the request; its model may process it through the provider's normal service. This is a
local connection, not a promise of offline AI. The bridge exposes no file-reading tool and does not fetch your Studio
history or credentials. Other tools in your assistant remain governed by that app's permissions.

### What happens if I cancel, disconnect, refresh or cannot pair?

Cancelling prevents a later draft from being accepted; stop the current turn in your assistant as well to stop that
app's usage. Disconnecting clears the in-memory shared requests. A pairing code is single-use and lasts ten minutes.
After a page refresh, send the connect message again: it asks for `reset: true`, which gives a new code. Without
`reset`, `studio_connect` still returns a replacement code; the previously paired page keeps working until the new code
is entered. Browser or organization local-network restrictions can block pairing; do not disable browser security.

## If something does not connect

- **No connection code:** ask the assistant to call `studio_connect`. A code lasts 10 minutes and works once.
- **Refreshed page or lost browser tab:** send the connect message again (it uses `reset: true`). This disconnects the
  old page and removes its shared requests.
- **Code expired or too many attempts:** get a new code from the assistant. Ten incorrect attempts lock the current
  code.
- **"Another assistant session is already connected":** only one assistant session can hold the Studio connection at
  a time. Use the session that holds it, or close that session and ask again in this one; no restart is needed. The
  local port opens on the first Studio tool call, so sessions that never use Studio do not hold it. Studio connects only
  to `127.0.0.1:47321`; changing the bridge port will not connect to the website.
- **Website not allowed:** only `https://spicyapi.ai` and `https://www.spicyapi.ai` work by default. For development,
  explicitly add `--origin http://127.0.0.1:3100` using your exact browser origin. Wildcards and `null` origins are
  never allowed.
- **Browser blocks local access:** grant local-network permission if supported. Some browser or organization policies
  block an HTTPS page from reaching a local HTTP service. Do not disable browser security; use a supported browser or
  your local development site. There is no remote tunnel or cloud fallback.
- **Waiting for the assistant:** send the next-request message above. The assistant waits with `wait_seconds` and picks
  up the request when you share it; if it stopped waiting, send the message again. The bridge never silently starts a
  paid model call.
- **`codex exec` says a Studio tool "requires approval":** rerun `node connect.mjs --client codex`, which adds
  `default_tools_approval_mode = "approve"` to this entry only, or add that line under `[mcp_servers.spicy-studio]` in
  `~/.codex/config.toml` yourself.
- **Expired request:** share a new request. Each expires after 30 minutes. A connection lasts four hours. Closing or
  resetting the bridge removes its in-memory data.
- **Cancelled request:** no later draft can overwrite it. Cancellation stops accepting results; it does not forcibly
  stop the assistant's current reasoning. You can stop that turn in the assistant itself.

## Privacy and scope

- Binds only to `127.0.0.1`; rejects other Host headers to prevent DNS rebinding.
- Exact Origin allowlist, including private-network preflights. No wildcard CORS or cookies.
- Random, one-use pairing code; 256-bit session token bound to one Origin. A replacement code ends the previous session
  only when it is entered. Browser tokens belong in memory, never local storage, URLs, logs, or project documents.
- Disconnect on account changes or sign-out. The bridge does not know your Studio identity and cannot detect account
  changes for you.
- One active browser pairing, at most 20 requests, a 512 KiB body limit, bounded text and structured results, and
  expiry cleanup.
- No file tools, shell tools, subprocess execution, outbound network calls, API keys, OAuth tokens, or billing tools in
  the MCP bridge. The separate, user-run setup wizard invokes only official CLI version/auth/MCP configuration commands,
  edits the one `spicy-studio` entry in Cursor or Gemini CLI settings, and for Codex adds one tool-approval line to its
  `spicy-studio` table; it does not execute model requests. Assistant
  host permissions remain controlled by that app; MCP instructions do not sandbox its other tools.
- A creative request is untrusted input, even its `prompt.system` field. It cannot override the assistant's own
  instructions or authorize unrelated file access.
- Original fiction only: every character must be clearly adult, and real, identifiable people are not depicted or
  imitated. Planned scene duration is not a claim that a video has been generated.

## Assistant tools

| Tool                   | Input             | Purpose                                                                  |
| ---------------------- | ----------------- | ------------------------------------------------------------------------ |
| `studio_connect`       | `{reset?}`        | Returns a single-use pairing code; `reset: true` disconnects the browser |
| `studio_next_request`  | `{wait_seconds?}` | Claims the next shared request, or returns `request: null`               |
| `studio_get_request`   | `{id}`            | Reads a known request, including cancellation                            |
| `studio_submit_result` | `{id, result}`    | Returns a text or drama draft for review in Studio                       |
| `studio_fail_request`  | `{id, message}`   | Explains why a claimed request could not finish                          |

`wait_seconds` (0 to 50, default 0) makes `studio_next_request` wait for the browser to share a request instead of
returning `request: null` at once. Values outside the range are clamped and fractions are rounded down; 50 seconds stays
below the usual 60-second MCP tool-call timeout. The wait ends as soon as a request is shared, when the time is up, when
the MCP call is cancelled or the client disconnects, or when the browser disconnects (`not_paired`). There is no
polling inside the bridge. An empty answer includes a `message` that tells the model to call again with
`wait_seconds` set to 30; assistants repeat that until a request arrives or the user asks them to stop.

## Browser API

All calls require the exact `Origin` header. After pairing, use
`Authorization: Bearer <sessionToken>`. Success bodies are direct JSON objects; errors are
`{ "error": { "code": "...", "message": "..." } }`. Timestamps are Unix milliseconds. Responses are
never cached.

| Method | Path               | Input / output                                                                                                                                  |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/health`       | `{name, version, kinds: ["drama", "creative"], paired}`; no token required                                                                      |
| POST   | `/v1/pair`         | `{code}` -> `{sessionToken, expiresAt}`; a replacement code ends the previous session                                                          |
| POST   | `/v1/requests`     | `{kind, project:{id,title}, prompt:{system,user}}`; required `Idempotency-Key` header, 8–128 letters/digits/underscore/hyphen                   |
| GET    | `/v1/requests/:id` | Request, current status and optional result/error                                                                                               |
| DELETE | `/v1/requests`     | Required `Idempotency-Key`; cancels a known request or records a bounded cancellation marker before a late POST arrives; `{cancelled, request}` |
| DELETE | `/v1/requests/:id` | Cancels queued/working requests; completed requests remain completed                                                                            |
| DELETE | `/v1/session`      | Revokes the pairing and clears shared data; `{disconnected:true}`                                                                               |

A request contains `id`, `kind`, `project`, `prompt`, `status`, `createdAt`, `updatedAt`,
`expiresAt`, and optionally `result` or `error`. Status is `queued`, `working`, `completed`,
`failed`, or `cancelled`. Reuse the same request key for network retries with the same body; use a
new key only for an intentional new request.

Cancel by key even if a POST response was lost. A late or retried POST with a cancelled key receives
`409 request_cancelled`; an intentional new request needs a new key. A completed draft is preserved
and returns `cancelled: false`.

Creative text is limited to 12,000 characters. A drama script is limited to 256,000 characters.
Request responses also include the original prompt; browser clients must allow at least 350,000
response characters before validation.

Results:

```json
{ "type": "text", "text": "A creative draft for review." }
```

```json
{
  "type": "drama",
  "script": {
    "version": 1,
    "title": "The Last Train",
    "logline": "Two adults meet again at a deserted station.",
    "style": "Quiet cinematic romance in warm station light.",
    "characters": [
      {
        "id": "c1",
        "name": "Alex",
        "description": "An adult in their thirties wearing an evening coat."
      }
    ],
    "shots": [
      {
        "id": "s1",
        "title": "Arrival",
        "description": "Rain settles over the platform.",
        "prompt": "Alex turns toward a familiar silhouette in warm station light.",
        "characterIds": ["c1"],
        "durationSeconds": 6,
        "dialogue": [{ "characterId": "c1", "text": "You came." }]
      }
    ]
  }
}
```

The drama schema allows up to eight characters and 24 scenes, 1–120 planned seconds per scene and at
most 600 in total. IDs begin with a letter and contain at most 64 ASCII letters, digits, underscores
or hyphens. Speakers must be referenced in the scene. Extra model, execution, media URL, or account
fields are rejected. The website validates the script again before applying it.

## Development and verification

From this source repository, with Node.js 22.13 or newer:

```sh
npm ci --ignore-scripts
npm run verify
```

To prepare the desktop ZIP and local installation tarball, run `npm run bundle`. Release packaging
also requires Python 3 for ZIP creation; end users do not need Python. Generated artifacts are in
`artifacts/` and never become source commits. `private: true` deliberately prevents npm publication.
CI performs read-only checks and packages artifacts; it does not publish a release or invoke a real assistant.

The setup tests use isolated fake official CLIs, temporary home folders and temporary configuration state for login,
API/account distinctions, cancellation, timeout, same-name replacement, paths with spaces, Cursor and Gemini CLI
settings files (backups, comments, removal), the Codex `config.toml` tool-approval line (fresh write, idempotent rerun,
existing values kept, restore when Codex rejects the key) and the recorded `claude mcp get` layout of Claude Code
2.1.285. They do not log in or modify a real assistant account. The protocol tests use real local HTTP sockets and both
modern and legacy MCP stdio handshakes with fixed fake drafts, including a busy local port and `wait_seconds` (arrival,
timeout, clamping, cancellation and disconnect, with no waiter or timer left behind). They never launch an assistant app, read its
credentials, or call a real LLM. `test/mock-host.ts` is a development-only demo client, not part of the installable
package.

## Official sources and boundaries

Checked on September 29–30, 2026:

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): official local stdio client
  configuration.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): an official deeper integration
  path, separate from this MCP-only preview. Experimental transports are not enabled here.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): official stdio client configuration.
- [Claude Code authentication](https://code.claude.com/docs/en/authentication): official account, API and organization-controlled authentication choices.
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): users
  authenticate in the unmodified official client. This package does not collect credentials, offer
  Claude.ai sign-in, or operate a subscription request proxy.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): stdio
  lifecycle and local transport security.
- [Cursor MCP](https://cursor.com/docs/context/mcp): `mcpServers` in `~/.cursor/mcp.json` (global) or
  `.cursor/mcp.json` (project). `cursor-agent --help` (2025.09.12) lists `mcp login`, `list`, `list-tools` and
  `disable`, and states that it reads the same files; it has no `mcp add` command.
- [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/): `mcpServers` in `~/.gemini/settings.json`,
  `gemini mcp add`, `gemini mcp list` and `/mcp`. Gemini CLI was not installed on the test machine; its setup follows the
  documentation and the settings-file tests.

Open-source bridge projects informed the research, but their code was not copied. Software licenses
alone do not grant access to an assistant subscription or permission to resell it.

Maintained by SpicyAPI. Codex, Claude Code, Cursor and Gemini CLI belong to their respective providers. This project
does not claim provider endorsement. A concise factual index is available in [llms.txt](llms.txt);
it is documentation for readers and tools, not a guarantee of indexing or search visibility.
