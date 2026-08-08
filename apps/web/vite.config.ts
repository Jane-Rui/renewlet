import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import {
  appendUniqueString,
  customHeadScriptEnvName,
  injectCustomHeadScriptHtml,
  parseCustomHeadScript,
  updateCustomHeadScriptStaticHeaders,
  type CustomHeadScript,
} from "./vite/custom-head-script.js";
import { resolveClientBuildVersion } from "./vite/build-version.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const devProxyOptions = (target: string) => ({
  target,
  // 本地开发经 Vite 访问 Go API 时，公开/日历 bearer URL 需要保留浏览器看到的外部 origin。
  xfwd: true,
});

const customHeadScriptPlugin = (script: CustomHeadScript | undefined, options: { updateStaticHeaders: boolean }): Plugin => ({
  name: "renewlet-custom-head-script",
  transformIndexHtml(html) {
    return injectCustomHeadScriptHtml(html, script);
  },
  writeBundle() {
    if (!script || !options.updateStaticHeaders) return;
    const headersPath = path.resolve(rootDir, "dist/_headers");
    if (!existsSync(headersPath)) {
      throw new Error("Missing apps/web/dist/_headers. Cloudflare custom head script build needs Static Assets headers.");
    }
    const headers = readFileSync(headersPath, "utf8");
    const nextHeaders = updateCustomHeadScriptStaticHeaders(headers, script);
    if (nextHeaders !== headers) writeFileSync(headersPath, nextHeaders);
  },
});

function contentSecurityPolicy(script: CustomHeadScript | undefined): string {
  const turnstileChallengeOrigin = "https://challenges.cloudflare.com";
  const scriptSources = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", turnstileChallengeOrigin];
  const connectSources = ["'self'", "https:", turnstileChallengeOrigin];
  if (script) {
    appendUniqueString(scriptSources, script.scriptOrigin);
    for (const origin of script.connectOrigins) appendUniqueString(connectSources, origin);
  }
  return [
    "default-src 'self'",
    "script-src " + scriptSources.join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "connect-src " + connectSources.join(" "),
    "font-src 'self' data:",
    "frame-src " + turnstileChallengeOrigin,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const vendorChunkGroups = [
  {
    name: "react-vendor",
    test: /node_modules[\\/](react|react-dom|react-router|@tanstack)[\\/]/,
    priority: 50,
  },
  {
    name: "radix-vendor",
    test: /node_modules[\\/]@radix-ui[\\/]/,
    priority: 40,
  },
  {
    name: "charts-vendor",
    test: /node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|react-smooth|decimal\.js-light)[\\/]/,
    priority: 35,
  },
  {
    name: "forms-vendor",
    test: /node_modules[\\/](react-hook-form|@hookform|zod|react-number-format|input-otp)[\\/]/,
    priority: 30,
  },
  {
    name: "time-vendor",
    test: /node_modules[\\/](@js-temporal|jsbi)[\\/]/,
    priority: 25,
  },
  {
    name: "runtime-ui-vendor",
    test: /node_modules[\\/](lucide-react|framer-motion|vaul|cmdk|sonner|react-day-picker|date-fns|embla-carousel-react|@dnd-kit|class-variance-authority|clsx|tailwind-merge|react-resizable-panels)[\\/]/,
    priority: 20,
  },
  {
    name: "data-vendor",
    test: /node_modules[\\/](pocketbase)[\\/]/,
    priority: 10,
  },
];

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const devProxyTarget = process.env["VITE_DEV_PROXY_TARGET"] ?? env["VITE_DEV_PROXY_TARGET"] ?? "http://127.0.0.1:3000";
  const renewletRuntime = process.env["VITE_RENEWLET_RUNTIME"] ?? env["VITE_RENEWLET_RUNTIME"];
  const clientBuildVersion = resolveClientBuildVersion(repoRoot, { ...env, ...process.env });
  const shouldInjectCustomHeadScript = command === "serve" || renewletRuntime === "cloudflare";
  // Docker build 的最终 HTML 由 Go 运行时注入；只有 Vite dev 和 Cloudflare Static Assets build 在这一层拥有最终 HTML/CSP。
  const customHeadScript = shouldInjectCustomHeadScript
    ? parseCustomHeadScript(process.env[customHeadScriptEnvName] ?? env[customHeadScriptEnvName])
    : undefined;

  return {
    plugins: [
      customHeadScriptPlugin(customHeadScript, {
        updateStaticHeaders: command === "build" && renewletRuntime === "cloudflare",
      }),
      lingui({ failOnCompileError: true }),
      tailwindcss(),
      react(),
    ],
    worker: {
      plugins: () => [lingui({ failOnCompileError: true })],
    },
    resolve: {
      alias: {
        "@": path.resolve(rootDir, "src"),
      },
    },
    define: {
      __RENEWLET_CLIENT_BUILD_VERSION__: JSON.stringify(clientBuildVersion),
    },
    server: {
      port: 5173,
      headers: {
        "Content-Security-Policy": contentSecurityPolicy(customHeadScript),
      },
      proxy: {
        "/api": devProxyOptions(devProxyTarget),
        "/calendar/renewals.ics": devProxyOptions(devProxyTarget),
        "/_": devProxyOptions(devProxyTarget),
      },
      allowedHosts: ["sh.cfhd.de"],
    },
    build: {
      rolldownOptions: {
        output: {
          // Workers Static Assets 直接下发前端产物；按依赖边界拆主包，避免首屏 JS 重新越过 Vite 500KB 预警线。
          codeSplitting: {
            groups: vendorChunkGroups,
          },
        },
      },
    },
  };
});
