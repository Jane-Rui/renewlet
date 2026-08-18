import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkCloudflareD1DeployContract } from "./check-cloudflare-d1-deploy-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractFiles = [
  ".github/workflows/cloudflare-worker.yml",
  ".github/workflows/release-publish.yml",
  "package.json",
  "docs/cloudflare-workers-deploy.md",
  "docs/cloudflare-workers-deploy.zh-CN.md",
];

function withContractFixture(
  transform,
  run,
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "renewlet-d1-deploy-contract-"));
  try {
    for (const relativePath of contractFiles) {
      const destination = join(fixtureRoot, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      writeFileSync(destination, transform(relativePath, source), "utf8");
    }
    run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function swapStepNames(content, first, second) {
  const placeholder = "__RENEWLET_D1_DEPLOY_STEP_PLACEHOLDER__";
  return content.replace(first, placeholder).replace(second, first).replace(placeholder, second);
}

test("the repository keeps the complete D1 deployment contract", () => {
  assert.doesNotThrow(() => checkCloudflareD1DeployContract(repoRoot));
});

test("rejects cancellable deployment sequences and checkpoints after migration", () => {
  withContractFixture(
    (relativePath, source) => relativePath === ".github/workflows/cloudflare-worker.yml"
      ? source.replace("cancel-in-progress: false", "cancel-in-progress: true")
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /cancel-in-progress: false/,
    ),
  );

  withContractFixture(
    (relativePath, source) => relativePath === ".github/workflows/release-publish.yml"
      ? swapStepNames(source, "Capture D1 Time Travel checkpoint", "Apply D1 migrations")
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /deployment order/,
    ),
  );
});

test("rejects missing failure recovery evidence and illegal Time Travel flags", () => {
  withContractFixture(
    (relativePath, source) => relativePath === ".github/workflows/release-publish.yml"
      ? source.replace("recovery-hint --config", "missing-recovery-hint --config")
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /recovery-hint/,
    ),
  );

  withContractFixture(
    (relativePath, source) => relativePath === "docs/cloudflare-workers-deploy.md"
      ? source.replace("time-travel info DB --json", "time-travel info DB --remote --json")
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /unsupported --remote/,
    ),
  );
});
