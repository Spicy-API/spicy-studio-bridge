import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
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
  authStatus,
  cliCandidates,
  configStatus,
  connectionWizard,
  detectCli,
  parseOptions,
  runCommand,
} from "../delivery/lib/connect-core.mjs";

const fakeSource = `
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.STUDIO_TEST_STATE;
if(!file)throw new Error('Missing isolated test state');
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
  const value=state.config;
  if(!value)end('No MCP server found with name: spicy-studio',1);
  if(state.client==='codex')end(JSON.stringify({name:'spicy-studio',enabled:true,transport:value}));
  end('spicy-studio:\\n  Scope: '+(value.scope??'User')+' config (available in all projects)\\n  Status: Connected\\n  Type: '+value.type+'\\n  Command: '+value.command+'\\n  Args: '+value.args.join(' '));
 }
 if(args[1]==='remove'){state.config=null;end('Removed only spicy-studio')}
 if(args[1]==='add'){
  if(state.failAdd)end('Failed to write config',1);
  const index=args.indexOf('--');state.config={type:'stdio',command:args[index+1],args:args.slice(index+2)};
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
  await writeFile(entry, "console.log('0.2.1');\n");
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
  const env = { ...process.env, STUDIO_TEST_STATE: stateFile };
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
    detect: () => Promise.resolve(launcher),
    run: (target, args, opts) =>
      runCommand(target, args, { ...opts, interactive: false, timeoutMs: 15000 }),
  };
  return {
    root,
    entry,
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
  for (const args of [
    ["--client", "other"],
    ["--diagnose", "--remove"],
    ["--client", "claude", "--device-auth"],
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
