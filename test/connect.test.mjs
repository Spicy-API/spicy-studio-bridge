import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rm,
  mkdir,
  chmod,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import test from "node:test";
import { setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import {
  BRIDGE_VERSION,
  CODEX_APPROVAL_KEY,
  authStatus,
  bundledCodexCandidates,
  claudeHasEnvironment,
  cliCandidates,
  codexApprovalStatus,
  codexConfigPath,
  codexConfigSnippet,
  configStatus,
  connectionSnippet,
  connectionWizard,
  detectCli,
  fileEntryStatus,
  parseOptions,
  readSettings,
  runCommand,
  withCodexApproval,
} from "../delivery/lib/connect-core.mjs";

const fakeSource = `
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const file=process.env.STUDIO_TEST_STATE;
if(!file)throw new Error('Missing isolated test state');
// Like the real Codex CLI, mcp add rewrites the whole spicy-studio table in CODEX_HOME/config.toml and drops keys it
// does not set, and mcp remove deletes the table. Other lines are kept.
const toml=process.env.CODEX_HOME?join(process.env.CODEX_HOME,'config.toml'):null;
const readToml=()=>toml&&existsSync(toml)?readFileSync(toml,'utf8'):'';
const withoutEntry=(text)=>text.replace(/^\\[mcp_servers\\.spicy-studio\\]\\r?\\n(?:(?!\\[).*(?:\\r?\\n|$))*/m,'');
const state=JSON.parse(readFileSync(file,'utf8'));
const args=process.argv.slice(2);state.calls.push(args);
const save=()=>writeFileSync(file,JSON.stringify(state));
const end=(text,code=0)=>{save();console.log(text);process.exit(code)};
if(args[0]==='--version')end(state.client==='codex'?'codex-cli 0.155.0':'2.1.268 (Claude Code)');
if(args.join(' ')==='login status'||args.join(' ')==='auth status --json'){
 if(state.auth==='unknown')end('This output changed');
 if(state.client==='codex')end(state.auth==='account'?'Logged in using ChatGPT':state.auth==='api'?'Logged in using an API key - sk-private-test':'Not logged in',state.auth==='signed-out'?1:0);
 end(JSON.stringify({loggedIn:state.auth!=='signed-out',authMethod:state.auth==='account'?'claude.ai':'api_key',email:'private-test@example.test',apiKey:'never-print-this'}),state.auth==='signed-out'?1:0);
}
if(args[0]==='login'||args[0]==='auth'){
 if(args.includes('logout')||args.includes('--with-api-key'))end('Forbidden login command',90);
 if(state.hangLogin){state.childPid=process.pid;save();setInterval(()=>{},1000)}
 else{state.auth=state.nextAuth??'account';end('Official test login complete',state.failLogin?1:0)}
}else if(args[0]==='mcp'){
 if(args[1]==='get'){
  if(state.unknownConfig)end('Unrecognized config response');
  // An older Codex that does not know the approval key refuses to load the whole file.
  if(state.rejectApproval&&readToml().includes('default_tools_approval_mode'))end('Error: failed to load configuration: unknown field default_tools_approval_mode in mcp_servers.spicy-studio',1);
  const value=state.config;
  if(!value)end('No MCP server found with name: spicy-studio',1);
  if(state.client==='codex')end(JSON.stringify({name:'spicy-studio',enabled:true,transport:value}));
  // Same layout as Claude Code 2.1.285: an Environment heading is printed even for env {}, then a removal hint.
  const env=Object.entries(value.env??{}).map(([k,v])=>'\\n    '+k+'='+v).join('');
  end('Checking MCP server health…\\n\\nspicy-studio:\\n  Scope: '+(value.scope??'User')+' config (available in all your projects)\\n  Status: ✓ Connected\\n  Type: '+value.type+'\\n  Command: '+value.command+'\\n  Args: '+value.args.join(' ')+'\\n  Environment:'+env+'\\n\\nTo remove this server, run: claude mcp remove \"spicy-studio\" -s user');
 }
 if(args[1]==='remove'){state.config=null;if(state.client==='codex'&&toml)writeFileSync(toml,withoutEntry(readToml()));end('Removed only spicy-studio')}
 if(args[1]==='add'){
  if(state.failAdd)end('Failed to write config',1);
  const index=args.indexOf('--');state.config={type:'stdio',command:args[index+1],args:args.slice(index+2)};
  if(state.client==='codex'&&toml)writeFileSync(toml,withoutEntry(readToml())+'[mcp_servers.spicy-studio]\\ncommand = '+JSON.stringify(args[index+1])+'\\nargs = '+JSON.stringify(args.slice(index+2))+'\\n');
  if(state.hangAfterAdd){save();setInterval(()=>{},1000)}else end('Added spicy-studio');
 }
}else end('Unexpected command',99);
`;

async function fixture(t, client = "codex", initial = {}) {
  const root = await mkdtemp(join(tmpdir(), "studio wizard space & "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, "fake-state.json"),
    fake = join(root, "official test cli.mjs");
  const entry = join(
    root,
    "runtime",
    "node_modules",
    "@spicyapi",
    "studio-bridge",
    "dist",
    "src",
    "cli.js",
  );
  await mkdir(join(entry, ".."), { recursive: true });
  await writeFile(entry, `console.log('${BRIDGE_VERSION}');\n`);
  await writeFile(fake, fakeSource);
  await writeFile(
    stateFile,
    JSON.stringify({
      client,
      auth: "account",
      config: null,
      calls: [],
      others: { keep: "untouched" },
      ...initial,
    }),
  );
  const lines = [],
    prompts = [],
    answers = [];
  const launcher = { command: process.execPath, prefix: [fake] };
  // Never touch a real Codex configuration: CODEX_HOME and the home folder both point inside the temporary root.
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  const env = { ...process.env, STUDIO_TEST_STATE: stateFile, CODEX_HOME: codexHome };
  const io = {
    say: (value) => lines.push(value),
    choose: (question, choices) => {
      prompts.push({ question, choices });
      assert.ok(answers.length, `Unexpected question: ${question}`);
      return Promise.resolve(answers.shift());
    },
    pause: () => {},
    resume: () => {},
  };
  const context = {
    entry,
    io,
    env,
    home: join(root, "home"),
    detect: () => Promise.resolve(launcher),
    run: (target, args, opts) =>
      runCommand(target, args, { ...opts, interactive: false, timeoutMs: 15000 }),
  };
  return {
    root,
    entry,
    codexToml: join(codexHome, "config.toml"),
    launcher,
    env,
    io,
    lines,
    prompts,
    answers,
    context,
    read: async () => JSON.parse(await readFile(stateFile, "utf8")),
    patch: async (patch) =>
      writeFile(
        stateFile,
        JSON.stringify({ ...JSON.parse(await readFile(stateFile, "utf8")), ...patch }),
      ),
    run: (mode = "connect", extra = {}) =>
      connectionWizard({ client, mode, deviceAuth: false, ...extra }, context),
  };
}

test("CLI options are bounded and do not accept arbitrary commands", () => {
  assert.deepEqual(parseOptions(["--client", "codex", "--dry-run"]), {
    client: "codex",
    mode: "dry-run",
    deviceAuth: false,
  });
  for (const client of ["cursor", "gemini"]) assert.equal(parseOptions(["--client", client]).client, client);
  for (const args of [
    ["--client", "other"],
    ["--diagnose", "--remove"],
    ["--client", "claude", "--device-auth"],
    ["--client", "cursor", "--device-auth"],
    ["--exec", "login"],
  ])
    assert.throws(() => parseOptions(args));
});

test("account, API, signed-out and unknown statuses stay distinct without exposing auth fields", () => {
  const response = (stdout, code = 0) => ({ stdout, stderr: "", code });
  assert.equal(authStatus("codex", response("Logged in using ChatGPT")), "account");
  assert.equal(authStatus("codex", response("Logged in using an API key - secret")), "api");
  assert.equal(authStatus("codex", response("Not logged in", 1)), "signed-out");
  assert.equal(authStatus("codex", response("ok")), "unknown");
  assert.equal(
    authStatus(
      "claude",
      response(JSON.stringify({ loggedIn: true, authMethod: "oauth", subscriptionType: "max" })),
    ),
    "account",
  );
  assert.equal(
    authStatus(
      "claude",
      response(JSON.stringify({ loggedIn: true, authMethod: "oauth", subscriptionType: null })),
    ),
    "unknown",
  );
  assert.equal(
    authStatus(
      "claude",
      response(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" })),
    ),
    "api",
  );
  assert.equal(
    authStatus("claude", response(JSON.stringify({ loggedIn: false }), 1)),
    "signed-out",
  );
  assert.equal(
    authStatus("claude", response(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), 1)),
    "unknown",
  );
});

for (const client of ["codex", "claude"]) {
  test(`${client}: signed-in setup writes only our connection, verifies it, and preserves paths with spaces`, async (t) => {
    const f = await fixture(t, client);
    assert.equal((await f.run()).ok, true);
    const state = await f.read();
    assert.deepEqual(state.config.args, [f.entry]);
    assert.equal(state.config.command, process.execPath);
    assert.deepEqual(state.others, { keep: "untouched" });
    assert.equal(state.calls.filter((args) => args[0] === "mcp" && args[1] === "add").length, 1);
    assert.ok(
      state.calls.some(
        (args) =>
          args.join(" ") ===
          (client === "codex" ? "mcp get spicy-studio --json" : "mcp get spicy-studio"),
      ),
    );
    if (client === "claude")
      assert.ok(
        state.calls.some(
          (args) =>
            args.slice(0, 8).join(" ") === "mcp add --scope user --transport stdio spicy-studio --",
        ),
      );
    assert.doesNotMatch(f.lines.join("\n"), /private-test|never-print-this|sk-private|API key:/);
    assert.match(f.lines.join("\n"), /Signing in is not the same as pairing/);
    assert.equal(f.prompts.length, 0);
    assert.equal((await f.run()).ok, true);
    assert.equal((await f.read()).calls.filter((args) => args[1] === "add").length, 1);
  });

  test(`${client}: signed-out users enter the official browser flow and are checked again`, async (t) => {
    const f = await fixture(t, client, { auth: "signed-out" });
    f.answers.push(0);
    assert.equal((await f.run()).ok, true);
    const calls = (await f.read()).calls;
    assert.ok(
      calls.some(
        (args) => args.join(" ") === (client === "codex" ? "login" : "auth login --claudeai"),
      ),
    );
    assert.equal(calls.filter((args) => args.join(" ").includes("status")).length, 2);
    assert.ok(calls.every((args) => !args.includes("logout") && !args.includes("--with-api-key")));
  });

  test(`${client}: API login requires an explicit choice and never silently logs out`, async (t) => {
    const f = await fixture(t, client, { auth: "api" });
    f.answers.push(1);
    const result = await f.run();
    assert.equal(result.ok, true);
    assert.equal(result.auth, "api");
    assert.equal(
      (await f.read()).calls.filter(
        (args) =>
          (args[0] === "login" && args[1] !== "status") ||
          (args[0] === "auth" && args[1] === "login"),
      ).length,
      0,
    );
    assert.match(f.prompts[0].question, /API\/provider billing/);
  });

  test(`${client}: switching from API to account uses only the official login and rechecks its result`, async (t) => {
    const f = await fixture(t, client, { auth: "api" });
    f.answers.push(0);
    assert.equal((await f.run()).auth, "account");
    assert.ok((await f.read()).calls.every((args) => !args.includes("logout")));
  });

  test(`${client}: unknown login does not configure anything or imply success`, async (t) => {
    const f = await fixture(t, client, { auth: "unknown" });
    f.answers.push(2);
    assert.equal((await f.run()).ok, false);
    assert.equal(
      (await f.read()).calls.some((args) => args[0] === "mcp"),
      false,
    );
    assert.match(f.prompts[0].question, /not a successful login check/);
  });

  test(`${client}: diagnostics and dry-run do not invoke login, add, remove, or generation`, async (t) => {
    const f = await fixture(t, client, { auth: "signed-out" });
    for (const mode of ["diagnose", "dry-run"]) assert.equal((await f.run(mode)).ok, false);
    assert.ok(
      (await f.read()).calls.every(
        (args) => args[0] === "--version" || args.includes("status") || args[1] === "get",
      ),
    );
    assert.equal(f.prompts.length, 0);
  });

  test(`${client}: a different same-name connection is untouched when replacement is declined`, async (t) => {
    const original = { type: "stdio", command: "/other/node", args: ["/other/server.js"] };
    const f = await fixture(t, client, { config: original });
    f.answers.push(0);
    assert.equal((await f.run()).ok, false);
    assert.deepEqual((await f.read()).config, original);
    assert.ok((await f.read()).calls.every((args) => args[1] !== "add" && args[1] !== "remove"));
  });

  test(`${client}: approved replacement preserves every other connection`, async (t) => {
    const f = await fixture(t, client, {
      config: { type: "stdio", command: "/old/node", args: ["/old/server.js"] },
    });
    f.answers.push(1);
    assert.equal((await f.run()).ok, true);
    assert.deepEqual((await f.read()).others, { keep: "untouched" });
    assert.deepEqual((await f.read()).config.args, [f.entry]);
  });

  test(`${client}: removal only manages our user connection and does not inspect or log out an account`, async (t) => {
    const f = await fixture(t, client);
    await f.patch({ config: { type: "stdio", command: process.execPath, args: [f.entry] } });
    f.answers.push(1);
    assert.equal((await f.run("remove")).ok, true);
    const state = await f.read();
    assert.equal(state.config, null);
    assert.equal(state.auth, "account");
    assert.ok(state.calls.every((args) => args[0] !== "auth" && args[0] !== "login"));
    await f.patch({
      config: { type: "stdio", command: "/other/node", args: ["/other/server.js"] },
    });
    assert.equal((await f.run("remove")).reason, "not_owned");
  });
}

test("Claude project-scope name collisions never remove or overwrite project configuration", async (t) => {
  const f = await fixture(t, "claude", {
    config: { type: "stdio", scope: "Project", command: "/old/node", args: ["/old/server.js"] },
  });
  assert.equal((await f.run()).reason, "scope_conflict");
  assert.ok((await f.read()).calls.every((args) => args[1] !== "remove" && args[1] !== "add"));
});

test("failed replacement is reported honestly and an explicit rerun completes it without losing other connections", async (t) => {
  const f = await fixture(t, "claude", {
    failAdd: true,
    config: { type: "stdio", command: "/old/node", args: ["/old/server.js"] },
  });
  f.answers.push(1);
  assert.equal((await f.run()).ok, false);
  assert.match(f.lines.join("\n"), /may have been removed/);
  await f.patch({ failAdd: false });
  assert.equal((await f.run()).ok, true);
  assert.deepEqual((await f.read()).others, { keep: "untouched" });
});

test("a timed-out add is read back before any duplicate write", async (t) => {
  const f = await fixture(t, "codex", { hangAfterAdd: true });
  f.context.run = (target, args, opts) =>
    runCommand(target, args, {
      ...opts,
      interactive: false,
      timeoutMs: args[1] === "add" ? 3000 : 15000,
    });
  assert.equal((await f.run()).ok, true);
  assert.equal((await f.read()).calls.filter((args) => args[1] === "add").length, 1);
});

test("timeout and cancellation stop the real fake-login subprocess and never write config", async (t) => {
  const f = await fixture(t, "codex", { auth: "signed-out", hangLogin: true });
  f.answers.push(0);
  f.context.run = (target, args, opts) =>
    runCommand(target, args, {
      ...opts,
      interactive: false,
      timeoutMs: opts.interactive ? 3000 : 15000,
    });
  assert.equal((await f.run()).reason, "timeout");
  const state = await f.read();
  assert.throws(() => process.kill(state.childPid, 0));
  assert.ok(state.calls.every((args) => args[0] !== "mcp"));
  const controller = new globalThis.AbortController();
  const pending = runCommand(f.launcher, ["login"], {
    env: f.env,
    signal: controller.signal,
    timeoutMs: 10000,
  });
  setTimeout(() => controller.abort(), 3000);
  assert.equal((await pending).error, "cancelled");
  const cancelled = await f.read();
  assert.throws(() => process.kill(cancelled.childPid, 0));
});

test("Codex device-code fallback is the official login flag, not token extraction", async (t) => {
  const f = await fixture(t, "codex", { auth: "signed-out" });
  f.answers.push(0);
  assert.equal((await f.run("connect", { deviceAuth: true })).ok, true);
  assert.ok((await f.read()).calls.some((args) => args.join(" ") === "login --device-auth"));
});

test("documented desktop Codex paths and Node's bin directory are checked without requiring PATH changes", () => {
  const list = cliCandidates("codex", {
    env: { PATH: "" },
    platform: "darwin",
    home: "/test-home",
    node: "/custom node/bin/node",
  });
  assert.ok(list.includes("/Applications/ChatGPT.app/Contents/Resources/codex"));
  assert.ok(list.includes("/Applications/Codex.app/Contents/Resources/codex"));
  assert.ok(list.includes("/custom node/bin/codex"));
});

test("Windows npm shims resolve only the known official JS entry and never invoke a shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "studio-windows-shim "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "codex.cmd"), "do not execute this shell shim");
  const entry = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(join(entry, ".."), { recursive: true });
  await writeFile(entry, "// isolated fake official entry\n");
  await chmod(join(root, "codex.cmd"), 0o755);
  const found = await detectCli("codex", {
    env: { PATH: root },
    platform: "win32",
    node: process.execPath,
    home: root,
  });
  assert.deepEqual(found, { command: process.execPath, prefix: [entry] });
});

test("npm-installed CLIs use the discovered Node even when a double-click launch has no Node on PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "studio-node-shim "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "official-cli.mjs");
  await writeFile(entry, "#!/usr/bin/env node\nconsole.log('codex-cli 0.155.0');\n");
  await chmod(entry, 0o755);
  await symlink(entry, join(root, "codex"));
  const found = await detectCli("codex", {
    env: { PATH: root },
    node: process.execPath,
    home: root,
  });
  assert.equal(found.command, process.execPath);
  assert.deepEqual(found.prefix, [await realpath(entry)]);
  assert.equal((await runCommand(found, ["--version"], { env: { PATH: root } })).code, 0);
});

