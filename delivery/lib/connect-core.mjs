import { access, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";

export const SERVER_NAME = "spicy-studio";
/** The bridge version this delivery folder ships. Keep in sync with package.json and src/schema.ts. */
export const BRIDGE_VERSION = "0.2.2";
export const INSTALL_URLS = {
  node: "https://nodejs.org/en/download",
  codex: "https://learn.chatgpt.com/docs/developer-commands?surface=cli",
  claude: "https://code.claude.com/docs/en/setup",
};
/** Clients configured through their official CLI (mcp add/get/remove). */
export const CLI_CLIENTS = ["codex", "claude"];
/**
 * Clients configured by adding one entry to their documented settings file.
 * Cursor (editor and cursor-agent) reads ~/.cursor/mcp.json; cursor-agent has no "mcp add" command.
 * Gemini CLI reads ~/.gemini/settings.json.
 */
export const FILE_CLIENTS = {
  cursor: {
    name: "Cursor",
    path: (home) => join(home, ".cursor", "mcp.json"),
    restart: "Restart Cursor, or start a new cursor-agent session. You can check the connection with: cursor-agent mcp list",
  },
  gemini: {
    name: "Gemini CLI",
    path: (home) => join(home, ".gemini", "settings.json"),
    restart: "Start a new gemini session. You can check the connection with /mcp inside Gemini CLI.",
  },
};
export const CLIENTS = [...CLI_CLIENTS, ...Object.keys(FILE_CLIENTS)];
/**
 * Codex setting on this bridge's own [mcp_servers.spicy-studio] table. Without it, non-interactive runs such as
 * codex exec reject every Studio tool call ("requires approval, but approval policy is never"). Codex accepts
 * auto, prompt, writes or approve, and refuses to load config.toml with any other value.
 */
export const CODEX_APPROVAL_KEY = "default_tools_approval_mode";
export const CODEX_APPROVAL_VALUE = "approve";
const CLIENT_NAMES = { codex: "Codex", claude: "Claude Code", cursor: "Cursor", gemini: "Gemini CLI" };

export function parseOptions(args) {
  const options = { mode: "connect", client: undefined, deviceAuth: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--client") {
      const value = args[++i];
      if (!CLIENTS.includes(value))
        throw new Error("Choose --client codex, claude, cursor or gemini.");
      options.client = value;
    } else if (["--diagnose", "--dry-run", "--remove", "--help"].includes(arg)) {
      if (options.mode !== "connect")
        throw new Error("Use only one of --diagnose, --dry-run, --remove, or --help.");
      options.mode = arg.slice(2);
    } else if (arg === "--device-auth") options.deviceAuth = true;
    else throw new Error("Unknown option. Run node connect.mjs --help.");
  }
  if (options.deviceAuth && options.client && options.client !== "codex")
    throw new Error("--device-auth is only available with Codex.");
  return options;
}

/**
 * The Codex CLI bundled inside a desktop app. Newer ChatGPT desktop builds ship it under
 * Contents/Resources/codex-cli, and codex-package.json names the entrypoint; older builds used Resources/codex.
 */
export function bundledCodexCandidates(applications, readText = (path) => readFileSync(path, "utf8")) {
  const candidates = [];
  for (const root of applications) {
    for (const app of ["ChatGPT.app", "Codex.app"]) {
      const resources = join(root, app, "Contents", "Resources");
      const bundle = join(resources, "codex-cli");
      try {
        const entrypoint = JSON.parse(readText(join(bundle, "codex-package.json"))).entrypoint;
        const resolved = typeof entrypoint === "string" && !isAbsolute(entrypoint) ? normalize(join(bundle, entrypoint)) : null;
        // Only accept an entrypoint that stays inside the bundle folder.
        if (resolved && resolved.startsWith(bundle + (bundle.endsWith("/") ? "" : "/"))) candidates.push(resolved);
      } catch {
        /* No package manifest in this app. */
      }
      candidates.push(join(bundle, "bin", "codex"), join(resources, "codex"));
    }
  }
  return candidates;
}

