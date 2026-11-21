# Build stage
# Digest-pinned: integration_docker builds on the shared ECS pool, whose
# docker daemon image store persists across jobs — a co-resident job can
# retag a mutable base tag with a poisoned image, but a digest cannot be
# moved by `docker tag`. Bump the digest together with the tag.
# ratchet:docker.io/library/node:22-slim
FROM docker.io/library/node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder

# Optional apt mirror for the layer below. Empty keeps deb.debian.org, which is
# what release builds and local sandbox builds use; the E2E leg passes a
# regional mirror only on hosts where its probe found the default CDN path to be
# far slower (#16214).
ARG APT_MIRROR=

# Install build dependencies
RUN set -e; \
  if [ -n "${APT_MIRROR}" ]; then \
    for sources in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      if [ -f "${sources}" ]; then sed -i "s|deb.debian.org|${APT_MIRROR}|g" "${sources}"; fi; \
    done; \
  fi; \
  apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  make \
  g++ \
  git \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Set up npm global package folder
RUN mkdir -p /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Copy source code
COPY . /home/node/app
WORKDIR /home/node/app

# Install dependencies, build workspaces, bundle into a single distributable, and pack.
# QWEN_SKIP_PREPARE=1 stops the install's prepare script from building and bundling —
# the explicit build and bundle steps below already do that.
RUN QWEN_SKIP_PREPARE=1 corepack pnpm install --frozen-lockfile --reporter=append-only \
  && npm run build \
  && npm run bundle \
  && npm run prepare:package \
  && cd dist && npm pack

# Runtime stage
# Digest-pinned for the same reason as the builder stage above.
# ratchet:docker.io/library/node:22-slim
FROM docker.io/library/node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG SANDBOX_NAME="qwen-code-sandbox"
ARG CLI_VERSION_ARG
# Same optional override as the builder stage: a stage cannot inherit an ARG
# declared before its own FROM.
ARG APT_MIRROR=
ENV SANDBOX="$SANDBOX_NAME"
ENV CLI_VERSION=$CLI_VERSION_ARG

# Install runtime dependencies
RUN set -e; \
  if [ -n "${APT_MIRROR}" ]; then \
    for sources in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      if [ -f "${sources}" ]; then sed -i "s|deb.debian.org|${APT_MIRROR}|g" "${sources}"; fi; \
    done; \
  fi; \
  apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  man-db \
  curl \
  dnsutils \
  less \
  jq \
  bc \
  gh \
  git \
  unzip \
  rsync \
  ripgrep \
  procps \
  psmisc \
  lsof \
  socat \
  ca-certificates \
  fonts-dejavu-core \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Set up npm global package folder
RUN mkdir -p /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Copy bundled package from builder stage
COPY --from=builder /home/node/app/dist/*.tgz /tmp/

# Install built packages globally
RUN npm install -g /tmp/*.tgz \
  && npm cache clean --force \
  && rm -rf /tmp/*.tgz

# Default entrypoint when none specified
CMD ["qwen"]
