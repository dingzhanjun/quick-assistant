# Build context is the repo root:  docker build -f apps/web/Dockerfile .

# Kitchen print agent (Go, apps/printer-agent): static binaries for a Raspberry Pi (64-bit and 32-bit OS) and x86 Linux, with
# sha256 files and a VERSION file. They end up in the web app's public/printer/, so the server itself hosts the agent downloads
# (https://<your domain>/printer/order-printer-linux-arm64): no separate release, works for a private repository, and a new agent
# version reaches the Pis with the next web deploy. Bump apps/printer-agent/VERSION when the agent changes.
FROM golang:1.23-bookworm@sha256:167053a2bb901972bf2c1611f8f52c44d5fe7e762e5cab213708d82c421614db AS agent
WORKDIR /src
COPY apps/printer-agent/ ./
RUN set -eu; V="$(tr -d ' \n' < VERSION)"; mkdir -p /out; \
    build() { CGO_ENABLED=0 GOOS=linux GOARCH="$2" GOARM="$3" go build -trimpath -ldflags "-s -w -X main.version=$V" -o "/out/order-printer-linux-$1" ./cmd/order-printer; \
              (cd /out && sha256sum "order-printer-linux-$1" > "order-printer-linux-$1.sha256"); }; \
    build arm64 arm64 ""; build arm arm 6; build amd64 amd64 ""; echo "$V" > /out/VERSION
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/web apps/web
COPY --from=agent /out apps/web/public/printer
# Dummy values only so the build can run; real secrets are injected at runtime, never baked in.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-only-secret-not-used-at-runtime \
    BETTER_AUTH_URL=http://localhost:3000 \
    GOOGLE_CLIENT_ID=build GOOGLE_CLIENT_SECRET=build \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build && pnpm --filter web build:worker

# One-shot job: applies SQL migrations. Needs drizzle-kit (a dev dependency), hence not the runner image.
FROM build AS migrate
WORKDIR /repo/apps/web
CMD ["pnpm", "db:migrate"]

FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /repo
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
# The background worker as its own small program (no Next.js): `node apps/web/worker.cjs`, used by the compose `worker` service.
COPY --from=build --chown=node:node /repo/apps/web/dist/worker.cjs ./apps/web/worker.cjs
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
