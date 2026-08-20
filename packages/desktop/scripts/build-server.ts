#!/usr/bin/env bun
/**
 * Build script for standalone Qwen Code server.
 *
 * Assembles a self-contained distribution directory with all runtime
 * dependencies, resources, and platform-specific binaries.
 *
 * Usage:
 *   bun run scripts/build-server.ts
 *   bun run scripts/build-server.ts --platform=linux --arch=x64
 *   bun run scripts/build-server.ts --platform=linux --arch=arm64 --compress
 *
 * Options:
 *   --platform       Target platform: darwin, linux (default: current)
 *   --arch           Target architecture: x64, arm64 (default: current)
 *   --output         Output directory (default: dist/server)
 *   --compress       Create .tar.gz archive after assembly
 *   --skip-download  Skip Bun/uv downloads (use existing if present)
 *   --help           Show help
 */

process.on('uncaughtException', (error) => {
  console.error('\n  Build failed (uncaught):', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('\n  Build failed (unhandled):', reason);
  process.exit(1);
});

import { parseArgs } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
} from 'fs';
import { $ } from 'bun';
import {
  type Platform,
  type Arch,
  type BuildConfig,
  BUN_VERSION,
  UV_VERSION,
  downloadBun,
  downloadUv,
  buildMcpServers,
  getPlatformKey,
} from './build/common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServerPlatform = 'darwin' | 'linux';

interface ServerBuildConfig {
  platform: ServerPlatform;
  arch: Arch;
  rootDir: string;
  electronDir: string;  // Source of resources
  outputDir: string;
  compress: boolean;
  skipDownload: boolean;
  version: string;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
Standalone server build script for Qwen Code

Usage:
  bun run scripts/build-server.ts [options]

Options:
  --platform=<platform>  Target platform: darwin, linux
                         (default: ${process.platform})
  --arch=<arch>          Target architecture: x64, arm64
                         (default: ${process.arch === 'arm64' ? 'arm64' : 'x64'})
  --output=<path>        Output directory (default: dist/server)
  --compress             Create .tar.gz after assembly
  --skip-download        Reuse existing Bun/uv binaries
  --help                 Show this help message

Examples:
  # Build for current platform
  bun run scripts/build-server.ts

  # Build Linux x64 tarball
  bun run scripts/build-server.ts --platform=linux --arch=x64 --compress