test("unparseable configuration does not become missing and cannot authorize a write", () => {
  for (const client of ["codex", "claude"])
    assert.equal(
      configStatus(
        client,
        { code: 0, stdout: "unexpected", stderr: "" },
        { node: "/node", entry: "/bridge" },
      ).kind === "matching",
      false,
    );
  assert.equal(
    configStatus("codex", { code: 1, stdout: "", stderr: "Configuration is unreadable" }, {}).kind,
    "unknown",
  );
});

for (const reason of ["cancelled", "timeout"]) {
  test(
    `${reason} terminates an npm-style wrapper and its SIGTERM-resistant native child`,
    { skip: process.platform === "win32" },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "studio process tree "));
      t.after(() => rm(root, { recursive: true, force: true }));
      const pidFile = join(root, "native.pid");
      const native = join(root, "native.mjs");
      const wrapper = join(root, "wrapper.mjs");
      await writeFile(
        native,
        `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`,
      );
      await writeFile(
        wrapper,
        `import {spawn} from 'node:child_process';spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'});setInterval(()=>{},1000);`,
      );
      const controller = new globalThis.AbortController();
      const pending = runCommand(
        { command: process.execPath, prefix: [wrapper, native, pidFile] },
        [],
        { signal: controller.signal, timeoutMs: reason === "timeout" ? 10000 : 30000 },
      );
      let pid;
      const deadline = Date.now() + 8000;
      while (!pid && Date.now() < deadline) {
        try {
          pid = Number(await readFile(pidFile, "utf8"));
        } catch {
          await delay(30);
        }
      }
      assert.ok(pid, "the native grandchild must actually start before testing cancellation");
      t.after(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already terminated. */
        }
      });
      if (reason === "cancelled") controller.abort();
      assert.equal((await pending).error, reason);
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        try {
          process.kill(pid, 0);
          await delay(30);
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false, "the native grandchild must not survive its wrapper");
    },
  );
}

