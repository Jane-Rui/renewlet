import { readFileSync } from "node:fs";
import { join } from "node:path";

function workflowTriggerBlock(content, trigger) {
  const match = new RegExp(`^  ${trigger}:\\n(?<body>(?:    .*(?:\\n|$))*)`, "m").exec(content);
  return match?.groups?.body ?? "";
}

export function checkWorkflowContracts(repoRoot) {
  const workflows = [
    { path: ".github/workflows/ci.yml", name: "CI" },
    { path: ".github/workflows/build-smoke.yml", name: "Build Smoke" },
    { path: ".github/workflows/playwright-e2e.yml", name: "Playwright E2E" },
  ];

  // main/release push 不跑分支质量门；合并前看 PR，发布看 tag，避免稳定版合入后和 Release Publish 重复。
  for (const workflow of workflows) {
    const content = readFileSync(join(repoRoot, workflow.path), "utf8");
    const pullRequestBlock = workflowTriggerBlock(content, "pull_request");
    const pushBlock = workflowTriggerBlock(content, "push");

    for (const snippet of ["      - dev", "      - main", '      - "release/**"']) {
      if (!pullRequestBlock.includes(snippet)) {
        throw new Error(`${workflow.name} pull_request trigger must keep branch snippet: ${snippet.trim()}`);
      }
    }
    if (!pushBlock.includes("      - dev")) {
      throw new Error(`${workflow.name} push trigger must keep branch snippet: dev`);
    }
    for (const blockedBranch of ["      - main", "release/"]) {
      if (pushBlock.includes(blockedBranch)) {
        throw new Error(`${workflow.name} push trigger must not include ${blockedBranch.trim()}; release checks run on PR and tag workflows.`);
      }
    }
  }

  const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release-publish.yml"), "utf8");
  for (const snippet of [
    "Validate stable tag source",
    "github.repository == 'zhiyingzzhou/renewlet' && steps.version.outputs.is-stable == 'true'",
    "git fetch origin main:refs/remotes/origin/main",
    "git merge-base --is-ancestor \"$TAG_SHA\" \"$MAIN_SHA\"",
  ]) {
    if (!releaseWorkflow.includes(snippet)) {
      throw new Error(`release-publish.yml must keep stable tag source guard: ${snippet}`);
    }
  }

  if (!readFileSync(join(repoRoot, ".github/workflows/build-smoke.yml"), "utf8").includes("workflow_dispatch:")) {
    throw new Error("Build Smoke must keep workflow_dispatch for manual no-secret build verification.");
  }

  const playwrightWorkflow = readFileSync(join(repoRoot, ".github/workflows/playwright-e2e.yml"), "utf8");
  for (const trigger of ["  schedule:", "  workflow_dispatch:"]) {
    if (!playwrightWorkflow.includes(trigger)) {
      throw new Error(`Playwright E2E must keep ${trigger.trim()} for main monitoring and manual verification.`);
    }
  }

  // 不可变发布制品与可变 Docker Hub 页面元数据必须隔离，避免 Overview 故障跳过 GitHub Release。
  for (const blockedSnippet of [
    "scripts/dockerhub-overview.mjs",
    "peter-evans/dockerhub-description",
    "Update Docker Hub overview",
  ]) {
    if (releaseWorkflow.includes(blockedSnippet)) {
      throw new Error(`release-publish.yml must not contain Docker Hub Overview integration: ${blockedSnippet}`);
    }
  }

  const overviewWorkflow = readFileSync(join(repoRoot, ".github/workflows/dockerhub-overview.yml"), "utf8");
  const overviewPushBlock = workflowTriggerBlock(overviewWorkflow, "push");
  for (const snippet of [
    "      - main",
    "      - README.md",
    "      - scripts/dockerhub-overview.mjs",
    "      - .github/workflows/dockerhub-overview.yml",
  ]) {
    if (!overviewPushBlock.includes(snippet)) {
      throw new Error(`Docker Hub Overview push trigger must keep snippet: ${snippet.trim()}`);
    }
  }
  for (const snippet of [
    "  workflow_dispatch:",
    "  group: dockerhub-overview",
    "  cancel-in-progress: false",
  ]) {
    if (!overviewWorkflow.includes(snippet)) {
      throw new Error(`Docker Hub Overview workflow must keep snippet: ${snippet.trim()}`);
    }
  }

  const expectedDescriptionActionSha = "1b9a80c056b620d92cedb9d9b5a223409c68ddfa";
  const descriptionActionRefs = [
    ...overviewWorkflow.matchAll(/uses:\s*peter-evans\/dockerhub-description@(?<ref>\S+)/g),
  ];
  if (
    descriptionActionRefs.length !== 1 ||
    descriptionActionRefs[0].groups?.ref !== expectedDescriptionActionSha
  ) {
    throw new Error("Docker Hub Overview workflow must pin peter-evans/dockerhub-description v5 to its full commit SHA.");
  }
}