  # Build Linux ARM64 tarball
  bun run scripts/build-server.ts --platform=linux --arch=arm64 --compress
`);
}

// ---------------------------------------------------------------------------
// Resource assembly
// ---------------------------------------------------------------------------

function assembleResources(config: ServerBuildConfig): void {
  const { electronDir, outputDir, platform, arch } = config;
  const srcResources = join(electronDir, 'resources');
  const destResources = join(outputDir, 'resources');

  console.log('  Copying docs, themes, permissions, tool-icons...');
  for (const dir of ['docs', 'themes', 'permissions', 'tool-icons']) {
    const src = join(srcResources, dir);
    if (existsSync(src)) {
      cpSync(src, join(destResources, dir), { recursive: true });
    }
  }

  // Config defaults
  const configDefaults = join(srcResources, 'config-defaults.json');
  if (existsSync(configDefaults)) {
    copyFileSync(configDefaults, join(destResources, 'config-defaults.json'));
  }

  // Python scripts (skip tests/)
  console.log('  Copying Python scripts...');
  const scriptsDir = join(srcResources, 'scripts');
  const destScripts = join(destResources, 'scripts');
  mkdirSync(destScripts, { recursive: true });
  if (existsSync(scriptsDir)) {
    for (const entry of readdirSync(scriptsDir)) {
      if (entry === 'tests') continue;
      const src = join(scriptsDir, entry);
      const stat = lstatSync(src);
      if (stat.isFile()) {
        copyFileSync(src, join(destScripts, entry));
      }
    }
  }

  // Shell wrappers for doc tools (not .cmd files — those are Windows-only)
  console.log('  Copying doc tool wrappers...');
  const binDir = join(destResources, 'bin');
  mkdirSync(binDir, { recursive: true });
  const srcBin = join(srcResources, 'bin');
  if (existsSync(srcBin)) {
    for (const entry of readdirSync(srcBin)) {
      const src = join(srcBin, entry);
      const stat = lstatSync(src);
      // Only copy files (not platform directories), skip .cmd
      if (stat.isFile() && !entry.endsWith('.cmd')) {
        copyFileSync(src, join(binDir, entry));
      }
    }
  }

  // MCP servers
  console.log('  Copying MCP servers...');
  for (const server of ['session-mcp-server', 'bridge-mcp-server']) {
    const src = join(srcResources, server);
    if (existsSync(src)) {
      cpSync(src, join(destResources, server), { recursive: true });
    }
  }

  // Also copy session-mcp-server from packages/ build output (dev path fallback)
  const sessionServerDist = join(config.rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js');
  if (existsSync(sessionServerDist)) {
    const destSessionServer = join(destResources, 'session-mcp-server');
    mkdirSync(destSessionServer, { recursive: true });
    copyFileSync(sessionServerDist, join(destSessionServer, 'index.js'));
  }
}

// ---------------------------------------------------------------------------
// uv binary — download into output dir (not electron resources)
// ---------------------------------------------------------------------------

async function downloadUvForServer(config: ServerBuildConfig): Promise<void> {
  const { platform, arch, outputDir, skipDownload } = config;
  const uvDest = join(outputDir, 'resources', 'bin', 'uv');

  if (skipDownload && existsSync(uvDest)) {
    console.log('  uv already present, skipping download');
    return;
  }

  // Use common.ts downloadUv which writes to electronDir/resources/bin/{platform-arch}/
  // Then we'll copy the binary to our flat layout
  const platformKey = getPlatformKey(platform, arch);
  const electronUvPath = join(config.electronDir, 'resources', 'bin', platformKey, 'uv');

  if (!existsSync(electronUvPath)) {
    // Download using the shared helper
    const buildConfig: BuildConfig = {
      platform,
      arch,
      upload: false,
      uploadLatest: false,
      uploadScript: false,
      rootDir: config.rootDir,
      electronDir: config.electronDir,
    };
    await downloadUv(buildConfig);
  }

  if (!existsSync(electronUvPath)) {
    throw new Error(`uv binary not found after download at ${electronUvPath}`);
  }

  // Flatten: copy to resources/bin/uv (no platform subdirectory in server dist)
  const binDir = join(outputDir, 'resources', 'bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(electronUvPath, uvDest);
  await $`chmod +x ${uvDest}`.quiet();
  console.log(`  uv binary installed (${(lstatSync(uvDest).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// Bun runtime — download into output dir
// ---------------------------------------------------------------------------

async function downloadBunForServer(config: ServerBuildConfig): Promise<void> {
  const { platform, arch, outputDir, skipDownload } = config;
  const runtimeDir = join(outputDir, 'vendor', 'bun');
  const bunDest = join(runtimeDir, 'bun');

  if (skipDownload && existsSync(bunDest)) {
    console.log('  Bun already present, skipping download');
    return;
  }

  // Download to electron's vendor dir using shared helper, then copy
  const buildConfig: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: config.rootDir,
    electronDir: config.electronDir,
  };
  await downloadBun(buildConfig);

  const electronBunPath = join(config.electronDir, 'vendor', 'bun', 'bun');
  if (!existsSync(electronBunPath)) {
    throw new Error(`Bun binary not found after download at ${electronBunPath}`);
  }

  mkdirSync(runtimeDir, { recursive: true });
  copyFileSync(electronBunPath, bunDest);
  await $`chmod +x ${bunDest}`.quiet();
  console.log(`  Bun runtime installed (${(lstatSync(bunDest).size / 1024 / 1024).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------------------
// Production node_modules
// ---------------------------------------------------------------------------

/**
 * Recursively resolve and copy a package and its entire dependency tree.
 * Reads each package's package.json to discover transitive deps.
 */
function copyDependencyTree(
  dep: string,
  srcModules: string,
  destModules: string,
  visited: Set<string>,
): void {
  if (visited.has(dep)) return;
  visited.add(dep);

  const src = join(srcModules, dep);
  if (!existsSync(src)) return;

  // Ensure scope directory exists
  if (dep.startsWith('@')) {
    const scope = dep.split('/')[0]!;
    mkdirSync(join(destModules, scope), { recursive: true });
  }

  const dest = join(destModules, dep);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });

  // Recurse into dependencies
  const pkgPath = join(src, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      for (const childDep of Object.keys(pkg.dependencies || {})) {
        copyDependencyTree(childDep, srcModules, destModules, visited);
      }
    } catch {
      // Skip if package.json is malformed
    }
  }
}

/**
 * Scan all .ts files in a directory tree for import/require statements
 * and return the set of external npm package names (not relative paths,
 * not node: builtins, not workspace @craft-agent/* packages).
 */
function scanImports(dir: string): Set<string> {
  const packages = new Set<string>();
  // Match: import ... from 'pkg', require('pkg'), import('pkg')
  const importRe = /(?:from\s+['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"]+)['"]/g;

  function walk(d: string): void {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'tests' && entry.name !== '__tests__') {
        walk(full);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        const content = readFileSync(full, 'utf-8');
        let match: RegExpExecArray | null;
        while ((match = importRe.exec(content)) !== null) {
          const spec = match[1]!;
          // Skip relative imports, node: builtins, workspace packages
          if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('@craft-agent/')) continue;
          // Extract package name (handle scoped: @scope/name)
          const parts = spec.split('/');
          const pkgName = spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
          packages.add(pkgName);
        }
      }
    }
  }

  walk(dir);
  return packages;
}

function copyProductionDeps(config: ServerBuildConfig): void {
  const { rootDir, outputDir, platform, arch } = config;
  const srcModules = join(rootDir, 'node_modules');
  const destModules = join(outputDir, 'node_modules');

  // Track all copied packages to avoid duplicates
  const copied = new Set<string>();

  // -------------------------------------------------------------------------
  // 1. Scan source code for ALL external imports across server packages
  //    This catches everything — declared deps, undeclared deps, transitive
  //    imports that happen to work due to hoisting. No more whack-a-mole.
  // -------------------------------------------------------------------------
  // messaging-gateway is included so its runtime deps (grammy, etc.) land in node_modules.
  // messaging-whatsapp-worker is intentionally OMITTED: Baileys and its transitive deps
  // are bundled directly into packages/messaging-whatsapp-worker/dist/worker.cjs by
  // scripts/build-wa-worker.ts — pulling them into node_modules would duplicate the tree.
  const SERVER_PACKAGES = ['server', 'server-core', 'shared', 'core', 'session-tools-core', 'session-mcp-server', 'messaging-gateway'];

  const allImports = new Set<string>();
  for (const pkg of SERVER_PACKAGES) {
    const pkgSrc = join(rootDir, 'packages', pkg, 'src');
    const imports = scanImports(pkgSrc);
    for (const imp of imports) allImports.add(imp);
  }
  console.log(`  Found ${allImports.size} external packages referenced in source`);

  // Also include declared dependencies (catches deps used only at runtime / dynamically)
  for (const pkg of SERVER_PACKAGES) {
    const pkgJsonPath = join(rootDir, 'packages', pkg, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      for (const [dep, version] of Object.entries(pkgJson.dependencies || {}) as [string, string][]) {
        if (typeof version === 'string' && version.startsWith('workspace:')) continue;
        allImports.add(dep);
      }
      // Also peer dependencies (they're real runtime deps)
      for (const dep of Object.keys(pkgJson.peerDependencies || {})) {
        allImports.add(dep);
      }
    } catch { /* skip */ }
  }

  // Copy each discovered package and its full transitive dependency tree
  for (const dep of allImports) {
    copyDependencyTree(dep, srcModules, destModules, copied);
  }
  console.log(`  Source imports + declared deps: ${copied.size} packages`);

  // -------------------------------------------------------------------------
  // 2. Platform-specific native binaries (optionalDependencies, not in dep trees)
  // -------------------------------------------------------------------------
  const PLATFORM_DEPS = [
    `@img/sharp-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`,
    `@img/sharp-libvips-${platform === 'darwin' ? 'darwin' : 'linux'}-${arch}`,
    '@img/colour',
  ];

  for (const dep of PLATFORM_DEPS) {
    if (copied.has(dep)) continue;
    const src = join(srcModules, dep);
    if (!existsSync(src)) {
      console.log(`  Skipping ${dep} (not installed for current platform)`);
      continue;
    }
    if (dep.startsWith('@')) {
      const scope = dep.split('/')[0]!;
      mkdirSync(join(destModules, scope), { recursive: true });
    }
    mkdirSync(dirname(join(destModules, dep)), { recursive: true });
    cpSync(src, join(destModules, dep), { recursive: true, dereference: true });
    copied.add(dep);
  }

  console.log(`  Total: ${copied.size} packages copied to node_modules`);

}

function getDirSize(dir: string): number {
  let size = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      size += lstatSync(fullPath).size;
    } else if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    }
  }
  return size;
}

// ---------------------------------------------------------------------------
// Workspace packages
// ---------------------------------------------------------------------------

function copyWorkspacePackages(config: ServerBuildConfig): void {
  const { rootDir, outputDir } = config;

  // messaging-whatsapp-worker is included so dist/worker.cjs (built in step 4) ships.
  // The worker is spawned as a Node subprocess against that file at runtime; see
  // CRAFT_MESSAGING_WA_WORKER env resolution in packages/server/src/index.ts.
  const packages = [
    'server',
    'server-core',
    'shared',
    'core',
    'session-tools-core',
    'session-mcp-server',
    'messaging-gateway',
    'messaging-whatsapp-worker',
  ];

  for (const pkg of packages) {
    const src = join(rootDir, 'packages', pkg);
    const dest = join(outputDir, 'packages', pkg);

    if (!existsSync(src)) {
      console.warn(`  Warning: package ${pkg} not found`);
      continue;
    }

    mkdirSync(dest, { recursive: true });

    // Copy package.json
    copyFileSync(join(src, 'package.json'), join(dest, 'package.json'));

    // Copy tsconfig.json if present
    const tsconfig = join(src, 'tsconfig.json');
    if (existsSync(tsconfig)) {
      copyFileSync(tsconfig, join(dest, 'tsconfig.json'));
    }

    // Copy src/ directory
    const srcDir = join(src, 'src');
    if (existsSync(srcDir)) {
      cpSync(srcDir, join(dest, 'src'), { recursive: true });
    }

    // Copy dist/ directory if present (built artifacts like session-mcp-server)
    const distDir = join(src, 'dist');
    if (existsSync(distDir)) {
      cpSync(distDir, join(dest, 'dist'), { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Root config files for workspace resolution
// ---------------------------------------------------------------------------

function createRootConfig(config: ServerBuildConfig): void {
  const { outputDir, version } = config;

  // Root package.json with workspaces (Bun resolves @craft-agent/* through this)
  const rootPkg = {
    name: 'craft-server-dist',
    version,
    private: true,
    workspaces: ['packages/*'],
  };
  writeFileSync(join(outputDir, 'package.json'), JSON.stringify(rootPkg, null, 2) + '\n');

  // Root tsconfig.json for path resolution
  const rootTsconfig = {
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      paths: {
        '@craft-agent/server-core/*': ['./packages/server-core/src/*'],
        '@craft-agent/shared/*': ['./packages/shared/src/*'],
        '@craft-agent/core/*': ['./packages/core/src/*'],
        '@craft-agent/session-tools-core/*': ['./packages/session-tools-core/src/*'],
      },
    },
  };
  writeFileSync(join(outputDir, 'tsconfig.json'), JSON.stringify(rootTsconfig, null, 2) + '\n');

  // Create workspace symlinks in node_modules/@craft-agent/
  // Bun needs these to resolve workspace package imports at runtime
  const scopeDir = join(outputDir, 'node_modules', '@craft-agent');
  mkdirSync(scopeDir, { recursive: true });

  const packagesDir = join(outputDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir)) {
      const pkgJsonPath = join(packagesDir, pkg, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;

      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        const name: string = pkgJson.name || '';
        if (name.startsWith('@craft-agent/')) {
          const shortName = name.replace('@craft-agent/', '');
          const linkPath = join(scopeDir, shortName);
          const target = join('..', '..', 'packages', pkg);
          if (!existsSync(linkPath)) {
            symlinkSync(target, linkPath, 'dir');
            console.log(`  Symlink: ${name} -> packages/${pkg}`);
          }
        }
      } catch {
        // Skip if package.json is malformed
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry scripts
// ---------------------------------------------------------------------------

function createEntryScripts(config: ServerBuildConfig): void {
  const { outputDir } = config;
  const binDir = join(outputDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // bin/craft-server — main entry wrapper
  const craftServer = `#!/bin/sh
set -e

# Resolve the distribution root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

# Set environment for resource resolution
export CRAFT_BUNDLED_ASSETS_ROOT="$ROOT"
export CRAFT_IS_PACKAGED=true
export CRAFT_APP_ROOT="$ROOT"
export CRAFT_RESOURCES_PATH="$ROOT/resources"

# CLI tools (doc tools use uv + Python scripts)
export CRAFT_UV="$ROOT/resources/bin/uv"
export CRAFT_SCRIPTS="$ROOT/resources/scripts"

# Prepend resource bin to PATH (makes doc tool wrappers available)
export PATH="$ROOT/resources/bin:$ROOT/vendor/bun:$PATH"

# Use bundled Bun runtime
exec "$ROOT/vendor/bun/bun" run "$ROOT/packages/server/src/index.ts" "$@"
`;
  writeFileSync(join(binDir, 'craft-server'), craftServer);

  // start.sh — convenience entry
  const startSh = `#!/bin/sh
# Qwen Code Server — convenience entry point
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/bin/craft-server" "$@"
`;
  writeFileSync(join(outputDir, 'start.sh'), startSh);

  // install.sh — setup + optional systemd
  const installSh = `#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Qwen Code Server Setup ==="
echo ""

# Make binaries executable
chmod +x "$DIR/bin/craft-server" "$DIR/start.sh"
[ -f "$DIR/vendor/bun/bun" ] && chmod +x "$DIR/vendor/bun/bun"
[ -f "$DIR/resources/bin/uv" ] && chmod +x "$DIR/resources/bin/uv"

# Make doc tool wrappers executable
for wrapper in "$DIR/resources/bin/"*; do
  [ -f "$wrapper" ] && chmod +x "$wrapper"
done

echo "Binaries configured."

# Generate token if not set
if [ -z "\${CRAFT_SERVER_TOKEN:-}" ]; then
  TOKEN=\$(openssl rand -hex 32)
  cat > "$DIR/.env" <<ENVFILE
CRAFT_SERVER_TOKEN=$TOKEN

# TLS — uncomment and set paths to enable wss://
# CRAFT_RPC_TLS_CERT=/path/to/cert.pem
# CRAFT_RPC_TLS_KEY=/path/to/key.pem
# CRAFT_RPC_TLS_CA=/path/to/ca.pem
ENVFILE
  echo ""
  echo "Generated server token (saved to $DIR/.env)"
else
  TOKEN="\$CRAFT_SERVER_TOKEN"
  echo ""
  echo "Using CRAFT_SERVER_TOKEN from environment."
fi

# Systemd installation
if [ "\${1:-}" = "--systemd" ]; then
  if [ "\$(id -u)" -ne 0 ]; then
    echo "Error: --systemd requires root. Run with sudo."
    exit 1
  fi

  SERVICE_USER="\${CRAFT_USER:-\$(logname 2>/dev/null || echo craft)}"
  SERVICE_FILE="/etc/systemd/system/craft-server.service"

  cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Qwen Code Server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
Environment=CRAFT_RPC_HOST=127.0.0.1
Environment=CRAFT_RPC_PORT=9100
ExecStart=$DIR/bin/craft-server
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable craft-server

  echo ""
  echo "Systemd service installed."
  echo "  Start:   sudo systemctl start craft-server"
  echo "  Status:  sudo systemctl status craft-server"
  echo "  Logs:    journalctl -u craft-server -f"
  echo ""
  exit 0
fi

echo ""
echo "Quick start:"
echo "  CRAFT_SERVER_TOKEN=$TOKEN $DIR/start.sh"
echo ""
echo "Or with systemd:"
echo "  sudo $DIR/install.sh --systemd"
echo ""
`;
  writeFileSync(join(outputDir, 'install.sh'), installSh);

  // Make scripts executable at build time
  for (const script of [
    join(binDir, 'craft-server'),
    join(outputDir, 'start.sh'),
    join(outputDir, 'install.sh'),
  ]) {
    chmodSync(script, 0o755);
  }
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

function createDockerFiles(config: ServerBuildConfig): void {
  const { outputDir, version } = config;

  const dockerfile = `FROM oven/bun:1.3-slim

WORKDIR /app

# Copy pre-assembled server distribution
COPY . .

# Make binaries executable
RUN chmod +x bin/craft-server vendor/bun/bun resources/bin/uv && \\
    for f in resources/bin/*; do [ -f "$f" ] && chmod +x "$f"; done

ENV CRAFT_IS_PACKAGED=true
ENV CRAFT_BUNDLED_ASSETS_ROOT=/app
ENV CRAFT_APP_ROOT=/app
ENV CRAFT_RESOURCES_PATH=/app/resources
ENV CRAFT_UV=/app/resources/bin/uv
ENV CRAFT_SCRIPTS=/app/resources/scripts
ENV CRAFT_RPC_HOST=0.0.0.0
ENV CRAFT_RPC_PORT=9100
ENV PATH="/app/resources/bin:/app/vendor/bun:\${PATH}"

EXPOSE 9100

ENTRYPOINT ["/app/bin/craft-server"]
`;
  writeFileSync(join(outputDir, 'Dockerfile'), dockerfile);

  const dockerCompose = `version: "3.8"
services:
  craft-server:
    build: .
    ports:
      - "9100:9100"
    environment:
      - CRAFT_SERVER_TOKEN=\${CRAFT_SERVER_TOKEN:?Set CRAFT_SERVER_TOKEN}
      - CRAFT_RPC_PORT=9100
      # TLS — uncomment to enable wss://
      # - CRAFT_RPC_TLS_CERT=/certs/cert.pem
      # - CRAFT_RPC_TLS_KEY=/certs/key.pem
    volumes:
      - craft-data:/root/.craft-agent
      # TLS — mount cert directory
      # - ./certs:/certs:ro
    restart: unless-stopped

volumes:
  craft-data:
`;
  writeFileSync(join(outputDir, 'docker-compose.yml'), dockerCompose);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      platform: { type: 'string', default: process.platform },
      arch: { type: 'string', default: process.arch === 'arm64' ? 'arm64' : 'x64' },
      output: { type: 'string', default: 'dist/server' },
      compress: { type: 'boolean', default: false },
      'skip-download': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    showHelp();
    process.exit(0);
  }

  const platform = values.platform as ServerPlatform;
  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`Unsupported platform: ${platform}. Use darwin or linux.`);
    process.exit(1);
  }

  const arch = values.arch as Arch;
  if (arch !== 'x64' && arch !== 'arm64') {
    console.error(`Unsupported arch: ${arch}. Use x64 or arm64.`);
    process.exit(1);
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptDir);
  const electronDir = join(rootDir, 'apps', 'electron');

  if (!existsSync(join(rootDir, 'package.json'))) {
    console.error('Must run from the repository root');
    process.exit(1);
  }

  // Read version from electron package.json
  const electronPkg = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf-8'));
  const version: string = electronPkg.version;

  const outputDir = join(rootDir, values.output!);

  const config: ServerBuildConfig = {
    platform,
    arch,
    rootDir,
    electronDir,
    outputDir,
    compress: values.compress ?? false,
    skipDownload: values['skip-download'] ?? false,
    version,
  };

  console.log(`=== Building Qwen Code Server ${version} for ${platform}-${arch} ===`);
  console.log(`  Output: ${outputDir}`);

  // Step 1: Clean
  console.log('\n[1/8] Cleaning output directory...');
  if (existsSync(outputDir)) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  // Step 2: Download Bun runtime
  console.log(`\n[2/8] Downloading Bun ${BUN_VERSION}...`);
  await downloadBunForServer(config);

  // Step 3: Download uv
  console.log(`\n[3/8] Downloading uv ${UV_VERSION}...`);
  await downloadUvForServer(config);

  // Step 4: Build MCP servers
  console.log('\n[4/8] Building MCP servers...');
  const buildConfig: BuildConfig = {
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir,
    electronDir,
  };
  buildMcpServers(buildConfig);

  // Build the WhatsApp worker bundle. Must happen before copyWorkspacePackages
  // so dist/worker.cjs exists when we copy the messaging-whatsapp-worker package.
  // The bundle embeds Baileys + transitive deps; see scripts/build-wa-worker.ts.
  console.log('  Building WhatsApp worker bundle...');
  await $`bun run ${join(rootDir, 'scripts', 'build-wa-worker.ts')}`.cwd(rootDir);

  // Step 5: Assemble resources
  console.log('\n[5/8] Assembling resources...');
  assembleResources(config);

  // Step 6: Copy production node_modules
  console.log('\n[6/8] Copying production dependencies...');
  copyProductionDeps(config);

  // Step 7: Copy workspace packages
  console.log('\n[7/8] Copying workspace packages...');
  copyWorkspacePackages(config);
  createRootConfig(config);

  // Step 8: Create entry scripts + Docker files
  console.log('\n[8/8] Creating entry scripts...');
  createEntryScripts(config);
  createDockerFiles(config);

  // Calculate total size
  const totalSize = getDirSize(outputDir);
  console.log(`\n  Assembly complete: ${(totalSize / 1024 / 1024).toFixed(0)} MB`);

  // Compress if requested
  if (config.compress) {
    const archiveName = `craft-server-${version}-${platform}-${arch}.tar.gz`;
    const archivePath = join(dirname(outputDir), archiveName);
    console.log(`\nCompressing to ${archiveName}...`);
    await $`tar -czf ${archivePath} -C ${outputDir} .`;
    const archiveSize = lstatSync(archivePath).size;
    console.log(`  Archive: ${(archiveSize / 1024 / 1024).toFixed(0)} MB`);
    console.log(`  Path: ${archivePath}`);
  }

  console.log('\n  Build completed successfully!');
  console.log(`\nQuick start:`);
  console.log(`  CRAFT_SERVER_TOKEN=<secret> ${outputDir}/start.sh`);
}

main();