test("captured output remains bounded even while termination is in progress", async () => {
  const result = await runCommand(
    { command: process.execPath, prefix: [] },
    [
      "-e",
      "process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(100000)),1)",
    ],
    { timeoutMs: 10000 },
  );
  assert.equal(result.error, "output_limit");
  assert.ok(result.stdout.length + result.stderr.length <= 65536);
});

test(
  "Unix launchers skip an outdated PATH Node and preserve paths with spaces",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "studio launcher space & "));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "old-bin"));
    await writeFile(join(root, "old-bin", "node"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await mkdir(join(root, ".volta", "bin"), { recursive: true });
    await symlink(process.execPath, join(root, ".volta", "bin", "node"));
    await writeFile(join(root, "connect.mjs"), "console.log('LAUNCHER_OK');\n");
    for (const name of ["Connect-macOS.command", "Connect-Linux.sh"]) {
      await writeFile(
        join(root, name),
        await readFile(new URL(`../delivery/${name}`, import.meta.url)),
      );
      const result = await runCommand(
        { command: "/bin/sh", prefix: [] },
        [join(root, name), "--help"],
        { env: { ...process.env, HOME: root, PATH: join(root, "old-bin") + ":/usr/bin:/bin" } },
      );
      assert.equal(result.code, 0);
      assert.match(result.stdout, /LAUNCHER_OK/);
    }
  },
);

