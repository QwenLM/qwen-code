# Qwen-Code Core - Production Ready Alpha
# Multi-stage build for optimal production deployment

# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production --ignore-scripts

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev

# Copy package files and dependencies
COPY package*.json ./
COPY tsconfig.json ./
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY src ./src

# Build application
RUN npm run build

# Stage 3: Production
FROM node:20-alpine AS production
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S qwen -u 1001

# Install production dependencies only
RUN apk add --no-cache \
    cairo \
    jpeg \
    pango \
    giflib \
    pixman \
    pangomm \
    libjpeg-turbo \
    freetype \
    curl \
    dumb-init \
    && rm -rf /var/cache/apk/*

# Create necessary directories
RUN mkdir -p /app/logs /app/uploads /app/cache /app/temp && \
    chown -R qwen:nodejs /app

# Copy built application
COPY --from=builder --chown=qwen:nodejs /app/dist ./dist
COPY --from=builder --chown=qwen:nodejs /app/node_modules ./node_modules
COPY --chown=qwen:nodejs package*.json ./

# Copy configuration files
COPY --chown=qwen:nodejs docker/entrypoint.sh ./
COPY --chown=qwen:nodejs docker/healthcheck.sh ./

# Set proper permissions
RUN chmod +x entrypoint.sh healthcheck.sh && \
    chown qwen:nodejs entrypoint.sh healthcheck.sh

# Switch to non-root user
USER qwen

# Expose ports
EXPOSE 3000 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD ./healthcheck.sh

# Set environment variables
ENV NODE_ENV=production \
    PORT=3000 \
    HEALTH_PORT=3001 \
    UV_THREADPOOL_SIZE=64 \
    NODE_OPTIONS="--max-old-space-size=2048 --enable-source-maps"

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start application
CMD ["./entrypoint.sh"]

# Stage 4: Development (optional)
FROM node:20-alpine AS development
WORKDIR /app

# Install development dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    git \
    curl \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY src ./src

# Expose ports
EXPOSE 3000 3001 9229

# Set environment variables
ENV NODE_ENV=development \
    PORT=3000 \
    HEALTH_PORT=3001

# Start development server
CMD ["npm", "run", "dev"]

# Stage 5: Testing
FROM node:20-alpine AS testing
WORKDIR /app

# Install testing dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    musl-dev \
    giflib-dev \
    pixman-dev \
    pangomm-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies
RUN npm ci

# Copy source code and tests
COPY src ./src
COPY tests ./tests

# Run tests
CMD ["npm", "test"]

# Stage 6: Security Scan
FROM node:20-alpine AS security-scan
WORKDIR /app

# Install security scanning tools
RUN apk add --no-cache \
    npm-audit \
    snyk \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Run security audit
RUN npm audit --audit-level=moderate || true

# Stage 7: Performance Testing
FROM node:20-alpine AS performance
WORKDIR /app

# Install performance testing tools
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code and benchmarks
COPY src ./src
COPY benchmarks ./benchmarks

# Run performance benchmarks
CMD ["npm", "run", "benchmark"]

# Labels for better container management
LABEL maintainer="Qwen-Code Creative Team <team@qwen-code.ai>" \
      version="1.0.0-alpha.1" \
      description="Qwen-Code Core - Production Ready Alpha" \
      org.opencontainers.image.title="Qwen-Code Core" \
      org.opencontainers.image.description="AI-powered creative code generation system" \
      org.opencontainers.image.version="1.0.0-alpha.1" \
      org.opencontainers.image.vendor="Qwen-Code" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/qwen-code/creative-ecosystem"