export function cliCandidates(
  client,
  {
    env = process.env,
    platform = process.platform,
    home = homedir(),
    node = process.execPath,
    applications = ["/Applications", join(home, "Applications")],
    readText,
  } = {},
) {
  const paths = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter((value) => value && isAbsolute(value));
  const directories = [
    ...paths,
    dirname(node),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const names = platform === "win32" ? [`${client}.exe`, `${client}.cmd`] : [client];
  const candidates = directories.flatMap((directory) => names.map((name) => join(directory, name)));
  if (platform === "darwin" && client === "codex")
    candidates.push(...bundledCodexCandidates(applications, readText));
  return [...new Set(candidates)];
}

export async function detectCli(client, options = {}) {
  for (const candidate of cliCandidates(client, options)) {
    let launcher;
    try {
      await access(
        candidate,
        (options.platform ?? process.platform) === "win32" ? constants.F_OK : constants.X_OK,
      );
      // Never invoke cmd.exe or a shell to run npm's Windows command shim.
      if (candidate.toLowerCase().endsWith(".cmd")) {
        const entry = join(
          dirname(candidate),
          "node_modules",
          client === "codex" ? "@openai/codex/bin/codex.js" : "@anthropic-ai/claude-code/cli.js",
        );
        await access(entry, constants.R_OK);
        launcher = { command: options.node ?? process.execPath, prefix: [entry] };
      } else {
        const executable = await realpath(candidate);
        launcher = /\.m?js$/i.test(executable)
          ? { command: options.node ?? process.execPath, prefix: [executable] }
          : { command: executable, prefix: [] };
      }
    } catch {
      /* Try the next documented installation location. */
      continue;
    }
    if (!options.verify || (await options.verify(launcher))) return launcher;
  }
  return null;
}

/** Only fixed official commands are passed as separate arguments; captured output is never logged. */
export function runCommand(
  launcher,
  args,
  { signal, timeoutMs = 20000, interactive = false, cwd, env = process.env } = {},
) {
  if (signal?.aborted)
    return Promise.resolve({ code: null, stdout: "", stderr: "", error: "cancelled" });
  return new Promise((resolveResult) => {
    let stdout = "",
      stderr = "",
      failure,
      done = false,
      cleaning = false;
    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: !interactive,
      cwd,
      env,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const finish = (code) => {
      if (done || cleaning) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveResult({ code, stdout, stderr, ...(failure ? { error: failure } : {}) });
    };
    const stop = (reason) => {
      if (done || failure) return;
      failure = reason;
      cleaning = true;
      const complete = () => {
        cleaning = false;
        finish(child.exitCode);
      };
      if (!child.pid) {
        complete();
        return;
      }
      if (process.platform === "win32") {
        // Invoke the OS process-tree terminator directly, never a shell or command string.
        const killer = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" },
        );
        let settled = false;
        const finishKill = () => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          child.kill("SIGKILL");
          complete();
        };
        const killTimer = setTimeout(() => {
          killer.kill();
          finishKill();
        }, 3000);
        killer.once("error", finishKill);
        killer.once("close", finishKill);
      } else {
        const killGroup = (kind) => {
          try {
            process.kill(-child.pid, kind);
          } catch {
            /* The process group may already have exited. */
          }
        };
        killGroup("SIGTERM");
        // Keep the escalation even if an npm wrapper exits before its native child.
        setTimeout(() => {
          killGroup("SIGKILL");
          complete();
        }, 800);
      }
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    for (const [stream, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream?.on("data", (data) => {
        const text = data.toString();
        const remaining = Math.max(0, 65536 - stdout.length - stderr.length);
        if (name === "stdout") stdout += text.slice(0, remaining);
        else stderr += text.slice(0, remaining);
        if (text.length > remaining) stop("output_limit");
      });
    child.once("error", () => {
      failure ??= "unavailable";
      finish(null);
    });
    child.once("close", finish);
    // Descendants may inherit pipes; do not wait forever after the official process was terminated.
    child.once("exit", (code) => {
      if (failure) finish(code);
    });
  });
}

export function authStatus(client, result) {
  if (result.error) return "unknown";
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  if (client === "codex") {
    if (result.code === 0 && /^Logged in using ChatGPT\b/im.test(output)) return "account";
    if (result.code === 0 && /^Logged in using an API key\b/im.test(output)) return "api";
    if (result.code === 1 && /^Not logged in\b/im.test(output)) return "signed-out";
    return "unknown";
  }
  try {
    const value = JSON.parse(result.stdout);
    if (result.code === 1 && value.loggedIn === false) return "signed-out";
    if (result.code !== 0 || value.loggedIn !== true) return "unknown";
    const method = String(value.authMethod ?? "").toLowerCase();
    const provider = String(value.apiProvider ?? "").toLowerCase();
    if (
      /bedrock|vertex|foundry|console/.test(`${method} ${provider}`) ||
      ["api_key", "api-key", "apikey"].includes(method)
    )
      return "api";
    if (
      ["claude.ai", "claudeai"].includes(method) ||
      (method === "oauth" && ["pro", "max", "team", "enterprise"].includes(value.subscriptionType))
    )
      return "account";
  } catch {
    /* Unknown output must never become a successful account check. */
  }
  return "unknown";
}

/**
 * True only when "claude mcp get" lists at least one environment variable.
 * Claude Code 2.1.x prints an empty "Environment:" heading for entries saved with env: {},
 * followed by a blank line and a "To remove this server" hint; that is not a conflict.
 */
export function claudeHasEnvironment(output) {
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const heading = /^(\s*)Environment(?: variables)?:[ \t]*(.*)$/i.exec(lines[index]);
    if (!heading) continue;
    if (heading[2].trim()) return true;
    const indent = heading[1].length;
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next];
      if (!line.trim()) break;
      if (line.length - line.trimStart().length <= indent) break;
      if (/^\s*[^\s=]+=/.test(line)) return true;
    }
  }
  return false;
}