test("an explicit empty Codex tool allowlist is a configuration conflict", () => {
  const config = {
    name: "spicy-studio",
    enabled: true,
    transport: { type: "stdio", command: "/node", args: ["/bridge"] },
  };
  const result = (value) =>
    configStatus(
      "codex",
      { code: 0, stdout: JSON.stringify(value), stderr: "" },
      { node: "/node", entry: "/bridge" },
    );
  assert.equal(result(config).kind, "matching");
  assert.equal(result({ ...config, enabled_tools: [] }).kind, "conflict");
  assert.equal(result({ ...config, enabled_tools: ["some_other_tool"] }).kind, "conflict");
});

test("an invalid executable earlier on PATH does not hide a valid later official CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "studio CLI candidates "));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["bad", "good"]) {
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const seen = [];
  const found = await detectCli("codex", {
    env: { PATH: join(root, "bad") + ":" + join(root, "good") },
    home: root,
    verify: (launcher) => {
      seen.push(launcher.command);
      return launcher.command.endsWith("/good/codex");
    },
  });
  assert.equal(seen.length, 2);
  assert.ok(found.command.endsWith("/good/codex"));
});

test("remote Codex stdio executors never match a local loopback bridge", () => {
  const config = {
    name: "spicy-studio",
    transport: { type: "stdio", command: "/node", args: ["/bridge"] },
  };
  for (const value of [
    { ...config, experimental_environment: "remote" },
    { ...config, transport: { ...config.transport, experimental_environment: "remote" } },
  ]) {
    assert.equal(
      configStatus(
        "codex",
        { code: 0, stdout: JSON.stringify(value), stderr: "" },
        { node: "/node", entry: "/bridge" },
      ).kind,
      "conflict",
    );
  }
});

