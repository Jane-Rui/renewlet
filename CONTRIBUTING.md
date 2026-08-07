# Contributing to Renewlet

Thanks for helping improve Renewlet. Issues, documentation fixes, tests, and pull requests are welcome.

## Local Setup

Renewlet is a pnpm workspace with a React/Vite client, a Go/PocketBase Docker server, a Cloudflare Worker runtime, and shared TypeScript schemas.

Requirements:

- Node.js 22.13 or newer.
- pnpm 11.1.2 via Corepack.
- Go 1.26.2 for the Docker server.
- Docker Compose v2 for Docker deployment checks.

Install dependencies from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Useful development commands:

```bash
pnpm --filter @renewlet/client dev
pnpm --dir apps/docker-server start
pnpm dev:cloudflare
```

## Quality Checks

Use the narrowest check that covers your change:

```bash
pnpm check:file-lines
pnpm check:deploy
pnpm check:public-api-docs
pnpm --filter @renewlet/client lint
pnpm --filter @renewlet/client test:run
pnpm --dir apps/docker-server test
pnpm check:cloudflare
pnpm typecheck:e2e
pnpm test:e2e
```

Before opening a pull request, run the relevant type checks and tests. For cross-runtime API/schema work, run the Docker server, client, and Cloudflare checks together.

## Public API Docs

The Public API documentation is generated. Do not edit `docs/public-api.openapi.json` or `docs/public-api.md` by hand.

When Public API schemas or routes change, update the shared endpoint registry and run:

```bash
pnpm generate:public-api-docs
pnpm check:public-api-docs
```

The generator compares the registry with both Go and Cloudflare Worker `/api/public/v1/*` route registrations so one runtime cannot drift from the documented contract.

## Playwright E2E

Release smoke tests live in `e2e/release-smoke.spec.ts` and `e2e/mobile-release-smoke.spec.ts`. They cover setup/login state, mobile primary pages, Renewlet ZIP import, mocked AI SSE import, and account password change/re-login.

Run the smoke suite locally with:

```bash
pnpm typecheck:e2e
pnpm exec playwright test e2e/release-smoke.spec.ts e2e/mobile-release-smoke.spec.ts
```

The full Playwright suite still runs through `pnpm test:e2e`. AI provider calls in E2E must stay mocked so the release gate does not depend on third-party secrets, quota, or network behavior.

## Code Style

- Keep API contracts in shared Zod schemas when they cross the client, Go server, and Worker runtimes.
- Keep user-visible client text in Lingui catalogs.
- Do not hard-code secrets, real credentials, or private deployment data.
- Add comments only for business intent, historical workarounds, implicit constraints, or core state transitions. Avoid comments that restate ordinary syntax.
- Do not weaken strict JSON parsing, user isolation, CSRF/session boundaries, private asset checks, or Public API bearer-token separation.

## Pull Requests

For larger changes, open an issue first with the goal, user-facing behavior, and rough approach. Keep pull requests focused on one problem area, include tests for behavior changes, and mention any checks you could not run.