export function configStatus(client, result, expected) {
  if (result.error) return { kind: "unknown" };
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) {
    return output.includes(SERVER_NAME) &&
      /no mcp server|not found|does not exist|not configured/i.test(output)
      ? { kind: "missing" }
      : { kind: "unknown" };
  }
  let command, args, scope, clean;
  if (client === "codex") {
    try {
      const value = JSON.parse(result.stdout);
      const config = value.transport ?? value;
      if (value.name !== undefined && value.name !== SERVER_NAME) return { kind: "unknown" };
      if (
        config.type !== "stdio" ||
        typeof config.command !== "string" ||
        !Array.isArray(config.args) ||
        !config.args.every((value) => typeof value === "string")
      )
        return { kind: "conflict", own: false };
      command = config.command;
      args = config.args;
      scope = "user";
      clean =
        value.enabled !== false &&
        !config.cwd &&
        !config.experimental_environment &&
        !value.experimental_environment &&
        !Object.keys(config.env ?? {}).length &&
        !config.env_vars?.length &&
        value.enabled_tools == null &&
        !value.disabled_tools?.length;
    } catch {
      return { kind: "unknown" };
    }
  } else {
    const field = (name) => output.match(new RegExp(`^\\s*${name}:\\s*(.*)$`, "mi"))?.[1]?.trim();
    const scopeText = field("Scope");
    scope = /^User\b/i.test(scopeText ?? "")
      ? "user"
      : /^Local\b/i.test(scopeText ?? "")
        ? "local"
        : /^Project\b/i.test(scopeText ?? "")
          ? "project"
          : undefined;
    command = field("Command");
    const argumentLine = field("Args");
    if (
      !scope ||
      !command ||
      argumentLine === undefined ||
      field("Type")?.toLowerCase() !== "stdio"
    )
      return { kind: "conflict", own: false, scope };
    // Our server has exactly one path argument. Do not split paths containing spaces.
    args = [argumentLine];
    clean = !claudeHasEnvironment(output) && !/Status:.*(?:disabled|pending approval)/i.test(output);
  }
  const own =
    /(?:^|[\\/])@spicyapi[\\/]studio-bridge[\\/]dist[\\/]src[\\/]cli\.js$/.test(args[0] ?? "") &&
    args.length === 1 &&
    /(?:^|[\\/])node(?:\.exe)?$/i.test(command);
  const same =
    command === expected.node &&
    args.length === 1 &&
    args[0] === expected.entry &&
    clean &&
    scope === "user";
  return { kind: same ? "matching" : "conflict", own: own || same, scope };
}

const authArgs = (client) =>
  client === "codex" ? ["login", "status"] : ["auth", "status", "--json"];
const getArgs = (client) => ["mcp", "get", SERVER_NAME, ...(client === "codex" ? ["--json"] : [])];
const removeArgs = (client) => [
  "mcp",
  "remove",
  ...(client === "claude" ? ["--scope", "user"] : []),
  SERVER_NAME,
];
const addArgs = (client, expected) => [
  "mcp",
  "add",
  ...(client === "claude" ? ["--scope", "user", "--transport", "stdio"] : []),
  SERVER_NAME,
  "--",
  expected.node,
  expected.entry,
];