// Captured layout of `claude mcp get spicy-studio` from Claude Code 2.1.285 for an entry added without -e.
const CLAUDE_2_1_285_GET = [
  "Checking MCP server health…",
  "",
  "spicy-studio:",
  "  Scope: User config (available in all your projects)",
  "  Status: ✓ Connected",
  "  Type: stdio",
  "  Command: /opt/node/bin/node",
  "  Args: /opt/bridge/runtime/node_modules/@spicyapi/studio-bridge/dist/src/cli.js",
  "  Environment:",
  "",
  'To remove this server, run: claude mcp remove "spicy-studio" -s user',
].join("\n");

test("Claude Code 2.1.285: an empty Environment heading and the removal hint are not a conflict (B1)", () => {
  const expected = {
    node: "/opt/node/bin/node",
    entry: "/opt/bridge/runtime/node_modules/@spicyapi/studio-bridge/dist/src/cli.js",
  };
  assert.equal(claudeHasEnvironment(CLAUDE_2_1_285_GET), false);
  assert.deepEqual(configStatus("claude", { code: 0, stdout: CLAUDE_2_1_285_GET, stderr: "" }, expected), {
    kind: "matching",
    own: true,
    scope: "user",
  });
  // Counter-examples: real environment variables, inline or indented, still make it a conflict.
  const withEnv = CLAUDE_2_1_285_GET.replace("  Environment:", "  Environment:\n    API_TOKEN=value");
  assert.equal(claudeHasEnvironment(withEnv), true);
  assert.equal(configStatus("claude", { code: 0, stdout: withEnv, stderr: "" }, expected).kind, "conflict");
  assert.equal(claudeHasEnvironment("  Environment variables: TOKEN=x"), true);
  const disabled = CLAUDE_2_1_285_GET.replace("✓ Connected", "disabled");
  assert.equal(configStatus("claude", { code: 0, stdout: disabled, stderr: "" }, expected).kind, "conflict");
});

