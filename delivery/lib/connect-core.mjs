import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";

export const SERVER_NAME = "spicy-studio";
export const INSTALL_URLS = {
  node: "https://nodejs.org/en/download",
  codex: "https://learn.chatgpt.com/docs/developer-commands?surface=cli",
  claude: "https://code.claude.com/docs/en/setup",
};

export function parseOptions(args) {
  const options = { mode: "connect", client: undefined, deviceAuth: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--client") {
      const value = args[++i];
      if (value !== "codex" && value !== "claude")
        throw new Error("Choose --client codex or --client claude.");
      options.client = value;
    } else if (["--diagnose", "--dry-run", "--remove", "--help"].includes(arg)) {
      if (options.mode !== "connect")
        throw new Error("Use only one of --diagnose, --dry-run, --remove, or --help.");
      options.mode = arg.slice(2);
    } else if (arg === "--device-auth") options.deviceAuth = true;
    else throw new Error("Unknown option. Run node connect.mjs --help.");
  }
  if (options.deviceAuth && options.client === "claude")
    throw new Error("--device-auth is only available with Codex.");
  return options;
}

export function cliCandidates(
  client,
  {
    env = process.env,
    platform = process.platform,
    home = homedir(),
    node = process.execPath,
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
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
      join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    );
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
    clean = !/Environment(?: variables)?:\s*\S|Status:.*(?:disabled|pending approval)/i.test(
      output,
    );
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
  } = {},
) {
  const client =
    options.client ??
    (await io
      .choose("Which official assistant do you use?", [
        "Codex (ChatGPT account)",
        "Claude Code (Claude account)",
        "Cancel",
      ])
      .then((value) => ["codex", "claude"][value]));
  if (!client) return { ok: false, reason: "cancelled" };
  if (options.deviceAuth && client !== "codex")
    throw new Error("--device-auth is only available with Codex.");
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
        `The official ${client === "codex" ? "Codex" : "Claude Code"} CLI was not found or could not be verified. Install it using ${INSTALL_URLS[client]}`,
      );
      if (
        options.mode !== "connect" ||
        (await io.choose("After installing, retry detection?", ["Retry", "Cancel"])) !== 0
      )
        return { ok: false, reason: "missing_cli" };
    }
  }
  io.say(`Official ${client === "codex" ? "Codex" : "Claude Code"} CLI detected.`);
  const packageCheck = await call({ command: node, prefix: [] }, [entry, "--version"]);
  if (packageCheck.error || packageCheck.code !== 0 || !/^0\.2\.0\s*$/.test(packageCheck.stdout)) {
    io.say(
      "The included bridge could not be verified. Restore the complete 0.2.0 delivery folder and try again.",
    );
    return { ok: false, reason: "missing_runtime" };
  }
  const readConfig = async () =>
    configStatus(client, await call(launcher, getArgs(client)), expected);
  let auth =
    options.mode === "remove"
      ? "not-checked"
      : authStatus(client, await call(launcher, authArgs(client)));
  io.say(
    `Official login: ${auth === "account" ? "account login detected; your plan and usage rules still apply" : auth === "api" ? "API or provider billing detected, not a verified subscription login" : auth}.`,
  );
  if (["diagnose", "dry-run"].includes(options.mode)) {
    const config = await readConfig();
    io.say(`Studio connection configuration: ${config.kind}.`);
    io.say(
      options.mode === "dry-run"
        ? "Dry run only. A normal run offers official account login if needed, asks before replacing an existing connection, writes only spicy-studio through the official CLI, then verifies it. No login or configuration was changed."
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
  io.say(
    "Studio connection configuration verified. Restart or reconnect your official assistant. Signing in is not the same as pairing the website.",
  );
  io.say(
    'In that assistant, send: "Use studio_connect to connect my Spicy Studio browser. Show me the pairing code."',
  );
  io.say(
    'Back in Studio on this computer, choose "My Codex or Claude Code" and enter the code. After sharing a request, send: "Process my next Studio request and return the draft for review."',
  );
  io.say(
    "Review drafts before applying them. This bridge adds no SpicyAPI LLM charge. Your official client uses its own subscription allowance or API billing; paid images/videos require separate Studio confirmation.",
  );
  return { ok: true, auth };
}
