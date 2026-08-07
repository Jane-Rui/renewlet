# syntax=docker/dockerfile:1.7

# 构建链路：Node 阶段产出 Vite 静态资源，Go 阶段嵌入静态资源并生成单文件 server，runner 只保留运行依赖。
FROM --platform=$BUILDPLATFORM node:24.19.0-alpine3.24 AS client-deps

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/docker-server/package.json apps/docker-server/package.json
# workspace 已纳入独立官网；这里只复制 manifest 让 frozen lockfile 可解析，产品镜像仍只构建 web/docker-server。
COPY apps/website/package.json apps/website/package.json
RUN pnpm install --frozen-lockfile

FROM client-deps AS client-builder
# 客户端构建会解析 @renewlet/shared workspace export，并在 Vite 产物后跑 CSP 守卫。
COPY apps/web apps/web
COPY packages/shared packages/shared
COPY scripts/check-client-csp.mjs scripts/check-client-csp.mjs
RUN pnpm --filter @renewlet/client build

FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine3.24 AS server-builder

# Release workflow 和 Docker buildx 会注入这些元数据；页面内更新和版本弹窗都依赖 ldflags 中的值。
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=0.0.0-dev
ARG COMMIT=dev
ARG BUILD_TIME=dev

WORKDIR /src/apps/docker-server

COPY apps/docker-server/go.mod apps/docker-server/go.sum ./
RUN go mod download

COPY apps/docker-server ./
RUN mkdir -p internal/static/public \
  && find internal/static/public -mindepth 1 ! -name .gitkeep -delete
COPY --from=client-builder /app/apps/web/dist ./internal/static/public

RUN mkdir -p /out /pb_data \
  && CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-$(go env GOARCH)} go build -trimpath -ldflags="-s -w -X main.Version=${VERSION} -X main.Commit=${COMMIT} -X main.BuildTime=${BUILD_TIME} -X main.BuildType=release" -o /out/renewlet ./cmd/renewlet

FROM alpine:3.24 AS runner

ARG VERSION=0.0.0-dev
ARG COMMIT=dev
ARG BUILD_TIME=dev

LABEL org.opencontainers.image.title="Renewlet" \
  org.opencontainers.image.description="Self-hosted subscription ledger and renewal reminders" \
  org.opencontainers.image.source="https://github.com/zhiyingzzhou/renewlet" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${COMMIT}" \
  org.opencontainers.image.created="${BUILD_TIME}" \
  org.opencontainers.image.licenses="MIT"

# GOMEMLIMIT 给小内存 VPS 留余量；自更新变量固定真实二进制和备份目录，不能指向 /renewlet symlink。
ENV GOMEMLIMIT=128MiB \
  RENEWLET_SELF_UPDATE_ENABLED=true \
  RENEWLET_SELF_UPDATE_BINARY=/opt/renewlet/current/renewlet \
  RENEWLET_SELF_UPDATE_BACKUP_DIR=/opt/renewlet/backups

# /renewlet 是 Docker CMD/healthcheck 的稳定门面；自更新只替换 current 下的真实二进制。
RUN apk add --no-cache ca-certificates su-exec tzdata \
  && addgroup -S -g 1000 renewlet \
  && adduser -S -D -H -u 1000 -G renewlet renewlet \
  && mkdir -p /pb_data /opt/renewlet/current /opt/renewlet/backups \
  && ln -s /opt/renewlet/current/renewlet /renewlet \
  && chown -R renewlet:renewlet /pb_data /opt/renewlet

COPY --from=server-builder --chown=renewlet:renewlet /pb_data /pb_data
COPY --from=server-builder --chown=renewlet:renewlet /out/renewlet /opt/renewlet/current/renewlet
COPY --chmod=755 deploy/docker-entrypoint.sh /docker-entrypoint.sh

# pb_data 同时保存 PocketBase SQLite、上传文件和迁移状态；升级/重建容器必须持久化这个卷。
VOLUME ["/pb_data"]
EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["serve", "--http=0.0.0.0:3000", "--dir=/pb_data", "--encryptionEnv=PB_ENCRYPTION_KEY"]