test("Codex bundled in the ChatGPT desktop app is detected from its codex-cli folder (B2)", async (t) => {
  const listed = bundledCodexCandidates(["/Applications"], (path) => {
    if (path === "/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-package.json")
      return JSON.stringify({ entrypoint: "bin/codex" });
    throw new Error("missing");
  });
  assert.ok(listed.includes("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"));
  assert.ok(listed.includes("/Applications/ChatGPT.app/Contents/Resources/codex"));
  // An entrypoint that points outside the bundle is ignored.
  const escaped = bundledCodexCandidates(["/Applications"], () => JSON.stringify({ entrypoint: "../../../../tmp/evil" }));
  assert.ok(escaped.every((path) => !path.includes("evil")));

  const root = await mkdtemp(join(tmpdir(), "studio desktop apps "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "..", "codex-package.json"), JSON.stringify({ entrypoint: "bin/codex" }));
  await writeFile(join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.159.0'\n", { mode: 0o755 });
  const found = await detectCli("codex", {
    env: { PATH: "" },
    platform: "darwin",
    home: root,
    node: "/nonexistent/node",
    applications: [root],
    verify: async (launcher) => (await runCommand(launcher, ["--version"])).stdout.includes("codex-cli"),
  });
  assert.equal(found.command, await realpath(join(bin, "codex")));
});

async function fileFixture(t, client, initialText) {
  const f = await fixture(t, client);
  const home = join(f.root, "home");
  const path = client === "cursor" ? join(home, ".cursor", "mcp.json") : join(home, ".gemini", "settings.json");
  if (initialText !== undefined) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, initialText);
  }
  f.context.home = home;
  return { ...f, path, readJson: async () => JSON.parse(await readFile(path, "utf8")) };
}

