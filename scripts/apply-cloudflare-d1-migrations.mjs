#!/usr/bin/env node
/**
 * Cloudflare D1 remote migration runner.
 *
 * 触发时机：`pnpm deploy`、自管 Cloudflare workflow 和稳定版生产部署。
 * 前置依赖：Wrangler 已登录或 CI 已注入 Cloudflare API token/account。
 * 副作用：对远端 D1 应用尚未执行的 migration；非重试错误必须继续阻断部署。
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const retryablePatterns = [
  /\[code:\s*7429\]/i,
  /D1 DB storage operation exceeded timeout/i,
  /Network connection lost/i,
  /storage (?:operation )?(?:which )?caused object to be reset/i,
  /reset because its code was updated/i,
  /\boverloaded\b/i,
  /(?:Cloudflare API|HTTP|status(?: code)?)\D+(?:429|5\d\d)\b/i,
];

function usage() {
  return [
    "Usage: node scripts/apply-cloudflare-d1-migrations.mjs [--config <path>]",
    "",
    "Applies remote D1 migrations through Wrangler and retries Cloudflare/D1 transient failures.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { configPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--" && index === 0) {
      // pnpm 会把脚本名后的参数原样转发；只兼容旧 workflow 的前导分隔符，其它未知参数仍必须失败。
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path.");
      options.configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
}

function readNonNegativeIntEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function readPositiveIntEnv(name, fallback) {
  const value = readNonNegativeIntEnv(name, fallback);
  if (value < 1) throw new Error(`${name} must be at least 1.`);
  return value;
}

function wranglerArgs(options) {
  const args = ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--remote"];
  if (options.configPath) args.push("--config", options.configPath);
  return args;
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
}

function isRetryableD1MigrationFailure(output) {
  return retryablePatterns.some((pattern) => pattern.test(output));
}

function runWranglerMigration(args) {
  return new Promise((resolvePromise) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let settled = false;
    const result = { status: null, signal: null, stdout: "", stderr: "", error: undefined };

    child.stdout.on("data", (chunk) => {
      result.stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      result.stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      result.status = 1;
      result.error = error;
      process.stderr.write(`${error.message}\n`);
      resolvePromise(result);
    });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      result.status = status;
      result.signal = signal;
      resolvePromise(result);
    });
  });
}

function retryDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (delay <= 0) return 0;
  return delay + Math.floor(Math.random() * Math.max(1, delay * 0.25));
}

function exitCode(result) {
  return typeof result.status === "number" && result.status !== null ? result.status : 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const maxAttempts = readPositiveIntEnv("RENEWLET_D1_MIGRATION_MAX_ATTEMPTS", 5);
  const baseDelayMs = readNonNegativeIntEnv("RENEWLET_D1_MIGRATION_RETRY_BASE_MS", 1000);
  const maxDelayMs = readNonNegativeIntEnv("RENEWLET_D1_MIGRATION_RETRY_MAX_MS", 15000);
  const args = wranglerArgs(options);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runWranglerMigration(args);
    if (result.status === 0) return;

    const output = commandOutput(result);
    const retryable = isRetryableD1MigrationFailure(output);
    if (!retryable) {
      console.error("Cloudflare D1 migrations failed with a non-retryable error.");
      process.exit(exitCode(result));
    }

    if (attempt >= maxAttempts) {
      console.error(`Cloudflare D1 migrations failed after ${attempt} attempts.`);
      process.exit(exitCode(result));
    }

    // 远端 D1 migration 依赖 Cloudflare API；只重试平台瞬时 reset/超时，真实 SQL/权限/config 错误不能被吞掉。
    const delay = retryDelayMs(attempt, baseDelayMs, maxDelayMs);
    console.error(`Cloudflare D1 migrations hit a retryable error; retrying in ${delay}ms (attempt ${attempt + 1}/${maxAttempts}).`);
    await sleep(delay);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
