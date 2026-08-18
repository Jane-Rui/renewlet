import { readFileSync } from "node:fs";
import { join } from "node:path";

// 部署 YAML、运维脚本与恢复文档共同组成 D1 写库事务边界；本守卫防止单点修改破坏整体顺序。

function requireSnippet(content, snippet, context) {
  if (!content.includes(snippet)) throw new Error(`${context} must keep D1 deployment snippet: ${snippet}`);
}

function requireOrder(content, snippets, context) {
  let previous = -1;
  for (const snippet of snippets) {
    const index = content.indexOf(snippet);
    if (index < 0 || index <= previous) {
      throw new Error(`${context} must keep D1 deployment order: ${snippets.join(" -> ")}`);
    }
    previous = index;
  }
}

/** 固化 checkpoint -> migration/backfill -> deploy -> failure hint 的不可取消部署契约。 */
export function checkCloudflareD1DeployContract(repoRoot) {
  const selfHostedPath = ".github/workflows/cloudflare-worker.yml";
  const releasePath = ".github/workflows/release-publish.yml";
  const selfHosted = readFileSync(join(repoRoot, selfHostedPath), "utf8");
  const release = readFileSync(join(repoRoot, releasePath), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  for (const snippet of [
    "group: cloudflare-worker-${{ github.repository }}\n  cancel-in-progress: false",
    "id: d1-checkpoint\n        if: steps.deployment-secrets.outputs.ready == 'true'",
    "if: ${{ failure() && steps.deployment-secrets.outputs.ready == 'true' && steps.d1-checkpoint.outputs.bookmark != '' }}",
  ]) requireSnippet(selfHosted, snippet, selfHostedPath);
  for (const snippet of [
    "group: production-cloudflare-${{ github.repository }}\n      cancel-in-progress: false",
    "id: d1-checkpoint",
    "if: ${{ failure() && steps.d1-checkpoint.outputs.bookmark != '' }}",
  ]) requireSnippet(release, snippet, releasePath);

  const deploymentOrder = [
    "Capture D1 Time Travel checkpoint",
    "Apply D1 migrations",
    "Ensure Cloudflare Queues",
    "Deploy Worker",
    "Report manual D1 recovery command",
  ];
  requireOrder(selfHosted, deploymentOrder, selfHostedPath);
  requireOrder(release, deploymentOrder, releasePath);
  for (const workflow of [selfHosted, release]) {
    requireSnippet(
      workflow,
      "pnpm exec tsx scripts/cloudflare-d1-checkpoint.ts capture --config \"$CI_WRANGLER_CONFIG\"",
      "Cloudflare workflow",
    );
    requireSnippet(
      workflow,
      "pnpm exec tsx scripts/cloudflare-d1-checkpoint.ts recovery-hint --config \"$CI_WRANGLER_CONFIG\"",
      "Cloudflare workflow",
    );
    requireSnippet(workflow, "failure()", "Cloudflare workflow");
    if (workflow.includes("time-travel restore DB")) {
      throw new Error("Cloudflare workflows must never restore D1 automatically.");
    }
  }

  const expectedScriptTests = "node --test scripts/*.test.mjs && node --import tsx --test scripts/*.test.ts";
  if (packageJson.scripts?.["test:scripts"] !== expectedScriptTests) {
    throw new Error("package.json test:scripts must run both MJS and TypeScript operations tests.");
  }
  if (packageJson.scripts?.["check:deploy"] !== "node scripts/check-deploy-config.mjs && pnpm test:scripts") {
    throw new Error("package.json check:deploy must run all operations-script tests.");
  }
  if (!packageJson.scripts?.["test:unit"]?.startsWith("pnpm test:scripts && ")) {
    throw new Error("package.json test:unit must include operations-script tests.");
  }

  for (const relativePath of ["docs/cloudflare-workers-deploy.md", "docs/cloudflare-workers-deploy.zh-CN.md"]) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    if (/d1 time-travel (?:info|restore)[^\n]*--remote/.test(content)) {
      throw new Error(`${relativePath} must not pass unsupported --remote to D1 Time Travel commands.`);
    }
    requireSnippet(
      content,
      "d1 time-travel info DB --json --config wrangler.generated.jsonc",
      relativePath,
    );
    requireSnippet(
      content,
      "d1 time-travel restore DB --bookmark=\"<bookmark>\" --config wrangler.generated.jsonc",
      relativePath,
    );
  }
}
