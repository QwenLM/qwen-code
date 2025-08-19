# Build stage
FROM docker.io/library/node:20-slim AS builder

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

# Install dependencies and build packages
RUN npm ci \
  && npm run build --workspaces \
  && npm pack -w @qwen-code/qwen-code --pack-destination ./packages/cli/dist \
  && npm pack -w @qwen-code/qwen-code-core --pack-destination ./packages/core/dist

# Runtime stage
FROM docker.io/library/node:20-slim

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

# Copy built packages from builder stage
COPY --from=builder /home/node/app/packages/cli/dist/*.tgz /tmp/
COPY --from=builder /home/node/app/packages/core/dist/*.tgz /tmp/

# Install built packages globally
RUN npm install -g /tmp/*.tgz \
  && npm cache clean --force \
  && rm -rf /tmp/*.tgz

# Default entrypoint when none specified
CMD ["qwen"]
