# Build from the repository root.
# ratchet:docker.io/library/node:22-slim
FROM docker.io/library/node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN QWEN_SKIP_PREPARE=1 corepack pnpm install --frozen-lockfile --reporter=append-only \
    && npm run build && npm run bundle && npm run prepare:package \
    && cd dist && npm pack

# ratchet:docker.io/library/node:22-slim
FROM docker.io/library/node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/dist/*.tgz /tmp/
RUN npm install --global /tmp/*.tgz && npm cache clean --force && rm /tmp/*.tgz \
    && mkdir -p /var/run/qwen && chown 10001:10001 /var/run/qwen
COPY packages/managed-agent-server/distribution/kubernetes/harness-*.mjs /opt/qwen/
USER 10001:10001
WORKDIR /var/run/qwen
ENTRYPOINT ["node", "/opt/qwen/harness-launcher.mjs"]