export async function connectionWizard(
  options,
  {
    entry,
    node = process.execPath,
    cwd = dirname(entry),
    env = process.env,
    signal,
    io,
    detect = detectCli,
    run = runCommand,
    home = homedir(),
  } = {},
) {
  const client =
    options.client ??
    (await io
      .choose("Which assistant app do you use?", [
        "Codex (ChatGPT account)",
        "Claude Code (Claude account)",
        "Cursor (editor or cursor-agent)",
        "Gemini CLI",
        "Cancel",
      ])
      .then((value) => CLIENTS[value]));
  if (!client) return { ok: false, reason: "cancelled" };
  if (options.deviceAuth && client !== "codex")
    throw new Error("--device-auth is only available with Codex.");
  if (FILE_CLIENTS[client]) return fileWizard(client, options, { entry, node, cwd, env, signal, io, run, home });
  const expected = { node, entry };
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("cancelled");
  };
  const call = async (launcher, args, interactive = false) => {
    checkCancelled();
    if (interactive) io.pause?.();
    try {
      return await run(launcher, args, {
        cwd,
        env,
        signal,
        interactive,
        timeoutMs: interactive ? 300000 : 20000,
      });
    } finally {
      if (interactive) io.resume?.();
    }
  };
  io.say(
    "Studio Bridge connects an official local assistant. No API key is requested and no model generation starts here.",
  );
  let launcher;
  while (!launcher) {
    launcher = await detect(client, {
      env,
      node,
      verify: async (candidate) => {
        const version = await call(candidate, ["--version"]);
        return (
          version.code === 0 &&
          !version.error &&
          (client === "codex" ? /\bcodex(?:-cli)?\s+\d+\.\d+/i : /\d+\.\d+.*Claude Code/i).test(
            version.stdout,
          )
        );
      },
    });
    if (launcher) {
      const version = await call(launcher, ["--version"]);
      const valid =
        version.code === 0 &&
        !version.error &&
        (client === "codex" ? /\bcodex(?:-cli)?\s+\d+\.\d+/i : /\d+\.\d+.*Claude Code/i).test(
          version.stdout,
        );
      if (!valid) launcher = null;
    }
    if (!launcher) {
      io.say(
        `The official ${CLIENT_NAMES[client]} CLI was not found or could not be verified. Install it using ${INSTALL_URLS[client]}`,
      );
      if (
        options.mode !== "connect" ||
        (await io.choose("After installing, retry detection?", ["Retry", "Cancel"])) !== 0
      )
        return { ok: false, reason: "missing_cli" };
    }
  }
  io.say(`Official ${CLIENT_NAMES[client]} CLI detected.`);
  if (!(await verifyRuntime(call, node, entry, io))) return { ok: false, reason: "missing_runtime" };
  const readConfig = async () =>
    configStatus(client, await call(launcher, getArgs(client)), expected);
  let auth =
    options.mode === "remove"
      ? "not-checked"
      : authStatus(client, await call(launcher, authArgs(client)));
  io.say(
    `Official login: ${auth === "account" ? "account login detected; your plan and usage rules still apply" : auth === "api" ? "API or provider billing detected, not a verified subscription login" : auth}.`,
  );
  const codexConfig = client === "codex" ? codexConfigPath({ env, home, cwd }) : undefined;
  if (["diagnose", "dry-run"].includes(options.mode)) {
    const config = await readConfig();
    io.say(`Studio connection configuration: ${config.kind}.`);
    if (codexConfig) io.say(`Codex tool approval for ${SERVER_NAME}: ${describeApproval(await readCodexApproval(codexConfig))}.`);
    io.say(
      options.mode === "dry-run"
        ? `Dry run only. A normal run offers official account login if needed, asks before replacing an existing connection, writes only spicy-studio through the official CLI, then verifies it.${codexConfig ? ` For Codex it also sets ${CODEX_APPROVAL_KEY} = "${CODEX_APPROVAL_VALUE}" on that entry only, so codex exec can call the Studio tools.` : ""} No login or configuration was changed.`
        : "Diagnostics only. No login or configuration was changed. No credentials or account details are printed.",
    );
    return {
      ok: auth === "account" && config.kind === "matching",
      reason: "read_only",
      auth,
      config: config.kind,
    };
  }
  if (options.mode !== "remove") {
    while (auth !== "account") {
      let login;
      if (auth === "api") {
        const choice = await io.choose(
          "This client currently uses API/provider billing. Subscription login may replace its active login; we never call logout.",
          [
            "Use official subscription/account login",
            "Keep API/provider billing (usage may cost extra)",
            "Cancel",
          ],
        );
        if (choice === 1) {
          break;
        }
        if (choice !== 0) return { ok: false, reason: "cancelled" };
        login = true;
      } else if (auth === "signed-out") {
        login =
          (await io.choose(
            "Sign in in the official browser window? Your credentials stay with the official client.",
            ["Sign in", "Cancel"],
          )) === 0;
        if (!login) return { ok: false, reason: "cancelled" };
      } else {
        const choice = await io.choose(
          "Login status is unknown. This is not a successful login check.",
          ["Check again", "Open official account login", "Cancel"],
        );
        if (choice === 2) return { ok: false, reason: "unknown_auth" };
        login = choice === 1;
      }
      if (login) {
        io.say(
          "The official client now handles sign-in. Complete only its own browser/terminal prompts. Press Ctrl-C to cancel.",
        );
        const args =
          client === "codex"
            ? ["login", ...(options.deviceAuth ? ["--device-auth"] : [])]
            : ["auth", "login", "--claudeai"];
        const result = await call(launcher, args, true);
        checkCancelled();
        if (result.error || result.code !== 0) {
          io.say(
            "Official sign-in did not complete. Nothing has been configured. Re-run the wizard to retry; Codex also supports --device-auth.",
          );
          return { ok: false, reason: result.error ?? "login_failed" };
        }
      }
      auth = authStatus(client, await call(launcher, authArgs(client)));
      if (auth === "api")
        io.say(
          "The official status still reports API/provider billing. Environment variables or organization settings may override an account login. We do not modify them. Check the official client's /status before writing.",
        );
    }
  }
  let config = await readConfig();
  if (config.kind === "unknown") {
    io.say(
      "The official client could not read this connection safely. No configuration was changed. Retry --diagnose after checking the client.",
    );
    return { ok: false, reason: "unknown_config" };
  }
  if (options.mode === "remove") {
    if (config.kind === "missing") {
      io.say("No spicy-studio connection is configured. Your official login is unchanged.");
      return { ok: true };
    }
    if (!config.own || config.scope !== "user") {
      io.say(
        "This name belongs to a different or project-specific connection. It was not removed. Review it in the official client.",
      );
      return { ok: false, reason: "not_owned" };
    }
    if (
      (await io.choose(
        "Remove only the spicy-studio connection? Your assistant login and all other connections stay unchanged.",
        ["Keep connection", "Remove connection"],
      )) !== 1
    )
      return { ok: false, reason: "cancelled" };
    const result = await call(launcher, removeArgs(client));
    config = await readConfig();
    if (result.error || result.code !== 0 || config.kind !== "missing") {
      io.say(
        "Removal could not be verified. Retry --diagnose; your official account was not logged out.",
      );
      return { ok: false, reason: "remove_failed" };
    }
    io.say(
      "Studio connection configuration removed. Your official account remains signed in. Disconnect in Studio, then close or restart the official assistant session to stop an already-running bridge.",
    );
    return { ok: true };
  }
  if (config.kind === "conflict") {
    if (client === "claude" && config.scope !== "user") {
      io.say(
        "A local, project, or managed connection already uses spicy-studio. We only manage user-scope connections. Review the conflict in the official client, then retry.",
      );
      return { ok: false, reason: "scope_conflict" };
    }
    const answer = await io.choose(
      "A different spicy-studio connection already exists. Replace only this entry with the included local bridge? All other connections remain unchanged. If installation is interrupted, rerun this wizard.",
      ["Keep existing connection", "Replace spicy-studio"],
    );
    if (answer !== 1) return { ok: false, reason: "cancelled" };
    if (client === "claude") {
      const removed = await call(launcher, removeArgs(client));
      if (removed.error || removed.code !== 0) {
        io.say(
          "The old entry could not be removed. No replacement was attempted. Retry --diagnose.",
        );
        return { ok: false, reason: "remove_failed" };
      }
    }
  }
  // codex mcp add rewrites the whole entry, so remember an approval setting the user already chose for it.
  const keepApproval =
    codexConfig && config.kind !== "matching" ? approvalValue(await readCodexApproval(codexConfig)) : undefined;
  if (config.kind !== "matching") {
    const added = await call(launcher, addArgs(client, expected));
    // A timeout can still have saved the entry. Read it back before suggesting another write.
    config = await readConfig();
    if (config.kind !== "matching") {
      io.say(
        "The connection was not verified. A previous same-name entry may have been removed after your confirmation. Rerun this wizard to finish setup; other connections and your official login were not changed.",
      );
      return { ok: false, reason: added.error ?? "config_failed" };
    }
  }
  const approval = codexConfig
    ? await ensureCodexApproval(codexConfig, {
        keep: keepApproval,
        io,
        verify: async () => (await readConfig()).kind === "matching",
      })
    : undefined;
  io.say(
    "Studio connection configuration verified. Restart or reconnect your official assistant. Signing in is not the same as pairing the website.",
  );
  sayNextSteps(io);
  return { ok: true, auth, ...(approval ? { approval } : {}) };
}

