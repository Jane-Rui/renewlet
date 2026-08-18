import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Web workspace 拥有自身构建守卫，三个镜像 workflow 共用根 Dockerfile，runner 只接收运行产物。

const CLIENT_CHECK_SCRIPTS = [
  "scripts/check-client-csp.mjs",
  "scripts/check-client-bundle-budget.mjs",
];
const BUNDLE_BUDGET_VALUES = ["556075", "468559", "73240", "60088", "112455", "93798"];
const IMAGE_WORKFLOWS = [
  ".github/workflows/build-smoke.yml",
  ".github/workflows/security-scan.yml",
  ".github/workflows/release-publish.yml",
];

function readRepoFile(repoRoot, relativePath) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function dockerStage(dockerfile, stageName) {
  // 规则只审计目标 stage 到下一个 FROM，防止其他 builder 的 COPY/RUN 偶然满足或污染断言。
  const lines = dockerfile.split(/\r?\n/);
  const stagePattern = new RegExp(
    `^FROM(?:\\s+--platform=\\S+)?\\s+\\S+\\s+AS\\s+${stageName}\\s*$`,
    "i",
  );
  const start = lines.findIndex((line) => stagePattern.test(line.trim()));
  if (start < 0) {
    throw new Error(`Dockerfile must define the ${stageName} stage.`);
  }
  const next = lines.findIndex((line, index) => index > start && /^FROM\s+/i.test(line.trim()));
  return lines.slice(start, next < 0 ? lines.length : next).join("\n");
}

function assertOrdered(content, snippets, context) {
  let cursor = -1;
  for (const snippet of snippets) {
    const index = content.indexOf(snippet, cursor + 1);
    if (index < 0) {
      throw new Error(`${context} must contain: ${snippet}`);
    }
    cursor = index;
  }
}

