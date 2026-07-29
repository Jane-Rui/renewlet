#!/usr/bin/env node
/**
 * Cloudflare Queue 初始化脚本。
 *
 * 触发时机：`pnpm deploy`、自管 Cloudflare workflow 和稳定版生产部署。
 * 前置依赖：Wrangler 已登录或 CI 已注入 Cloudflare API token/account。
 * 副作用：按当前 Wrangler 配置创建缺失队列；已存在队列视为成功。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(repoRoot, process.env.CI_WRANGLER_CONFIG || "wrangler.jsonc");

function stripJsoncComments(input) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function readQueueNames() {
  const config = JSON.parse(stripJsoncComments(readFileSync(configPath, "utf8")));
  const queues = new Set();
  for (const producer of Array.isArray(config.queues?.producers) ? config.queues.producers : []) {
    if (typeof producer?.queue === "string" && producer.queue.trim()) queues.add(producer.queue.trim());
  }
  for (const consumer of Array.isArray(config.queues?.consumers) ? config.queues.consumers : []) {
    if (typeof consumer?.queue === "string" && consumer.queue.trim()) queues.add(consumer.queue.trim());
    if (typeof consumer?.dead_letter_queue === "string" && consumer.dead_letter_queue.trim()) {
      queues.add(consumer.dead_letter_queue.trim());
    }
  }
  return [...queues];
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
}

function runWranglerQueueCommand(command, name) {
  return spawnSync("pnpm", ["exec", "wrangler", "queues", command, name, "--config", configPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
}

function queueMissing(output) {
  return /does not exist|queues lookup missing queue/i.test(output);
}

function queueCreateConflict(output) {
  return /\b11009\b|already taken/i.test(output);
}

function queueExists(name) {
  const result = runWranglerQueueCommand("info", name);
  const output = commandOutput(result);
  if (result.status === 0) return true;
  if (queueMissing(output)) return false;
  throw new Error(`Failed to inspect Cloudflare Queue ${name}:\n${output.trim()}`);
}

function ensureQueue(name) {
  if (queueExists(name)) {
    console.log(`Cloudflare Queue ready: ${name}`);
    return;
  }

  const result = runWranglerQueueCommand("create", name);
  const output = commandOutput(result);
  if (result.status === 0) {
    console.log(`Cloudflare Queue ready: ${name}`);
    return;
  }

  if (queueCreateConflict(output)) {
    // Cloudflare create 不是幂等 API；并发 workflow 可能先看到缺失、再撞 11009。只有读回确认存在后才吞掉冲突。
    let confirmed = false;
    try {
      confirmed = queueExists(name);
    } catch (error) {
      throw new Error([
        `Cloudflare Queue ${name} create conflicted but the queue could not be confirmed:`,
        output.trim(),
        error instanceof Error ? error.message : String(error),
      ].filter(Boolean).join("\n"));
    }
    if (confirmed) {
      console.log(`Cloudflare Queue ready: ${name}`);
      return;
    }
    throw new Error(`Cloudflare Queue ${name} create conflicted but the queue could not be confirmed:\n${output.trim()}`);
  }

  throw new Error(`Failed to create Cloudflare Queue ${name}:\n${output.trim()}`);
}

function ensureQueues(queues) {
  if (queues.length === 0) {
    console.log("No Cloudflare Queues configured.");
    return;
  }
  // 队列名来自 wrangler 配置；创建脚本不硬编码资源名，避免 generated config 覆盖后漏建 DLQ。
  for (const queue of queues) ensureQueue(queue);
}

ensureQueues(readQueueNames());