/** What to do after setup; identical for every client so the website instructions always match. */
function sayNextSteps(io) {
  io.say(`In that assistant, send: "${CONNECT_MESSAGE}"`);
  io.say(`Back in Studio on this computer, open "Connect your AI" and enter the code. Then send: "${NEXT_MESSAGE}"`);
  io.say(
    "Only one assistant session can hold the Studio connection at a time. If a tool says another session is connected, use that session or close it.",
  );
  io.say(
    "Review drafts before applying them. This bridge adds no SpicyAPI charge. Your assistant app uses its own subscription allowance or API billing; paid images/videos require separate Studio confirmation.",
  );
}

export const CONNECT_MESSAGE =
  "Call the Spicy Studio tool studio_connect with reset set to true, then show me the new pairing code.";
/** Works before or after the request is shared: the assistant waits for it with wait_seconds instead of giving up. */
export const NEXT_MESSAGE =
  "Process my next Spicy Studio request and return the draft for review. If none is waiting yet, call studio_next_request with wait_seconds set to 30 and keep calling it until one arrives.";

async function verifyRuntime(call, node, entry, io) {
  const packageCheck = await call({ command: node, prefix: [] }, [entry, "--version"]);
  if (packageCheck.error || packageCheck.code !== 0 || packageCheck.stdout.trim() !== BRIDGE_VERSION) {
    io.say(
      `The included bridge could not be verified. Restore the complete ${BRIDGE_VERSION} delivery folder and try again.`,
    );
    return false;
  }
  return true;
}

