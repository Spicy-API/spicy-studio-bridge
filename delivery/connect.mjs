#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { createInterface } from "node:readline/promises";
import { connectionWizard, parseOptions } from "./lib/connect-core.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    "Install Node.js 22.13 or newer from https://nodejs.org/en/download, then reopen this launcher. Nothing was configured.",
  );
  process.exitCode = 1;
} else {
  let terminal;
  const controller = new globalThis.AbortController();
  const cancel = () => {
    controller.abort();
    terminal?.close();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.mode === "help") {
      console.log(
        [
          "Studio connection wizard",
          "",
          "node connect.mjs [--client codex|claude|cursor|gemini] [--diagnose|--dry-run|--remove]",
          "Add --device-auth for Codex's official device-code login fallback.",
          "",
          "Codex and Claude Code: check the official client and login, configure only spicy-studio through its official",
          "CLI after confirmation where needed, then verify it.",
          "Cursor and Gemini CLI: add only the spicy-studio entry to ~/.cursor/mcp.json or ~/.gemini/settings.json,",
          "keep a backup of the previous file, then verify it.",
          "No API key, credentials file, or model request is used.",
          "--diagnose and --dry-run never log in, add, or remove configuration.",
          "--remove removes only this bridge's connection and never logs out your account.",
          "For any other app that runs local MCP servers, use: node configure.mjs --client generic",
        ].join("\n"),
      );
    } else {
      const bundled = fileURLToPath(
        new URL("./runtime/node_modules/@spicyapi/studio-bridge/dist/src/cli.js", import.meta.url),
      );
      const installed = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
      const entry = existsSync(bundled) ? bundled : installed;
      if (!existsSync(entry))
        throw new Error(
          "The bridge runtime is missing. Restore the complete delivery folder, then reopen the launcher.",
        );
      const io = {
        say: (value) => console.log(value),
        async choose(question, choices) {
          if (!process.stdin.isTTY || !process.stdout.isTTY)
            throw new Error(
              "Open this launcher in an interactive terminal. For read-only checks use --client <codex|claude|cursor|gemini> --diagnose.",
            );
          if (!terminal) {
            terminal = createInterface({ input: process.stdin, output: process.stdout });
            terminal.on("SIGINT", cancel);
          }
          console.log(`\n${question}`);
          choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice}`));
          while (!controller.signal.aborted) {
            const answer = await terminal.question("Choose a number: ", {
              signal: controller.signal,
            });
            const index = Number(answer.trim()) - 1;
            if (Number.isInteger(index) && index >= 0 && index < choices.length) return index;
            console.log("Enter one of the numbers above, or press Ctrl-C to cancel.");
          }
          throw new Error("cancelled");
        },
        // Release stdin completely while the official login owns its terminal prompts.
        pause: () => {
          terminal?.close();
          terminal = undefined;
          process.stdin.pause();
        },
        resume: () => {},
      };
      const result = await connectionWizard(options, { entry, io, signal: controller.signal });
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    console.error(
      controller.signal.aborted
        ? "Cancelled. Termination was requested for the active official command and its child processes. Close any remaining login window. Reopen this wizard to check any setup step that had already finished. Your account was not logged out."
        : error instanceof Error
          ? error.message
          : "Setup could not finish. Reopen the wizard and retry.",
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    terminal?.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