for (const client of ["cursor", "gemini"]) {
  test(`${client}: adds only our entry, keeps other settings and a backup, and is idempotent`, async (t) => {
    const original = { theme: "dark", mcpServers: { other: { command: "/other/server" } } };
    const f = await fileFixture(t, client, JSON.stringify(original, null, 2));
    const result = await f.run();
    assert.equal(result.ok, true);
    const saved = await f.readJson();
    assert.equal(saved.theme, "dark");
    assert.deepEqual(saved.mcpServers.other, { command: "/other/server" });
    assert.deepEqual(saved.mcpServers["spicy-studio"], { command: process.execPath, args: [f.entry] });
    const backups = (await readdir(join(f.path, ".."))).filter((name) => name.includes("spicy-studio-backup"));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(f.path, "..", backups[0]), "utf8")), original);
    assert.match(f.lines.join("\n"), /reset set to true/);
    assert.equal((await f.run()).ok, true);
    assert.equal((await readdir(join(f.path, ".."))).filter((name) => name.includes("spicy-studio-backup")).length, 1);
  });

  test(`${client}: a missing settings file is created; diagnose and dry-run never write`, async (t) => {
    const f = await fileFixture(t, client);
    for (const mode of ["diagnose", "dry-run"]) assert.equal((await f.run(mode)).config, "missing");
    await assert.rejects(readFile(f.path, "utf8"));
    assert.equal((await f.run()).ok, true);
    assert.equal(fileEntryStatus(await f.readJson(), { node: process.execPath, entry: f.entry }).kind, "matching");
  });

  test(`${client}: a different same-name entry needs confirmation, and removal only touches our entry`, async (t) => {
    const other = { command: "/other/node", args: ["/other/server.js"] };
    const f = await fileFixture(t, client, JSON.stringify({ mcpServers: { "spicy-studio": other, keep: other } }));
    f.answers.push(0);
    assert.equal((await f.run()).reason, "cancelled");
    assert.deepEqual((await f.readJson()).mcpServers["spicy-studio"], other);
    assert.equal((await f.run("remove")).reason, "not_owned");
    f.answers.push(1);
    assert.equal((await f.run()).ok, true);
    f.answers.push(1);
    assert.equal((await f.run("remove")).ok, true);
    assert.deepEqual((await f.readJson()).mcpServers, { keep: other });
  });

  test(`${client}: files with comments are never rewritten; the user gets the entry to paste`, async (t) => {
    const text = '{\n  // my settings\n  "mcpServers": {}\n}\n';
    const f = await fileFixture(t, client, text);
    assert.equal((await f.run()).reason, "unknown_config");
    assert.equal(await readFile(f.path, "utf8"), text);
    assert.ok(f.lines.join("\n").includes(connectionSnippet(process.execPath, f.entry)));
  });
}

test("settings reader refuses non-object JSON and treats an empty file as empty settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "studio settings "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "settings.json");
  assert.deepEqual(await readSettings(path), { exists: false, settings: {} });
  await writeFile(path, "");
  assert.deepEqual(await readSettings(path), { exists: true, settings: {} });
  await writeFile(path, "[]");
  assert.equal((await readSettings(path)).error, "not_object");
  await writeFile(path, '{"mcpServers": []}');
  assert.equal((await readSettings(path)).error, "not_object");
});

const backupsOf = async (path) =>
  (await readdir(join(path, ".."))).filter((name) => name.includes("spicy-studio-backup"));
const approvalLines = (text) => text.split("\n").filter((line) => line.startsWith(CODEX_APPROVAL_KEY));

test("codex: setup lets codex exec call the Studio tools for this entry only, keeps a backup, and is idempotent", async (t) => {
  const f = await fixture(t, "codex");
  const original = [
    "# personal settings",
    'approval_policy = "never"',
    "",
    "[mcp_servers.other]",
    'command = "/other/server"',
    'default_tools_approval_mode = "prompt"',
    "",
  ].join("\n");
  await writeFile(f.codexToml, original);
  // Read-only modes report the setting and never write it.
  assert.equal((await f.run("diagnose")).ok, false);
  assert.match(f.lines.join("\n"), /Codex tool approval for spicy-studio: not set/);
  assert.equal(await readFile(f.codexToml, "utf8"), original);

  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.approval, "approve");
  const text = await readFile(f.codexToml, "utf8");
  assert.ok(text.startsWith(original), "the global policy and the other server are unchanged");
  assert.deepEqual(codexApprovalStatus(text), { kind: "set", value: "approve" });
  assert.equal(text.split("[mcp_servers.spicy-studio]")[1].match(/default_tools_approval_mode/g).length, 1);
  assert.deepEqual(approvalLines(text), ['default_tools_approval_mode = "prompt"', 'default_tools_approval_mode = "approve"']);
  const backups = await backupsOf(f.codexToml);
  assert.equal(backups.length, 1);
  assert.equal(codexApprovalStatus(await readFile(join(f.codexToml, "..", backups[0]), "utf8")).kind, "missing");
  assert.match(f.lines.join("\n"), /global approval policy is unchanged/);

  // A second run adds nothing: no duplicate key, no new backup, no second mcp add.
  assert.equal((await f.run()).approval, "approve");
  assert.equal(await readFile(f.codexToml, "utf8"), text);
  assert.equal((await backupsOf(f.codexToml)).length, 1);
  assert.equal((await f.read()).calls.filter((args) => args[1] === "add").length, 1);
});

