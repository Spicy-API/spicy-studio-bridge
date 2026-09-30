import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const skipped = new Set([".git", "node_modules", "dist", "artifacts"]);
export function publicFiles(root) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      if (skipped.has(name)) continue;
      const path = join(directory, name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${relative(root, path)}`);
      if (info.isDirectory()) visit(path); else if (info.isFile()) files.push(path);
    }
  }
  visit(root);
  return files;
}

export function scanPublicText(text) {
  const issues = [];
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text)) issues.push("non-English source text");
  if (/\/(?:Users|home)\/[A-Za-z0-9_.-]+|[A-Za-z]:\\Users\\[A-Za-z0-9_.-]+/u.test(text)) issues.push("absolute personal home path");
  if (/[A-Z0-9._%+-]+@(?:gmail|qq|hotmail|outlook|icloud|yahoo)\.[A-Z]{2,}/iu.test(text)) issues.push("personal email address");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/u.test(text)) issues.push("credential material");
  return issues;
}

export function checkPublic(root) {
  const files = publicFiles(root);
  if (files.length < 15) throw new Error("Source inventory is unexpectedly small; refusing an empty scan.");
  const failures = [];
  for (const path of files) {
    const issues = scanPublicText(readFileSync(path, "utf8"));
    if (issues.length) failures.push(`${relative(root, path)}: ${issues.join(", ")}`);
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  console.log(`Public source checks passed for ${checkPublic(root)} files.`);
}