const OWN_ENTRY = /(?:^|[\\/])@spicyapi[\\/]studio-bridge[\\/]dist[\\/]src[\\/]cli\.js$/;

/** Classify our entry inside a parsed settings file: missing, matching, or conflict (and whether it is ours). */
export function fileEntryStatus(settings, expected) {
  const servers = settings?.mcpServers;
  const value = servers && typeof servers === "object" && !Array.isArray(servers) ? servers[SERVER_NAME] : undefined;
  if (value === undefined) return { kind: "missing" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "conflict", own: false };
  const args = Array.isArray(value.args) ? value.args : [];
  const own = typeof value.command === "string" && args.length === 1 && OWN_ENTRY.test(String(args[0] ?? ""));
  const extra = Object.keys(value).filter((key) => !["command", "args", "type"].includes(key));
  const same =
    value.command === expected.node &&
    args.length === 1 &&
    args[0] === expected.entry &&
    (value.type === undefined || value.type === "stdio") &&
    extra.length === 0;
  return { kind: same ? "matching" : "conflict", own: own || same };
}

/** Read a JSON settings file. Missing file = empty settings. Anything that is not a plain JSON object is refused. */
export async function readSettings(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, settings: {} };
    return { exists: true, error: "unreadable" };
  }
  if (!text.trim()) return { exists: true, settings: {} };
  try {
    const settings = JSON.parse(text);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { exists: true, error: "not_object" };
    if (settings.mcpServers !== undefined && (typeof settings.mcpServers !== "object" || Array.isArray(settings.mcpServers)))
      return { exists: true, error: "not_object" };
    return { exists: true, settings };
  } catch {
    return { exists: true, error: "not_json" };
  }
}

/**
 * Replace a file atomically, first keeping a timestamped backup of the previous version (unless backup is false).
 * A symlinked settings file is written through its link, so dotfile setups keep their link.
 */
export async function writeTextFile(path, text, { exists, backup: keepBackup = true, now = Date.now } = {}) {
  const target = exists ? await realpath(path) : path;
  await mkdir(dirname(target), { recursive: true });
  let mode = 0o600;
  let backup = null;
  if (exists) {
    mode = (await stat(target)).mode & 0o777;
    if (keepBackup) {
      backup = `${target}.spicy-studio-backup-${now()}`;
      await copyFile(target, backup);
    }
  }
  const temporary = `${target}.spicy-studio-tmp-${process.pid}`;
  try {
    await writeFile(temporary, text, { mode });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return backup;
}

/** Replace a JSON settings file atomically after keeping a timestamped backup of the previous version. */
export function writeSettings(path, settings, options = {}) {
  return writeTextFile(path, JSON.stringify(settings, null, 2) + "\n", options);
}

export function connectionSnippet(node, entry) {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: node, args: [entry] } } }, null, 2);
}

/** The Codex config.toml entry, with tool approval scoped to this server only. JSON strings are valid TOML strings. */
export function codexConfigSnippet(node, entry) {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(node)}`,
    `args = [${JSON.stringify(entry)}]`,
    `${CODEX_APPROVAL_KEY} = "${CODEX_APPROVAL_VALUE}"`,
  ].join("\n");
}

/** Codex reads config.toml from CODEX_HOME, or ~/.codex when it is not set. */
export function codexConfigPath({ env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  return env.CODEX_HOME ? join(resolve(cwd, env.CODEX_HOME), "config.toml") : join(home, ".codex", "config.toml");
}

const TOML_HEADER = /^\s*\[{1,2}[^[\]]+\]{1,2}\s*(?:#.*)?$/;
const OWN_TABLE = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*(?:${SERVER_NAME}|"${SERVER_NAME}"|'${SERVER_NAME}')\s*\]\s*(?:#.*)?$`);
const APPROVAL_LINE = new RegExp(String.raw`^\s*(["']?)${CODEX_APPROVAL_KEY}\1\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]*))`);

