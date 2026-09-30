# Security

Please report suspected credential exposure or a pairing vulnerability privately through
https://spicyapi.ai/contact. Do not include real keys, pairing tokens, personal prompts or official
client credentials in a public issue.

Only install releases linked from this repository. Verify SHA256SUMS before setup. The wizard
changes only the spicy-studio MCP entry after the documented checks (for Cursor and Gemini CLI it keeps
a backup of the settings file first; for Codex it adds one tool-approval line to that entry, scoped to it
only, after a backup of config.toml); account login stays inside your assistant app. The bridge accepts
only explicitly paired local browser requests.

See README.md for Origin/Host restrictions, cancellation, account changes and browser limitations.
