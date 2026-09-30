import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm || !existsSync(npm))
  throw new Error("Run this script through npm run bundle.");
const artifactRoot = join(root, "artifacts");
mkdirSync(artifactRoot, { recursive: true });
const run = (args, cwd = root) =>
  execFileSync(process.execPath, [npm, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
const packed = JSON.parse(
  run([
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    artifactRoot,
    "--json",
  ]),
)[0];
const target = join(artifactRoot, `SpicyAPI-Studio-Bridge-${packed.version}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(root, "delivery"), target, { recursive: true });
for (const name of ["connect.mjs", "Connect-macOS.command", "Connect-Linux.sh"])
  chmodSync(join(target, name), 0o755);
for (const name of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "TESTING.md"])
  cpSync(join(root, name), join(target, name));
cpSync(join(artifactRoot, packed.filename), join(target, packed.filename));
const runtime = join(target, "runtime");
// A local tarball can change without a version bump; discard only our generated install and lock.
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
writeFileSync(
  join(runtime, "package.json"),
  JSON.stringify(
    {
      name: "spicyapi-studio-bridge-local-runtime",
      private: true,
      type: "module",
      dependencies: { "@spicyapi/studio-bridge": `file:../${packed.filename}` },
    },
    null,
    2,
  ) + "\n",
);
run(["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], runtime);
// Dependencies are runtime-only. Remove maps and upstream source tests, retaining licenses and exports.
rmSync(join(runtime, "node_modules/.bin"), { recursive: true, force: true });
function prune(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name), info = lstatSync(path);
    const local = relative(runtime, path).replaceAll("\\", "/");
    if (name.endsWith(".map") || (name === "tests" && local.startsWith("node_modules/zod/src/"))) {
      rmSync(path, { recursive: true, force: true });
    } else if (info.isDirectory()) prune(path);
    else if (info.isSymbolicLink()) throw new Error("Unexpected runtime symlink.");
  }
}
prune(runtime);
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name);
    return lstatSync(path).isDirectory() ? files(path) : [path];
  });
}
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(join(target, "SHA256SUMS"), files(target)
  .filter(path => path !== join(target, "SHA256SUMS"))
  .map(path => `${hash(path)}  ${relative(target, path).replaceAll("\\", "/")}`).join("\n") + "\n");
execFileSync(process.execPath, [join(root, "scripts/check-bundle.mjs"), target], { stdio: "inherit" });
const zip = join(artifactRoot, `SpicyAPI-Studio-Bridge-${packed.version}.zip`);
execFileSync("python3", [join(root, "scripts/create-zip.py"), target, zip], { stdio: "inherit" });
writeFileSync(join(artifactRoot, "SHA256SUMS"), [zip, join(artifactRoot, packed.filename)]
  .map(path => `${hash(path)}  ${relative(artifactRoot, path)}`).join("\n") + "\n");
// This command prepares files only. It never publishes to GitHub or npm.
console.log(`Prepared ${dirname(target).split("/").at(-1)}/${target.split("/").at(-1)}`);
