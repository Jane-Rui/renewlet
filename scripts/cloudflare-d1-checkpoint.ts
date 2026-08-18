#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本脚本只捕获可审计 checkpoint 并输出人工恢复提示；Time Travel restore 永远不由 CI 自动执行。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type CheckpointMode = "capture" | "recovery-hint";

interface CheckpointOptions {
  mode: CheckpointMode;
  configPath?: string;
}

/** Wrangler 子进程的窄结果形状，避免 shell 输出未经检查地进入 GitHub Actions 状态。 */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 注入 runner 只用于在测试中覆盖失败与恶意输出，不扩展生产命令能力。 */
export type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: readonly string[]): CheckpointOptions {
  const mode = argv.at(0);
  if (mode !== "capture" && mode !== "recovery-hint") {
    throw new Error("Usage: cloudflare-d1-checkpoint.ts (capture | recovery-hint) [--config <path>]");
  }
  let configPath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--config") throw new Error(`Unknown argument: ${argument}`);
    if (configPath !== undefined) throw new Error("--config may only be specified once");
    const value = argv[index + 1];
    if (!value) throw new Error("--config requires a path");
    configPath = value;
    index += 1;
  }
  return configPath === undefined ? { mode } : { mode, configPath };
}

/** 限制 bookmark 为单行可打印 token，防止写入 step output 或恢复命令时发生命令注入。 */
export function validateBookmark(value: unknown): string {
  if (typeof value !== "string") throw new Error("Wrangler Time Travel JSON is missing bookmark");
  const bookmark = value.trim();
  if (bookmark.length === 0 || bookmark !== value || bookmark.length > 512 || /[\u0000-\u0020\u007f`]/.test(bookmark)) {
    throw new Error("Wrangler Time Travel JSON contains an invalid bookmark");
  }
  return bookmark;
}

/** Wrangler JSON 必须只有 bookmark 字段；额外字段被视为 CLI 契约漂移。 */
export function parseBookmarkJson(stdout: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("Wrangler Time Travel returned invalid JSON");
  }
  if (!isRecord(payload)) {
    throw new Error("Wrangler Time Travel returned an invalid JSON object");
  }
  if (!("bookmark" in payload)) throw new Error("Wrangler Time Travel JSON is missing bookmark");
  if (Object.keys(payload).length !== 1) {
    throw new Error("Wrangler Time Travel returned an invalid JSON object");
  }
  return validateBookmark(payload["bookmark"]);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 生成供维护者复核后手工执行的 restore 命令，本函数不触碰远端 D1。 */
export function restoreCommand(bookmark: string, configPath?: string): string {
  const args = [
    "pnpm exec wrangler d1 time-travel restore DB",
    `--bookmark=${shellQuote(validateBookmark(bookmark))}`,
  ];
  if (configPath !== undefined) args.push(`--config ${shellQuote(configPath)}`);
  return args.join(" ");
}

function checkpointSummary(bookmark: string, configPath?: string): string {
  return [
    "### D1 Time Travel checkpoint",
    "",
    `Bookmark: \`${bookmark}\``,
    "",
    "A restore is destructive. Run it only after reviewing writes made after this checkpoint:",
    "",
    `\`${restoreCommand(bookmark, configPath)}\``,
    "",
  ].join("\n");
}

function recoverySummary(bookmark: string, configPath?: string): string {
  return [
    "### D1 deployment recovery review required",
    "",
    "A step after the D1 checkpoint failed. The database is not restored automatically because restore overwrites in-place writes.",
    "",
    `Checkpoint: \`${bookmark}\``,
    "",
    `Manual restore command: \`${restoreCommand(bookmark, configPath)}\``,
    "",
  ].join("\n");
}

/** 将同一个已校验 bookmark 写入 step output 与 job summary，供失败步骤引用和人工审计。 */
export function writeCheckpointEvidence(
  bookmark: string,
  githubOutputPath: string,
  githubSummaryPath: string,
  configPath?: string,
): void {
  const checked = validateBookmark(bookmark);
  appendFileSync(githubOutputPath, `bookmark=${checked}\n`, "utf8");
  appendFileSync(githubSummaryPath, checkpointSummary(checked, configPath), "utf8");
}

/** 失败路径只追加人工恢复证据，不自动覆盖 checkpoint 之后可能产生的有效写入。 */
export function writeRecoveryHint(
  bookmark: string,
  githubSummaryPath: string,
  configPath?: string,
): void {
  const checked = validateBookmark(bookmark);
  appendFileSync(githubSummaryPath, recoverySummary(checked, configPath), "utf8");
}

async function runPnpm(args: readonly string[]): Promise<CommandResult> {
  // 参数数组直传 spawn，bookmark/config 不经过 shell；stdout 与 stderr 分离后只有 stdout 进入严格 JSON 解析。
  return new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", [...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => reject(new Error("Unable to start Wrangler Time Travel checkpoint")));
    child.on("close", (status: number | null) => resolvePromise({ status, stdout, stderr }));
  });
}

/** 调用 Wrangler 获取 migration 前 bookmark，并在 unknown JSON 边界完成严格解析。 */
export async function captureBookmark(
  configPath: string | undefined,
  runner: CommandRunner = runPnpm,
): Promise<string> {
  const args = ["exec", "wrangler", "d1", "time-travel", "info", "DB", "--json"];
  if (configPath !== undefined) args.push("--config", configPath);
  const result = await runner(args);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(detail.length > 0
      ? `Wrangler Time Travel checkpoint failed: ${detail}`
      : "Wrangler Time Travel checkpoint failed");
  }
  return parseBookmarkJson(result.stdout);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const githubSummaryPath = requiredEnvironment("GITHUB_STEP_SUMMARY");
  if (options.mode === "capture") {
    const bookmark = await captureBookmark(options.configPath);
    writeCheckpointEvidence(
      bookmark,
      requiredEnvironment("GITHUB_OUTPUT"),
      githubSummaryPath,
      options.configPath,
    );
    console.log("Cloudflare D1 Time Travel checkpoint captured.");
    return;
  }

  const bookmark = requiredEnvironment("D1_TIME_TRAVEL_BOOKMARK");
  writeRecoveryHint(bookmark, githubSummaryPath, options.configPath);
  console.error("::error title=Cloudflare D1 deployment failed::Review the manual Time Travel restore command in the job summary.");
}

const entryPath = process.argv[1];
// 测试直接导入解析与证据 helper；只有作为 CLI 入口执行时才读取 Actions 环境变量或启动 Wrangler。
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
