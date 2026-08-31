# Build stage
FROM docker.io/library/node:22-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
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
# QWEN_SKIP_PREPARE=1 stops npm ci's prepare script from building and bundling —
# the explicit build and bundle steps below already do that.
RUN QWEN_SKIP_PREPARE=1 npm ci \
  && npm run build \
  && npm run bundle \
  && npm run prepare:package \
  && cd dist && npm pack

# Runtime stage
FROM docker.io/library/node:22-slim

ARG SANDBOX_NAME="qwen-code-sandbox"
ARG CLI_VERSION_ARG
ENV SANDBOX="$SANDBOX_NAME"
ENV CLI_VERSION=$CLI_VERSION_ARG

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
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
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Set up npm global package folder
RUN mkdir -p /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Copy bundled package from builder stage
COPY --from=builder /home/node/app/dist/*.tgz /tmp/

# Install built packages globally.
# --omit=optional: the image must run the CLI bundle it was built from, via
# the node fallback in npm-bin.js — not the prebuilt runtime a platform
# package would resolve to (which tracks the last npm release, not this
# tree). Optional native deps (sharp, node-pty, clipboard) degrade the same
# way and are not needed for the container use cases.
RUN npm install -g --omit=optional /tmp/*.tgz \
  && npm cache clean --force \
  && rm -rf /tmp/*.tgz

# Default entrypoint when none specified
CMD ["qwen"]