function checkClientBuildScripts(repoRoot, buildCommand) {
  const webRoot = resolve(repoRoot, "apps/web");
  const scriptPaths = [...buildCommand.matchAll(/(?:^|&&)\s*node\s+(?:"([^"]+)"|'([^']+)'|([^\s&]+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);

  for (const requiredScript of CLIENT_CHECK_SCRIPTS) {
    if (!scriptPaths.includes(requiredScript)) {
      throw new Error(`Client build must run ${requiredScript}.`);
    }
  }

  // Docker 复制的是 workspace 所有权边界；build 可扩展新守卫，但不能再次依赖容器外的根脚本清单。
  for (const scriptPath of scriptPaths) {
    const absolutePath = resolve(webRoot, scriptPath);
    const workspaceRelativePath = relative(webRoot, absolutePath);
    if (
      isAbsolute(scriptPath) ||
      workspaceRelativePath === ".." ||
      workspaceRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(workspaceRelativePath)
    ) {
      throw new Error(`Client build script must stay inside apps/web: ${scriptPath}`);
    }
    if (!existsSync(absolutePath)) {
      throw new Error(`Client build script does not exist: apps/web/${scriptPath}`);
    }
  }
}

function checkImageWorkflow(repoRoot, relativePath) {
  const workflow = readRepoFile(repoRoot, relativePath);
  const lines = workflow.split(/\r?\n/);
  // 必须逐个限定 action step；全文件碰巧出现一次根 Dockerfile 不能替另一个分叉构建提供保证。
  const actionIndexes = lines.flatMap((line, index) =>
    /uses:\s*docker\/build-push-action@\S+/.test(line) ? [index] : [],
  );
  if (actionIndexes.length === 0) {
    throw new Error(`${relativePath} must keep a docker/build-push-action step.`);
  }

  for (const actionIndex of actionIndexes) {
    const actionLine = lines[actionIndex];
    const actionIndent = /^\s*/.exec(actionLine)?.[0].length ?? 0;
    const stepIndent = /^\s*-\s+uses:/.test(actionLine) ? actionIndent : Math.max(0, actionIndent - 2);
    let stepEnd = lines.length;
    for (let index = actionIndex + 1; index < lines.length; index += 1) {
      const nextStep = /^(\s*)-\s+/.exec(lines[index]);
      if (nextStep && nextStep[1].length <= stepIndent) {
        stepEnd = index;
        break;
      }
    }
    const step = lines.slice(actionIndex, stepEnd).join("\n");
    if (!/^\s*context:\s*\.\s*$/m.test(step) || !/^\s*file:\s*\.\/Dockerfile\s*$/m.test(step)) {
      throw new Error(`${relativePath} must build the shared root Dockerfile.`);
    }
  }
}

function checkWorkflowRuntimeSmoke(repoRoot) {
  // 构建成功不足以证明 runner 可用；workflow 还必须加载同一镜像并执行容器内真实 healthcheck。
  const buildSmoke = readRepoFile(repoRoot, ".github/workflows/build-smoke.yml");
  for (const snippet of [
    "load: true",
    "docker run --detach renewlet:smoke",
    'docker exec "$container_id" /renewlet healthcheck',
    "trap cleanup EXIT",
  ]) {
    if (!buildSmoke.includes(snippet)) {
      throw new Error(`Build Smoke must keep the loaded-image runtime probe: ${snippet}`);
    }
  }

  const securityScan = readRepoFile(repoRoot, ".github/workflows/security-scan.yml");
  const imageScanIndex = securityScan.indexOf("  image-scan:");
  if (imageScanIndex < 0) {
    throw new Error("Security Scan must keep the image-scan job.");
  }
  const imageScan = securityScan.slice(imageScanIndex);
  for (const redundantStep of ["Set up Node.js", "Enable Corepack", "Install dependencies"]) {
    if (imageScan.includes(redundantStep)) {
      throw new Error(`Security Scan image-scan must not repeat host dependency setup: ${redundantStep}`);
    }
  }
}

/** 同时校验 builder 输入所有权、最终镜像隔离、运行态 smoke 与前端资源预算门禁。 */
export function checkDockerBuildContract(repoRoot) {
  const dockerfile = readRepoFile(repoRoot, "Dockerfile");
  const clientPackage = JSON.parse(readRepoFile(repoRoot, "apps/web/package.json"));
  const clientBuild = clientPackage.scripts?.build;
  if (typeof clientBuild !== "string") {
    throw new Error("apps/web package must define a build script.");
  }

  if (!dockerfile.startsWith("# syntax=docker/dockerfile:1.8\n# check=error=true\n")) {
    throw new Error("Dockerfile must pin syntax 1.8 and fail all stable build checks.");
  }
  checkClientBuildScripts(repoRoot, clientBuild);

  const clientBuilder = dockerStage(dockerfile, "client-builder");
  assertOrdered(
    clientBuilder,
    [
      "COPY apps/web apps/web",
      "COPY packages/shared packages/shared",
      "RUN pnpm --filter @renewlet/client build",
    ],
    "Docker client-builder",
  );
  if (/^\s*(?:COPY|ADD)\s+.*\bscripts\//m.test(clientBuilder)) {
    throw new Error("Docker client-builder must receive Web build guards through the apps/web ownership boundary.");
  }

  const runner = dockerStage(dockerfile, "runner");
  if (!/^FROM\s+alpine:\S+\s+AS\s+runner\s*$/im.test(runner)) {
    throw new Error("Docker runner must remain an Alpine runtime-only stage.");
  }
  const runnerCopies = runner
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:COPY|ADD)\s+/i.test(line));
  // 多阶段构建只允许编译产物跨入 runner，源码或 Node 工具泄漏会同时放大镜像和供应链边界。
  for (const line of runnerCopies) {
    if (/client-builder|node_modules|apps\/web|packages\/shared|scripts\//.test(line)) {
      throw new Error(`Docker runner must not receive build-time files: ${line.trim()}`);
    }
  }

  for (const workflow of IMAGE_WORKFLOWS) {
    checkImageWorkflow(repoRoot, workflow);
  }
  checkWorkflowRuntimeSmoke(repoRoot);

  const ci = readRepoFile(repoRoot, ".github/workflows/ci.yml");
  for (const snippet of ["run: pnpm build:all", "run: pnpm check:route-parity", "run: pnpm test:perf"]) {
    if (!ci.includes(snippet)) {
      throw new Error(`CI must keep resource/contract gate: ${snippet}`);
    }
  }

  const viteConfig = readRepoFile(repoRoot, "apps/web/vite.config.ts");
  if (!viteConfig.includes("manifest: true")) {
    throw new Error("Vite build must emit a manifest for deterministic bundle accounting.");
  }
  const budgetScript = readRepoFile(repoRoot, "apps/web/scripts/check-client-bundle-budget.mjs");
  for (const value of BUNDLE_BUDGET_VALUES) {
    if (!budgetScript.includes(value)) {
      throw new Error(`Client bundle budget must keep baseline byte value: ${value}`);
    }
  }
}
