#!/usr/bin/env node
/**
 * Cloudflare CI Wrangler 配置生成器。
 *
 * 架构位置：GitHub Actions 只从 Secrets 注入用户自己的 Worker/D1/R2 资源标识，
 * 仓库模板 `wrangler.jsonc` 保持本地开发占位值，避免真实 Cloudflare ID 被提交。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(repoRoot, "wrangler.jsonc");
const outputPath = resolve(repoRoot, process.env.CI_WRANGLER_CONFIG || "wrangler.generated.jsonc");

const requiredEnv = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "WORKER_NAME",
  "D1_DATABASE_ID",
  "R2_BUCKET_NAME",
  "CLOUDFLARE_OBSERVABILITY_PROFILE",
];

const observabilityProfiles = {
  development: { logs: 1, traces: 1 },
  production: { logs: 0.1, traces: 0.05 },
};

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function stripJsoncComments(input) {
  // Wrangler 模板是 JSONC；CI 只需要解析并替换 binding 标识，不能引入额外依赖或执行任意 JS 配置。
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
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

function findBinding(config, key, binding) {
  const bindings = config[key];
  if (!Array.isArray(bindings)) throw new Error(`wrangler.jsonc must contain ${key}`);
  // binding 名是 Worker 代码读取 env.DB/env.ASSETS_BUCKET 的契约；CI 只能替换资源 ID，不能改名。
  const match = bindings.find((item) => item && typeof item === "object" && item.binding === binding);
  if (!match) throw new Error(`wrangler.jsonc must contain ${binding} in ${key}`);
  return match;
}

for (const name of requiredEnv) requireEnv(name);

const config = JSON.parse(stripJsoncComments(readFileSync(templatePath, "utf8")));
config.name = requireEnv("WORKER_NAME");
const observabilityProfile = requireEnv("CLOUDFLARE_OBSERVABILITY_PROFILE");
const sampling = observabilityProfiles[observabilityProfile];
if (!sampling) {
  throw new Error("CLOUDFLARE_OBSERVABILITY_PROFILE must be development or production");
}
// profile 必须由部署工作流显式选择，避免 fork 或开发部署意外继承生产采样，也避免稳定发布保留 100% trace。
config.observability = {
  enabled: true,
  logs: { enabled: true, head_sampling_rate: sampling.logs },
  traces: { enabled: true, head_sampling_rate: sampling.traces },
};

// CI 只替换租户资源标识；路由、binding 名和兼容日期仍以仓库模板为事实源。
const d1 = findBinding(config, "d1_databases", "DB");
d1.database_id = requireEnv("D1_DATABASE_ID");

const r2 = findBinding(config, "r2_buckets", "ASSETS_BUCKET");
r2.bucket_name = requireEnv("R2_BUCKET_NAME");

config.vars = {
  ...(config.vars && typeof config.vars === "object" ? config.vars : {}),
  ...(process.env.RENEWLET_VERSION ? { RENEWLET_VERSION: process.env.RENEWLET_VERSION } : {}),
  ...(process.env.RENEWLET_COMMIT ? { RENEWLET_COMMIT: process.env.RENEWLET_COMMIT } : {}),
  ...(process.env.RENEWLET_BUILD_TIME ? { RENEWLET_BUILD_TIME: process.env.RENEWLET_BUILD_TIME } : {}),
};

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Generated Cloudflare Wrangler config: ${outputPath} (${observabilityProfile})`);
