import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts/apply-cloudflare-d1-migrations.mjs");

function writeFakePnpm(binDir) {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "pnpm");
  writeFileSync(path, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const statePath = process.env.FAKE_WRANGLER_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.calls ??= [];
const args = process.argv.slice(2);
state.calls.push(args);
const expectedPrefix = ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--remote"];
if (expectedPrefix.some((value, index) => args[index] !== value)) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.error("unexpected pnpm invocation: " + args.join(" "));
  process.exit(99);
}
const response = state.responses.shift();
writeFileSync(statePath, JSON.stringify(state, null, 2));
if (!response) {
  console.error("missing fake migration response");
  process.exit(98);
}
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.status);
`);
  chmodSync(path, 0o755);
}

function runApply(responses, { args = [], maxAttempts = 5 } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-d1-migrations-"));
  const statePath = join(tempDir, "state.json");
  const binDir = join(tempDir, "bin");
  try {
    writeFakePnpm(binDir);
    writeFileSync(statePath, JSON.stringify({ responses, calls: [] }, null, 2));
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "super-secret-token",
        FAKE_WRANGLER_STATE: statePath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RENEWLET_D1_MIGRATION_MAX_ATTEMPTS: String(maxAttempts),
        RENEWLET_D1_MIGRATION_RETRY_BASE_MS: "0",
        RENEWLET_D1_MIGRATION_RETRY_MAX_MS: "0",
      },
    });
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return { result, state };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("passes --config to wrangler and succeeds on the first attempt", () => {
  const { result, state } = runApply([
    { status: 0, stdout: "No migrations to apply.\n" },
  ], { args: ["--config", "wrangler.generated.jsonc"] });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.calls, [
    ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.generated.jsonc"],
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /super-secret-token/);
});

test("retries Cloudflare D1 timeout code 7429 and then succeeds", () => {
  const { result, state } = runApply([
    { status: 1, stderr: "D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]\n" },
    { status: 0, stdout: "Applied 1 migration.\n" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.calls.length, 2);
  assert.match(result.stderr, /retrying in 0ms \(attempt 2\/5\)/);
});

test("retries documented transient D1 reset errors", () => {
  const { result, state } = runApply([
    { status: 1, stderr: "Network connection lost while querying D1\n" },
    { status: 1, stderr: "storage caused object to be reset\n" },
    { status: 1, stderr: "A request to the Cloudflare API failed. HTTP 500\n" },
    { status: 0, stdout: "Applied migrations.\n" },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.calls.length, 4);
});

test("does not retry authentication, permission, or SQL errors", () => {
  for (const [name, stderr] of [
    ["authentication", "A request to the Cloudflare API failed. Authentication error [code: 10000]\nHTTP 403\n"],
    ["permission", "A request to the Cloudflare API failed. You do not have permission to edit this database.\nHTTP 403\n"],
    ["sql", "near \"CREATEE\": syntax error at offset 0\n"],
  ]) {
    const { result, state } = runApply([{ status: 1, stderr }]);

    assert.notEqual(result.status, 0, name);
    assert.equal(state.calls.length, 1, name);
    assert.match(result.stderr, /non-retryable error/, name);
  }
});

test("fails after retryable errors exceed the configured attempt limit", () => {
  const { result, state } = runApply([
    { status: 1, stderr: "D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]\n" },
    { status: 1, stderr: "Network connection lost\n" },
    { status: 1, stderr: "storage caused object to be reset\n" },
  ], { maxAttempts: 3 });

  assert.notEqual(result.status, 0);
  assert.equal(state.calls.length, 3);
  assert.match(result.stderr, /failed after 3 attempts/);
  assert.match(result.stderr, /storage caused object to be reset/);
});