/** Split TOML text into lines and mark the lines that start inside a multi-line string; those are never keys. */
function tomlLines(text) {
  let open = null;
  return text.split(/\r?\n/).map((line) => {
    const inside = open !== null;
    for (let i = 0; i < line.length; ) {
      if (open) {
        const end = line.indexOf(open, i);
        if (end < 0) break;
        i = end + 3;
        open = null;
      } else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        open = line.slice(i, i + 3);
        i += 3;
      } else if (line[i] === "#") break;
      else if (line[i] === '"') {
        for (i++; i < line.length && line[i] !== '"'; ) i += line[i] === "\\" ? 2 : 1;
        i++;
      } else if (line[i] === "'") {
        const end = line.indexOf("'", i + 1);
        i = end < 0 ? line.length : end + 1;
      } else i++;
    }
    return { text: line, inside };
  });
}

/**
 * Read this bridge's tool approval setting from Codex config.toml text. Kinds: "set" (with value), "missing"
 * (our table exists without the key; insertAt is where to add it), "no-entry" (no [mcp_servers.spicy-studio] table)
 * and "unsupported" (duplicate tables or keys: never edit it automatically).
 */
export function codexApprovalStatus(text) {
  const lines = tomlLines(text);
  const headers = [];
  lines.forEach((line, index) => {
    if (!line.inside && TOML_HEADER.test(line.text)) headers.push(index);
  });
  const own = headers.filter((index) => OWN_TABLE.test(lines[index].text));
  if (!own.length) return { kind: "no-entry" };
  if (own.length > 1) return { kind: "unsupported" };
  const end = headers.find((index) => index > own[0]) ?? lines.length;
  let insertAt = own[0] + 1;
  const found = [];
  for (let index = own[0] + 1; index < end; index++) {
    const { text: line, inside } = lines[index];
    if (!line.trim() || (!inside && /^\s*#/.test(line))) continue;
    // Insert after the last line that belongs to the table, before any comment that introduces the next one.
    insertAt = index + 1;
    const match = inside ? null : APPROVAL_LINE.exec(line);
    if (match) found.push(match[2] ?? match[3] ?? match[4].trim());
  }
  if (found.length > 1) return { kind: "unsupported" };
  return found.length ? { kind: "set", value: found[0] } : { kind: "missing", insertAt };
}

/** Add the approval key to our table only. Returns null when the key is already set or the file must not be edited. */
export function withCodexApproval(text, value = CODEX_APPROVAL_VALUE) {
  const status = codexApprovalStatus(text);
  if (status.kind !== "missing") return null;
  const lines = text.split(/\r?\n/);
  lines.splice(status.insertAt, 0, `${CODEX_APPROVAL_KEY} = ${JSON.stringify(value)}`);
  return lines.join(text.includes("\r\n") ? "\r\n" : "\n");
}

async function readCodexApproval(path) {
  try {
    const text = await readFile(path, "utf8");
    return { exists: true, text, status: codexApprovalStatus(text) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, text: "", status: { kind: "no-entry" } };
    return { exists: true, status: { kind: "unsupported" } };
  }
}

const approvalValue = (read) => (read.status.kind === "set" ? read.status.value : undefined);

function describeApproval(read) {
  if (read.status.kind === "set") return `${CODEX_APPROVAL_KEY} = "${read.status.value}"`;
  if (read.status.kind === "unsupported") return "could not be read safely";
  return "not set (Codex asks before each Studio tool call, and codex exec rejects them)";
}

/**
 * Make codex exec able to call the Studio tools by setting the approval key on our entry only. The user's global
 * approval policy and every other server stay unchanged. A value the user already chose is kept and reported. If
 * Codex no longer reads its configuration after the edit (for example an older Codex without this key), the previous
 * file is restored.
 */
async function ensureCodexApproval(path, { keep, io, verify }) {
  const manual = `To let non-interactive runs (codex exec) use the Studio tools, add this line under [mcp_servers.${SERVER_NAME}] in ${path}: ${CODEX_APPROVAL_KEY} = "${CODEX_APPROVAL_VALUE}"`;
  const approved = `Codex may run the Studio tools without asking each time, including in codex exec (${CODEX_APPROVAL_KEY} = "${CODEX_APPROVAL_VALUE}" on ${SERVER_NAME} only; your global approval policy is unchanged). Set it to "prompt" to be asked before each call.`;
  const kept = (value) =>
    `Your Codex setting ${CODEX_APPROVAL_KEY} = "${value}" for ${SERVER_NAME} was kept. Non-interactive runs (codex exec) need "${CODEX_APPROVAL_VALUE}"; with other values they may reject the Studio tools.`;
  const current = await readCodexApproval(path);
  if (current.status.kind === "set") {
    io.say(current.status.value === CODEX_APPROVAL_VALUE ? approved : kept(current.status.value));
    return current.status.value;
  }
  if (current.status.kind !== "missing") {
    io.say(`The Studio entry in ${path} could not be edited safely, so it was left unchanged. ${manual}`);
    return "manual";
  }
  const value = keep ?? CODEX_APPROVAL_VALUE;
  let backup;
  try {
    backup = await writeTextFile(path, withCodexApproval(current.text, value), { exists: true });
  } catch {
    io.say(`${path} could not be written, so it was left unchanged. ${manual}`);
    return "manual";
  }
  const saved = await readCodexApproval(path);
  if (approvalValue(saved) !== value || !(await verify())) {
    await writeTextFile(path, current.text, { exists: true, backup: false });
    io.say(
      `Codex did not accept ${CODEX_APPROVAL_KEY} (it may be an older version), so ${path} was restored unchanged. Codex will ask before each Studio tool call, and codex exec rejects them. ${manual} after updating Codex.`,
    );
    return "restored";
  }
  io.say(`The previous Codex settings were saved as ${backup}.`);
  io.say(value === CODEX_APPROVAL_VALUE ? approved : kept(value));
  return value;
}

/**
 * Cursor and Gemini CLI: add, verify or remove one entry in the client's own settings file.
 * Other settings are preserved; the previous file is backed up; files with comments are never rewritten.
 */
async function fileWizard(client, options, { entry, node, cwd, env, signal, io, run, home }) {
  const info = FILE_CLIENTS[client];
  const path = info.path(home);
  const expected = { node, entry };
  const call = async (launcher, args) => {
    if (signal?.aborted) throw new Error("cancelled");
    return run(launcher, args, { cwd, env, signal, interactive: false, timeoutMs: 20000 });
  };
  io.say(
    `Studio Bridge adds one ${SERVER_NAME} entry to ${info.name}'s settings file. No API key is requested; sign in inside ${info.name} as usual.`,
  );
  if (!(await verifyRuntime(call, node, entry, io))) return { ok: false, reason: "missing_runtime" };
  const read = await readSettings(path);
  if (read.error) {
    io.say(
      `${path} is not plain JSON (it may contain comments), so it was not changed. Add this entry to it yourself:`,
    );
    io.say(connectionSnippet(node, entry));
    return { ok: false, reason: "unknown_config" };
  }
  let status = fileEntryStatus(read.settings, expected);
  if (["diagnose", "dry-run"].includes(options.mode)) {
    io.say(`Studio connection configuration: ${status.kind} (${path}).`);
    io.say(
      options.mode === "dry-run"
        ? "Dry run only. A normal run asks before replacing an existing entry, keeps a backup of the file, and changes nothing else."
        : "Diagnostics only. No configuration was changed.",
    );
    return { ok: status.kind === "matching", reason: "read_only", config: status.kind };
  }
  const save = async (settings) => {
    const backup = await writeSettings(path, settings, { exists: read.exists });
    if (backup) io.say(`The previous settings were saved as ${backup}.`);
    const again = await readSettings(path);
    return again.error ? { kind: "unknown" } : fileEntryStatus(again.settings, expected);
  };
  if (options.mode === "remove") {
    if (status.kind === "missing") {
      io.say(`No ${SERVER_NAME} entry is configured in ${path}.`);
      return { ok: true };
    }
    if (!status.own) {
      io.say("This entry belongs to a different connection. It was not removed. Review it in the settings file.");
      return { ok: false, reason: "not_owned" };
    }
    const confirmed = await io.choose(
      `Remove only the ${SERVER_NAME} entry from ${path}? Everything else in the file stays the same.`,
      ["Keep connection", "Remove connection"],
    );
    if (confirmed !== 1) return { ok: false, reason: "cancelled" };
    const settings = structuredClone(read.settings);
    delete settings.mcpServers[SERVER_NAME];
    status = await save(settings);
    if (status.kind !== "missing") {
      io.say("Removal could not be verified. Check the settings file.");
      return { ok: false, reason: "remove_failed" };
    }
    io.say(`Studio connection removed. ${info.restart}`);
    return { ok: true };
  }
  if (status.kind === "conflict") {
    const answer = await io.choose(
      `A different ${SERVER_NAME} entry already exists in ${path}. Replace only this entry? A backup of the file is kept.`,
      ["Keep existing entry", `Replace ${SERVER_NAME}`],
    );
    if (answer !== 1) return { ok: false, reason: "cancelled" };
  }
  if (status.kind !== "matching") {
    const settings = structuredClone(read.settings);
    settings.mcpServers = { ...(settings.mcpServers ?? {}), [SERVER_NAME]: { command: node, args: [entry] } };
    status = await save(settings);
    if (status.kind !== "matching") {
      io.say("The connection was not verified. Check the settings file and rerun this wizard.");
      return { ok: false, reason: "config_failed" };
    }
  }
  io.say(`Studio connection configuration verified in ${path}. ${info.restart}`);
  sayNextSteps(io);
  return { ok: true, auth: "not-checked" };
}
