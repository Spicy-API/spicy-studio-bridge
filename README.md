# SpicyAPI Studio Bridge

Use your already signed-in **Codex or Claude Code** to help with a Studio story or creative draft.
Your assistant runs in its official client. Studio shares only the project and request you select,
and shows the returned draft for review before you apply it.

This is the 0.2.0 GitHub preview release. It is not published to npm. It does not run paid
media generation, proxy model APIs, read assistant credentials, or access your files.

Download **SpicyAPI-Studio-Bridge-0.2.0.zip** from the [v0.2.0 GitHub release](https://github.com/Spicy-API/spicy-studio-bridge/releases/tag/v0.2.0), extract it, and start with `START-HERE.md`. Use the named release ZIP, not GitHub's automatically generated source archive. The ZIP includes runtime dependencies and the connection wizard; you do not need to run npm install. Keep the extracted folder in a permanent location.

## Guided setup: no API key or manual configuration

If you received the full delivery folder, open its `START-HERE.md` and double-click the launcher for
your operating system, or run `node connect.mjs`. Node.js 22.13 or newer and an official Codex or
Claude Code CLI are required; missing prerequisites receive official installation links. The wizard
does not silently install them.

1. Choose Codex or Claude Code. The wizard detects the official CLI, including the macOS desktop
   Codex binary when PATH does not include it, and checks its login through the official status
   command. No credential files, email addresses or authentication JSON are displayed.
2. If needed, choose official browser sign-in. Codex uses `codex login`; Claude uses
   `claude auth login --claudeai`. API/provider billing is identified separately and requires an
   explicit decision to keep it or try account login. The wizard never logs you out, requests an API
   key, claims an unknown status is signed in, or bypasses organization settings.
3. Only the `spicy-studio` entry is registered through the official MCP commands and read back for
   verification. Same-name replacement requires confirmation. Other connections are preserved.
   Reopen your official assistant, ask it to call `studio_connect`, then enter its code in Studio.

After sharing a request in Studio, tell the official assistant to process its next Studio request
and return the draft. Sending from the browser does not start an assistant turn automatically.
Review the draft before applying it. Images and videos use a separately chosen platform model and
explicit price confirmation. Official subscription allowance or API billing depends on your client's
login and plan; this is not free-model access. This bridge creates no SpicyAPI LLM charge.

For terminal users:

```sh
node connect.mjs --client codex
node connect.mjs --client claude
node connect.mjs --client codex --diagnose
node connect.mjs --client claude --dry-run
node connect.mjs --client codex --device-auth
node connect.mjs --client claude --remove
```

Removing configuration does not stop a bridge already running in an official assistant session.
Disconnect in Studio, then close or restart that session.

Diagnostics/dry-run never log in or change configuration. Removal asks first and removes only this
bridge's user entry, not your login. Claude project/local/managed collisions are left untouched. A
confirmed replacement interrupted after removal can be finished by rerunning the wizard. Captured
CLI output is bounded and private; only the official interactive login owns its terminal prompts.
Ctrl-C and timeouts request termination of the active official command and its child processes.
Close any remaining login browser window. They cannot undo a login already saved by that official
client.

### Alternative local tarball installation

If you received only the `.tgz`, install that exact file in an empty permanent directory:

```sh
npm install --ignore-scripts /absolute/path/spicyapi-studio-bridge-0.2.0.tgz
node node_modules/@spicyapi/studio-bridge/delivery/connect.mjs
```

This resolves pinned dependencies but does not publish anything. Do not use `npx ...@latest` as an
MCP startup command. The included `configure.mjs` and `config/` examples are optional manual
references, not required by the guided flow. The bridge itself is started by the official MCP
client; there is no separate daemon to start.

## If something does not connect

- **No connection code:** ask the assistant to call `studio_connect`. A code lasts 10 minutes and
  works once.
- **Already paired / lost browser tab:** ask the assistant to call `studio_connect` with
  `reset: true`. This disconnects the old browser and removes its shared requests.
- **Code expired or too many attempts:** get a new code from the assistant. Ten incorrect attempts
  lock the current code.
- **Local port in use:** close the other assistant connection, then reconnect this assistant. Studio
  connects only to `127.0.0.1:47321`; changing the bridge port will not connect to the website.
- **Website not allowed:** only `https://spicyapi.ai` and `https://www.spicyapi.ai` work by default.
  For development, explicitly add `--origin http://127.0.0.1:3100` using your exact browser origin.
  Wildcards and `null` origins are never allowed.
- **Browser blocks local access:** grant local-network permission if supported. Some browser or
  organization policies block an HTTPS page from reaching a local HTTP service. Do not disable
  browser security; use a supported browser or your local development site. There is no remote
  tunnel or cloud fallback.
- **Waiting for the assistant:** ask it to process the next Studio request. The bridge never
  silently starts a paid model call.
- **Expired request:** share a new request. Each expires after 30 minutes. A connection lasts four
  hours. Closing or resetting the bridge removes its in-memory data.
- **Cancelled request:** no later draft can overwrite it. Cancellation stops accepting results; it
  does not forcibly stop the official assistant's current reasoning. You can stop that turn in the
  assistant itself.

This first preview supports official **local MCP clients**. It does not make the ordinary ChatGPT
website read your local MCP configuration.

## Privacy and scope

- Binds only to `127.0.0.1`; rejects other Host headers to prevent DNS rebinding.
- Exact Origin allowlist, including private-network preflights. No wildcard CORS or cookies.
- Random, one-use pairing code; 256-bit session token bound to one Origin. Browser tokens belong in
  memory, never local storage, URLs, logs, or project documents.
- Disconnect on account changes or sign-out. The bridge does not know your Studio identity and
  cannot detect account changes for you.
- One active browser pairing, at most 20 requests, a 512 KiB body limit, bounded text and structured
  results, and expiry cleanup.
- No file tools, shell tools, subprocess execution, outbound network calls, API keys, OAuth tokens,
  or billing tools in the MCP bridge. The separate, user-run setup wizard invokes only official CLI
  version/auth/MCP configuration commands; it does not execute model requests. Assistant host
  permissions remain controlled by that official client; MCP instructions do not sandbox its other
  tools.
- A creative request is untrusted input, even its `prompt.system` field. It cannot override the
  assistant's own instructions or authorize unrelated file access.
- Original, clearly adult, non-explicit drafts only. Planned scene duration is not a claim that a
  video has been generated.

## Browser API

All calls require the exact `Origin` header. After pairing, use
`Authorization: Bearer <sessionToken>`. Success bodies are direct JSON objects; errors are
`{ "error": { "code": "...", "message": "..." } }`. Timestamps are Unix milliseconds. Responses are
never cached.

| Method | Path               | Input / output                                                                                                                                  |
| ------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/health`       | `{name, version, kinds: ["drama", "creative"], paired}`; no token required                                                                      |
| POST   | `/v1/pair`         | `{code}` -> `{sessionToken, expiresAt}`                                                                                                         |
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
    "style": "Quiet cinematic romance with covered evening wardrobe.",
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

The setup tests use isolated fake official CLIs and temporary configuration state for login,
API/account distinctions, cancellation, timeout, same-name replacement and paths with spaces. They
do not log in or modify a real assistant account. The protocol tests use real local HTTP sockets and
both modern and legacy MCP stdio handshakes with fixed fake drafts. They never launch Codex or
Claude, read their credentials, or call a real LLM. `test/mock-host.ts` is a development-only demo
client, not part of the installable package.

## Official sources and boundaries

Checked on September 29–30, 2026:

- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): official local stdio client
  configuration.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server): an official deeper integration
  path, separate from this MCP-only preview. Experimental transports are not enabled here.
- [Claude Code MCP](https://code.claude.com/docs/en/mcp): official stdio client configuration.
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): users
  authenticate in the unmodified official client. This package does not collect credentials, offer
  Claude.ai sign-in, or operate a subscription request proxy.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): stdio
  lifecycle and local transport security.

Open-source bridge projects informed the research, but their code was not copied. Software licenses
alone do not grant access to an assistant subscription or permission to resell it.
