import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublic, scanPublicText } from "../scripts/check-public.mjs";

test("public guard rejects identifying data and non-English source, not an empty scan", () => {
  assert.ok(scanPublicText(String.fromCodePoint(0x4e2d)).includes("non-English source text"));
  assert.ok(scanPublicText(["", "Users", "fixture-person", "code"].join("/")).includes("absolute personal home path"));
  assert.ok(scanPublicText(["fixture", "qq.com"].join("@")).includes("personal email address"));
  assert.ok(scanPublicText("ghp_" + "a".repeat(30)).includes("credential material"));
  assert.deepEqual(scanPublicText("SpicyAPI <spicyapi-owner@users.noreply.github.com>"), []);
  const root = mkdtempSync(join(tmpdir(), "studio-public-check-"));
  try {
    assert.throws(() => checkPublic(root), /unexpectedly small/);
    for (let i = 0; i < 15; i++) writeFileSync(join(root, `${i}.txt`), "Public English text.");
    assert.equal(checkPublic(root), 15);
    writeFileSync(join(root, "bad.txt"), String.fromCodePoint(0x4e2d));
    assert.throws(() => checkPublic(root), /bad.txt/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
