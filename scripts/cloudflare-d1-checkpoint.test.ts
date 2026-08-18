import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureBookmark,
  parseBookmarkJson,
  restoreCommand,
  validateBookmark,
  writeCheckpointEvidence,
  writeRecoveryHint,
  type CommandRunner,
} from "./cloudflare-d1-checkpoint";

const bookmark = "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683";

test("strictly parses Wrangler bookmark JSON", () => {
  assert.equal(parseBookmarkJson(JSON.stringify({ bookmark })), bookmark);
  assert.throws(() => parseBookmarkJson("not-json"), /invalid JSON/);
  assert.throws(() => parseBookmarkJson("[]"), /invalid JSON object/);
  assert.throws(() => parseBookmarkJson(JSON.stringify({ bookmark, unexpected: true })), /invalid JSON object/);
  assert.throws(() => parseBookmarkJson(JSON.stringify({ bookmark: "" })), /invalid bookmark/);
  assert.throws(() => validateBookmark(`${bookmark}\nunsafe`), /invalid bookmark/);
});

test("captures the current remote bookmark without an invalid remote flag", async () => {
  let observedArgs: readonly string[] = [];
  const runner: CommandRunner = async (args) => {
    observedArgs = args;
    return { status: 0, stdout: JSON.stringify({ bookmark }), stderr: "" };
  };
  assert.equal(await captureBookmark("wrangler.generated.jsonc", runner), bookmark);
  assert.deepEqual(observedArgs, [
    "exec",
    "wrangler",
    "d1",
    "time-travel",
    "info",
    "DB",
    "--json",
    "--config",
    "wrangler.generated.jsonc",
  ]);
  assert.ok(!observedArgs.includes("--remote"));
});

test("rejects failed and malformed Wrangler checkpoint commands", async () => {
  await assert.rejects(
    captureBookmark(undefined, async () => ({ status: 1, stdout: "", stderr: "permission denied" })),
    /permission denied/,
  );
  await assert.rejects(
    captureBookmark(undefined, async () => ({ status: 0, stdout: "{}", stderr: "" })),
    /missing bookmark/,
  );
});

test("writes checkpoint output and manual-only recovery evidence", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-d1-checkpoint-"));
  const outputPath = join(tempDir, "output.txt");
  const summaryPath = join(tempDir, "summary.md");
  try {
    writeCheckpointEvidence(bookmark, outputPath, summaryPath, "wrangler.generated.jsonc");
    writeRecoveryHint(bookmark, summaryPath, "wrangler.generated.jsonc");
    assert.equal(readFileSync(outputPath, "utf8"), `bookmark=${bookmark}\n`);
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(summary, /D1 Time Travel checkpoint/);
    assert.match(summary, /D1 deployment recovery review required/);
    assert.match(summary, /not restored automatically/);
    assert.match(summary, /time-travel restore DB/);
    assert.doesNotMatch(summary, /--remote/);
    assert.match(restoreCommand(bookmark, "wrangler.generated.jsonc"), /--config 'wrangler\.generated\.jsonc'/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