test("codex: an approval value the user already chose is kept and reported, also across a replacement", async (t) => {
  const f = await fixture(t, "codex");
  const own = [
    "[mcp_servers.spicy-studio]",
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(f.entry)}]`,
    'default_tools_approval_mode = "prompt"',
    "",
  ].join("\n");
  await f.patch({ config: { type: "stdio", command: process.execPath, args: [f.entry] } });
  await writeFile(f.codexToml, own);
  assert.equal((await f.run()).approval, "prompt");
  assert.equal(await readFile(f.codexToml, "utf8"), own);
  assert.equal((await backupsOf(f.codexToml)).length, 0);
  assert.match(f.lines.join("\n"), /default_tools_approval_mode = "prompt" for spicy-studio was kept/);

  // Replacing an older entry: codex mcp add drops the key, and the wizard puts the user's value back.
  await f.patch({ config: { type: "stdio", command: "/old/node", args: ["/old/server.js"] } });
  await writeFile(
    f.codexToml,
    '[mcp_servers.spicy-studio]\ncommand = "/old/node"\nargs = ["/old/server.js"]\ndefault_tools_approval_mode = "writes"\n',
  );
  f.answers.push(1);
  assert.equal((await f.run()).approval, "writes");
  const replaced = await readFile(f.codexToml, "utf8");
  assert.ok(replaced.includes(JSON.stringify(f.entry)));
  assert.deepEqual(approvalLines(replaced), ['default_tools_approval_mode = "writes"']);
});

test("codex: if Codex rejects the approval key, config.toml is restored and setup still succeeds", async (t) => {
  const f = await fixture(t, "codex", { rejectApproval: true });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.approval, "restored");
  const text = await readFile(f.codexToml, "utf8");
  assert.equal(codexApprovalStatus(text).kind, "missing");
  assert.ok(text.includes(JSON.stringify(f.entry)));
  assert.match(f.lines.join("\n"), /restored unchanged/);
  assert.match(f.lines.join("\n"), /default_tools_approval_mode = "approve"/);
});

test("codex: an unusual config.toml is never edited; the user gets the line to add", async (t) => {
  const f = await fixture(t, "codex");
  await f.patch({ config: { type: "stdio", command: process.execPath, args: [f.entry] } });
  const duplicated = "[mcp_servers.spicy-studio]\ncommand = \"/a\"\n\n[mcp_servers.spicy-studio]\ncommand = \"/b\"\n";
  await writeFile(f.codexToml, duplicated);
  assert.equal((await f.run()).approval, "manual");
  assert.equal(await readFile(f.codexToml, "utf8"), duplicated);
  assert.match(f.lines.join("\n"), /could not be edited safely/);
});

test("Codex approval edits touch only the spicy-studio table and respect TOML layout", () => {
  // Quoted table name, CRLF line endings, a sub-table and a multi-line string that looks like our header.
  const text = [
    'notes = """',
    "[mcp_servers.spicy-studio]",
    'default_tools_approval_mode = "never-read"',
    '"""',
    '[mcp_servers."spicy-studio"] # ours',
    'command = "/node"',
    "args = [",
    '  "/bridge/cli.js",',
    "]",
    "# comment for the next table",
    "[mcp_servers.spicy-studio.env]",
    'KEEP = "1"',
    "",
  ].join("\r\n");
  assert.deepEqual(codexApprovalStatus(text), { kind: "missing", insertAt: 9 });
  const updated = withCodexApproval(text);
  assert.equal(updated.split("\r\n")[9], 'default_tools_approval_mode = "approve"');
  assert.equal(updated.split("\r\n")[10], "# comment for the next table");
  assert.ok(!updated.replace(/\r\n/g, "").includes("\n"), "line endings stay CRLF");
  assert.deepEqual(codexApprovalStatus(updated), { kind: "set", value: "approve" });
  assert.equal(withCodexApproval(updated), null, "never adds a second key");
  assert.deepEqual(codexApprovalStatus("[mcp_servers.spicy-studio]\n\"default_tools_approval_mode\" = 'auto' # mine\n"), {
    kind: "set",
    value: "auto",
  });
  assert.deepEqual(codexApprovalStatus('[mcp_servers.other]\ncommand = "/x"\n'), { kind: "no-entry" });
  assert.deepEqual(codexApprovalStatus(""), { kind: "no-entry" });
  const twice = '[mcp_servers.spicy-studio]\ndefault_tools_approval_mode = "approve"\ndefault_tools_approval_mode = "prompt"\n';
  assert.deepEqual(codexApprovalStatus(twice), { kind: "unsupported" });
  assert.equal(withCodexApproval(twice), null);
  assert.equal(
    codexConfigSnippet("/opt/node", "/opt/bridge/cli.js"),
    '[mcp_servers.spicy-studio]\ncommand = "/opt/node"\nargs = ["/opt/bridge/cli.js"]\ndefault_tools_approval_mode = "approve"',
  );
  assert.deepEqual(codexApprovalStatus(codexConfigSnippet("/opt/node", "/opt/bridge/cli.js")), { kind: "set", value: "approve" });
  assert.equal(codexConfigPath({ env: {}, home: "/test-home" }), join("/test-home", ".codex", "config.toml"));
  assert.equal(codexConfigPath({ env: { CODEX_HOME: "/custom-codex" }, home: "/test-home" }), join("/custom-codex", "config.toml"));
});
