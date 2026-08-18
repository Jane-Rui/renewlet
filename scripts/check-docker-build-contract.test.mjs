import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkDockerBuildContract } from "./check-docker-build-contract.mjs";

const clientBuild = [
  "tsc --noEmit --project tsconfig.app.json",
  "vite build",
  "node scripts/check-client-csp.mjs",
  "node scripts/check-client-bundle-budget.mjs",
].join(" && ");

const dockerfile = `# syntax=docker/dockerfile:1.8
# check=error=true

FROM node:24.19.0-alpine AS client-deps
FROM client-deps AS client-builder
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN pnpm --filter @renewlet/client build
FROM golang:1.26.6-alpine AS server-builder
COPY --from=client-builder /app/apps/web/dist ./internal/static/public
FROM alpine:3.24 AS runner
COPY --from=server-builder /out/renewlet /opt/renewlet/current/renewlet
COPY deploy/docker-entrypoint.sh /docker-entrypoint.sh
`;

const workflow = `jobs:
  build:
    steps:
      - uses: docker/build-push-action@v7
        with:
          context: .
          file: ./Dockerfile
`;

function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "renewlet-docker-contract-"));
  writeFixtureFile(root, "Dockerfile", dockerfile);
  writeFixtureFile(root, "apps/web/package.json", JSON.stringify({ scripts: { build: clientBuild } }));
  writeFixtureFile(root, "apps/web/scripts/check-client-csp.mjs", "export {};\n");
  writeFixtureFile(
    root,
    "apps/web/scripts/check-client-bundle-budget.mjs",
    "556075 468559 73240 60088 112455 93798\n",
  );
  writeFixtureFile(root, "apps/web/vite.config.ts", "export default { build: { manifest: true } };\n");
  writeFixtureFile(
    root,
    ".github/workflows/ci.yml",
    "run: pnpm build:all\nrun: pnpm check:route-parity\nrun: pnpm test:perf\n",
  );
  writeFixtureFile(
    root,
    ".github/workflows/build-smoke.yml",
    `${workflow}          load: true
      - run: |
          container_id="$(docker run --detach renewlet:smoke)"
          trap cleanup EXIT
          docker exec "$container_id" /renewlet healthcheck
`,
  );
  writeFixtureFile(root, ".github/workflows/security-scan.yml", `${workflow}  image-scan:\n${workflow}`);
  writeFixtureFile(root, ".github/workflows/release-publish.yml", workflow);
  return root;
}

function withFixture(run) {
  const root = createFixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts the workspace-owned client build contract", () => {
  withFixture((root) => assert.doesNotThrow(() => checkDockerBuildContract(root)));
});

test("rejects client build scripts outside apps/web", () => {
  withFixture((root) => {
    writeFixtureFile(root, "scripts/external.mjs", "export {};\n");
    const packagePath = join(root, "apps/web/package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    packageJson.scripts.build += " && node ../../scripts/external.mjs";
    writeFileSync(packagePath, JSON.stringify(packageJson));
    assert.throws(() => checkDockerBuildContract(root), /must stay inside apps\/web/);
  });
});

test("rejects missing client build scripts", () => {
  withFixture((root) => {
    rmSync(join(root, "apps/web/scripts/check-client-csp.mjs"));
    assert.throws(() => checkDockerBuildContract(root), /does not exist/);
  });
});

test("rejects per-file root script copies", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      "RUN pnpm --filter @renewlet/client build",
      "COPY scripts/check-client-csp.mjs scripts/check-client-csp.mjs\nRUN pnpm --filter @renewlet/client build",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /apps\/web ownership boundary/);
  });
});

test("rejects a client-builder that does not copy the Web workspace", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace("COPY apps/web apps/web\n", "");
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /COPY apps\/web apps\/web/);
  });
});

test("rejects workflows that build a divergent Dockerfile", () => {
  withFixture((root) => {
    const workflowPath = join(root, ".github/workflows/security-scan.yml");
    const content = readFileSync(workflowPath, "utf8").replaceAll("file: ./Dockerfile", "file: ./Dockerfile.scan");
    writeFileSync(workflowPath, content);
    assert.throws(() => checkDockerBuildContract(root), /shared root Dockerfile/);
  });
});

test("rejects build-time files copied into the runner", () => {
  withFixture((root) => {
    const dockerfilePath = join(root, "Dockerfile");
    const content = readFileSync(dockerfilePath, "utf8").replace(
      "COPY deploy/docker-entrypoint.sh /docker-entrypoint.sh",
      "COPY --from=client-builder /app/apps/web/scripts /scripts\nCOPY deploy/docker-entrypoint.sh /docker-entrypoint.sh",
    );
    writeFileSync(dockerfilePath, content);
    assert.throws(() => checkDockerBuildContract(root), /must not receive build-time files/);
  });
});
