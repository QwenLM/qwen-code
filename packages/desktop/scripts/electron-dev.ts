/**
 * Cross-platform electron dev script
 * Replaces platform-specific npm scripts with a unified TypeScript solution
 */

import { spawn, type Subprocess } from 'bun';
import {
  existsSync,
  rmSync,
  cpSync,
  readFileSync,
  statSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';
import * as esbuild from 'esbuild';
import { downloadUv, type Platform, type Arch } from './build/common';
import { detectDevInstance, resolveDevPort } from './dev-instance';

const ROOT_DIR = join(import.meta.dir, '..');
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron');
const DIST_DIR = join(ELECTRON_DIR, 'dist');

// Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3) with
// native Node globals. esbuild otherwise renames the polyfill's `class
// AbortSignal` to `_AbortSignal` to dodge collision with the global, which
// breaks node-fetch@2's `constructor.name === 'AbortSignal'` check and fails
// every Telegram API call with a TypeError. Kept in sync with
// `apps/electron/package.json` build:main and `scripts/electron-build-main.ts`.
const MAIN_PROCESS_ALIAS: Record<string, string> = {
  'node-fetch': join(ROOT_DIR, 'apps/electron/src/main/shims/node-fetch.cjs'),
  'abort-controller': join(
    ROOT_DIR,
    'apps/electron/src/main/shims/abort-controller.cjs',
  ),
};

// MCP server paths
const SESSION_SERVER_DIR = join(ROOT_DIR, 'packages/session-mcp-server');

// Platform-specific binary paths (bun creates .exe on Windows, no extension on Unix)
const IS_WINDOWS = process.platform === 'win32';
const BIN_EXT = IS_WINDOWS ? '.exe' : '';
const VITE_BIN = join(ROOT_DIR, `node_modules/.bin/vite${BIN_EXT}`);
const ELECTRON_BIN = join(ROOT_DIR, `node_modules/.bin/electron${BIN_EXT}`);
const QWEN_VENDOR_DIR = join(ELECTRON_DIR, 'vendor', 'qwen-code');
const QWEN_VENDOR_CLI_CANDIDATES = [
  join(QWEN_VENDOR_DIR, 'dist', 'cli.js'),
  join(QWEN_VENDOR_DIR, 'cli.js'),
  join(QWEN_VENDOR_DIR, 'packages', 'cli', 'dist', 'index.js'),
];

interface DesktopPackageJson {
  qwenCodeRuntime?: {
    version?: string;
  };
}

function firstExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function readDefaultQwenCodeVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(ROOT_DIR, 'package.json'), 'utf-8'),
    ) as DesktopPackageJson;
    const version = pkg.qwenCodeRuntime?.version?.trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

function isQwenSourceRoot(root: string): boolean {
  return (
    existsSync(join(root, 'packages', 'cli', 'package.json')) &&
    existsSync(join(root, 'package.json'))
  );
}

async function ensureQwenRuntimeForDev(): Promise<void> {
  if (
    process.env.QWEN_CODE_CLI ||
    process.env.QWEN_CODE_ROOT ||
    process.env.QWEN_CODE_PATH
  ) {
    console.log('🧭 Using Qwen Code runtime override from environment');
    return;
  }

  const requestedExternalArtifact = Boolean(
    process.env.QWEN_CODE_TARBALL || process.env.QWEN_CODE_VERSION,
  );
  const monorepoRoot = join(ROOT_DIR, '..', '..');
  if (!requestedExternalArtifact && isQwenSourceRoot(monorepoRoot)) {
    console.log('🧭 Using Qwen Code CLI from the local monorepo checkout');
    return;
  }

  const vendoredCli = firstExistingPath(QWEN_VENDOR_CLI_CANDIDATES);
  if (vendoredCli && !requestedExternalArtifact) {
    process.env.QWEN_CODE_CLI = vendoredCli;
    console.log(`🧭 Using vendored Qwen Code CLI: ${vendoredCli}`);
    return;
  }

  const env = { ...(process.env as Record<string, string>) };
  if (!env.QWEN_CODE_TARBALL && !env.QWEN_CODE_VERSION) {
    const defaultVersion = readDefaultQwenCodeVersion();
    if (!defaultVersion) {
      throw new Error(
        'No Qwen Code CLI runtime configured. Set QWEN_CODE_VERSION, QWEN_CODE_TARBALL, QWEN_CODE_ROOT, or qwenCodeRuntime.version in package.json.',
      );
    }
    env.QWEN_CODE_VERSION = defaultVersion;
  }

  const sourceLabel = env.QWEN_CODE_TARBALL
    ? `tarball ${env.QWEN_CODE_TARBALL}`
    : `@qwen-code/qwen-code@${env.QWEN_CODE_VERSION}`;
  console.log(`📦 Vendoring Qwen Code CLI from ${sourceLabel}...`);

  const proc = spawn({
    cmd: ['bun', 'run', 'scripts/vendor-qwen-code.ts'],
    cwd: ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    env,
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to vendor Qwen Code CLI from ${sourceLabel}`);
  }

  const resolvedCli = firstExistingPath(QWEN_VENDOR_CLI_CANDIDATES);
  if (!resolvedCli) {
    throw new Error(`Vendored Qwen Code CLI not found in ${QWEN_VENDOR_DIR}`);
  }
  process.env.QWEN_CODE_CLI = resolvedCli;
  console.log(`🧭 Using vendored Qwen Code CLI: ${resolvedCli}`);
}

function resolveBuildPlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform for uv bootstrap: ${process.platform}`);
}

function resolveBuildArch(): Arch {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  throw new Error(`Unsupported architecture for uv bootstrap: ${process.arch}`);
}

async function ensureBundledUvForCurrentPlatform(): Promise<void> {
  const platform = resolveBuildPlatform();
  const arch = resolveBuildArch();
  const platformKey = `${platform}-${arch}`;
  const uvBinary = platform === 'win32' ? 'uv.exe' : 'uv';
  const uvPath = join(ELECTRON_DIR, 'resources', 'bin', platformKey, uvBinary);

  if (existsSync(uvPath)) {
    console.log(`✅ Bundled uv present: ${uvPath}`);
    return;
  }

  console.log(`⬇️  Bundled uv missing, bootstrapping ${platformKey}...`);
  await downloadUv({
    platform,
    arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  });
}

// Multi-instance detection.
// 1. Explicit numbered folders still map craft-agents-1 → ~/.craft-agent-1.
// 2. Linked git worktrees get stable path-derived instances automatically.
function detectInstance(): void {
  const instance = detectDevInstance(ROOT_DIR);
  if (!instance) return;

  process.env.CRAFT_INSTANCE_NUMBER ||= instance.instanceNumber;
  process.env.CRAFT_VITE_PORT ||= String(instance.resolvePort(5173));
  process.env.CRAFT_APP_NAME ||= instance.appName;
  if (instance.configDir) {
    process.env.CRAFT_CONFIG_DIR ||= instance.configDir;
  }
  process.env.CRAFT_USER_DATA_DIR ||= instance.userDataDir;
  process.env.CRAFT_SERVER_LOCK_FILE ||= instance.serverLockFile;
  process.env.CRAFT_DEEPLINK_SCHEME ||= instance.deeplinkScheme;

  const configDir = process.env.CRAFT_CONFIG_DIR || '~/.craft-agent';
  console.log(
    `🔢 ${instance.source} detected (${instance.label}): ` +
      `port=${process.env.CRAFT_VITE_PORT}, app="${process.env.CRAFT_APP_NAME}", ` +
      `config=${configDir}, userData=${process.env.CRAFT_USER_DATA_DIR}`,
  );
}

// Load .env file if it exists
function loadEnvFile(): void {
  const envPath = join(ROOT_DIR, '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          // Remove surrounding quotes if present
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          ) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
    }
    console.log('📄 Loaded .env file');
  }
}

// Kill any process listening on the specified port.
// `lsof -ti:<port>` also returns clients connected to that port; in dev that
// can include Electron renderer helpers connected to Vite's websocket.
async function killProcessOnPort(port: string): Promise<void> {
  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      // Windows: use netstat to find listening PIDs, then taskkill
      const netstat = spawn({
        cmd: ['cmd', '/c', `netstat -ano -p tcp | findstr :${port}`],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(netstat.stdout).text();
      await netstat.exited;

      // Parse PIDs from netstat output (last column)
      const pids = new Set<string>();
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const localAddress = parts[1];
          const state = parts[3]?.toUpperCase();
          const pid = parts[parts.length - 1];
          const isListeningOnPort =
            localAddress?.endsWith(`:${port}`) && state === 'LISTENING';
          if (isListeningOnPort && pid && /^\d+$/.test(pid) && pid !== '0') {
            pids.add(pid);
          }
        }
      }

      // Kill each PID
      for (const pid of pids) {
        const kill = spawn({
          cmd: ['taskkill', '/PID', pid, '/F'],
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await kill.exited;
      }

      if (pids.size > 0) {
        console.log(`🔪 Killed ${pids.size} process(es) on port ${port}`);
      }
    } else {
      // Mac/Linux: use lsof and kill only listeners, not Vite websocket clients.
      const killListeningPidScript = [
        'pids=$(lsof -tiTCP:$1 -sTCP:LISTEN 2>/dev/null || true)',
        'if [ -n "$pids" ]; then',
        'kill -9 $pids 2>/dev/null || true',
        'printf \'%s\\n\' "$pids"',
        'fi',
      ].join('; ');
      const lsof = spawn({
        cmd: ['sh', '-c', killListeningPidScript, 'sh', port],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(lsof.stdout).text();
      await lsof.exited;

      if (output.trim()) {
        console.log(`🔪 Killed process(es) on port ${port}`);
      }
    }
  } catch {
    // Ignore errors - port may not be in use
  }
}

// Clean Vite cache directory
function cleanViteCache(): void {
  const viteCacheDir = join(ELECTRON_DIR, 'node_modules/.vite');
  if (existsSync(viteCacheDir)) {
    rmSync(viteCacheDir, { recursive: true, force: true });
    console.log('🧹 Cleaned Vite cache');
  }
}

// Copy resources to dist
function copyResources(): void {
  const srcDir = join(ELECTRON_DIR, 'resources');
  const destDir = join(ELECTRON_DIR, 'dist/resources');
  if (existsSync(srcDir)) {
    cpSync(srcDir, destDir, { recursive: true, force: true });
    console.log('📦 Copied resources to dist');
  }
}

// Build the WhatsApp worker bundle (dist/worker.cjs). Runs the canonical
// `scripts/build-wa-worker.ts` as a subprocess so the dev path stays in
// sync with the packaged/CI build. Cheap (~70ms) so we always rebuild.
async function buildWaWorker(): Promise<void> {
  console.log('📨 Building WhatsApp worker...');
  const proc = spawn({
    cmd: ['bun', 'run', 'scripts/build-wa-worker.ts'],
    cwd: ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error('❌ WhatsApp worker build failed');
    process.exit(1);
  }
}

// Build MCP servers for agent sessions (one-time, no watch needed)
async function buildMcpServers(): Promise<void> {
  console.log('🌉 Building MCP servers...');

  // Ensure dist directories exist
  const sessionDistDir = join(SESSION_SERVER_DIR, 'dist');
  if (!existsSync(sessionDistDir))
    mkdirSync(sessionDistDir, { recursive: true });

  // Build session MCP server (esbuild, packages external — deps resolve from root node_modules)
  const sessionResult = await runEsbuild(
    'packages/session-mcp-server/src/index.ts',
    'packages/session-mcp-server/dist/index.js',
    {},
    { packagesExternal: true },
  );

  if (!sessionResult.success) {
    console.error('❌ Session MCP server build failed:', sessionResult.error);
    process.exit(1);
  }
  console.log('✅ Session MCP server built');
}

// Get OAuth defines for esbuild API
function getOAuthDefines(): Record<string, string> {
  const oauthVars = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'SLACK_OAUTH_CLIENT_ID',
    'SLACK_OAUTH_CLIENT_SECRET',
    'MICROSOFT_OAUTH_CLIENT_ID',
    'MICROSOFT_OAUTH_CLIENT_SECRET',
  ];

  const defines: Record<string, string> = {};
  for (const varName of oauthVars) {
    const value = process.env[varName] || '';
    defines[`process.env.${varName}`] = JSON.stringify(value);
  }
  return defines;
}

// Get environment variables for electron process
function getElectronEnv(): Record<string, string> {
  const vitePort = String(
    resolveDevPort(ROOT_DIR, 5173, 'CRAFT_VITE_PORT').port,
  );

  // Codex binary path is resolved at runtime by the binary-resolver module.
  // It checks: CODEX_PATH env var > bundled binary > local dev fork > system PATH.
  // You can override with CODEX_PATH env var if needed for debugging.

  return {
    ...(process.env as Record<string, string>),
    VITE_DEV_SERVER_URL: `http://localhost:${vitePort}`,
    CRAFT_CONFIG_DIR: process.env.CRAFT_CONFIG_DIR || '',
    CRAFT_USER_DATA_DIR: process.env.CRAFT_USER_DATA_DIR || '',
    CRAFT_SERVER_LOCK_FILE: process.env.CRAFT_SERVER_LOCK_FILE || '',
    CRAFT_APP_NAME: process.env.CRAFT_APP_NAME || 'Qwen Code',
    CRAFT_DEEPLINK_SCHEME: process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents',
    CRAFT_INSTANCE_NUMBER: process.env.CRAFT_INSTANCE_NUMBER || '',
  };
}

// Run a one-shot esbuild using the JavaScript API
async function runEsbuild(
  entryPoint: string,
  outfile: string,
  defines: Record<string, string> = {},
  options: { packagesExternal?: boolean; alias?: Record<string, string> } = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    await esbuild.build({
      entryPoints: [join(ROOT_DIR, entryPoint)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: join(ROOT_DIR, outfile),
      external: ['electron'],
      ...(options.packagesExternal ? { packages: 'external' as const } : {}),
      ...(options.alias ? { alias: options.alias } : {}),
      define: defines,
      logLevel: 'warning',
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Verify a built JavaScript bundle is parseable. `node --check` performs
// syntax-only validation — it does NOT execute module-level code or resolve
// `require()`, so Electron-specific top-level requires (e.g. @sentry/electron)
// are safe. This catches truncated writes, FS corruption, and edge cases that
// esbuild's build-success signal doesn't cover.
async function verifyJsFile(
  filePath: string,
): Promise<{ valid: boolean; error?: string }> {
  if (!existsSync(filePath)) {
    return { valid: false, error: 'File does not exist' };
  }

  const stats = statSync(filePath);
  if (stats.size === 0) {
    return { valid: false, error: 'File is empty' };
  }

  try {
    const proc = spawn({
      cmd: ['node', '--check', filePath],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return {
        valid: false,
        error: stderr.trim() || `node --check exited ${exitCode}`,
      };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// Wait for file to stabilize (no size changes)
async function waitForFileStable(
  filePath: string,
  timeoutMs = 10000,
): Promise<boolean> {
  const startTime = Date.now();
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    if (!existsSync(filePath)) {
      await Bun.sleep(100);
      continue;
    }

    const stats = statSync(filePath);
    if (stats.size === lastSize) {
      stableCount++;
      // File size unchanged for 3 checks (300ms) - consider it stable
      if (stableCount >= 3) {
        return true;
      }
    } else {
      stableCount = 0;
      lastSize = stats.size;
    }

    await Bun.sleep(100);
  }

  return false;
}

async function main(): Promise<void> {
  console.log('🚀 Starting Electron dev environment...\n');

  // Setup
  detectInstance();
  loadEnvFile();
  cleanViteCache();

  // Ensure dist directory exists
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  await ensureBundledUvForCurrentPlatform();
  await ensureQwenRuntimeForDev();

  copyResources();

  // Build MCP servers for Codex sessions
  await buildMcpServers();

  // Build WhatsApp worker bundle so the adapter can spawn it on demand
  await buildWaWorker();

  const vitePort = String(
    resolveDevPort(ROOT_DIR, 5173, 'CRAFT_VITE_PORT').port,
  );
  process.env.CRAFT_VITE_PORT ||= vitePort;
  const oauthDefines = getOAuthDefines();

  // Kill any existing process on the Vite port
  await killProcessOnPort(vitePort);

  // =========================================================
  // PHASE 1: Initial build (one-shot, wait for completion)
  // =========================================================
  console.log('🔨 Building main process...');

  const mainCjsPath = join(DIST_DIR, 'main.cjs');
  const preloadCjsPath = join(DIST_DIR, 'bootstrap-preload.cjs');
  const toolbarPreloadCjsPath = join(DIST_DIR, 'browser-toolbar-preload.cjs');

  // Remove old build files to ensure fresh build
  if (existsSync(mainCjsPath)) rmSync(mainCjsPath);
  if (existsSync(preloadCjsPath)) rmSync(preloadCjsPath);
  if (existsSync(toolbarPreloadCjsPath)) rmSync(toolbarPreloadCjsPath);

  // Build main and preload entries in parallel
  const [mainResult, preloadResult, toolbarPreloadResult] = await Promise.all([
    runEsbuild(
      'apps/electron/src/main/index.ts',
      'apps/electron/dist/main.cjs',
      oauthDefines,
      { alias: MAIN_PROCESS_ALIAS },
    ),
    runEsbuild(
      'apps/electron/src/preload/bootstrap.ts',
      'apps/electron/dist/bootstrap-preload.cjs',
    ),
    runEsbuild(
      'apps/electron/src/preload/browser-toolbar.ts',
      'apps/electron/dist/browser-toolbar-preload.cjs',
    ),
  ]);

  if (!mainResult.success) {
    console.error('❌ Main process build failed:', mainResult.error);
    process.exit(1);
  }

  if (!preloadResult.success) {
    console.error('❌ Preload build failed:', preloadResult.error);
    process.exit(1);
  }

  if (!toolbarPreloadResult.success) {
    console.error(
      '❌ Browser toolbar preload build failed:',
      toolbarPreloadResult.error,
    );
    process.exit(1);
  }

  // Wait for files to stabilize (filesystem flush)
  console.log('⏳ Waiting for build files to stabilize...');
  const [mainStable, preloadStable, toolbarPreloadStable] = await Promise.all([
    waitForFileStable(mainCjsPath),
    waitForFileStable(preloadCjsPath),
    waitForFileStable(toolbarPreloadCjsPath),
  ]);

  if (!mainStable || !preloadStable || !toolbarPreloadStable) {
    console.error('❌ Build files did not stabilize');
    process.exit(1);
  }

  // Verify the built files are valid JavaScript
  console.log('🔍 Verifying build output...');
  const [mainValid, preloadValid, toolbarPreloadValid] = await Promise.all([
    verifyJsFile(mainCjsPath),
    verifyJsFile(preloadCjsPath),
    verifyJsFile(toolbarPreloadCjsPath),
  ]);

  if (!mainValid.valid) {
    console.error('❌ main.cjs is invalid:', mainValid.error);
    process.exit(1);
  }

  if (!preloadValid.valid) {
    console.error('❌ bootstrap-preload.cjs is invalid:', preloadValid.error);
    process.exit(1);
  }

  if (!toolbarPreloadValid.valid) {
    console.error(
      '❌ browser-toolbar-preload.cjs is invalid:',
      toolbarPreloadValid.error,
    );
    process.exit(1);
  }

  console.log('✅ Initial build complete and verified\n');

  // =========================================================
  // PHASE 2: Start dev servers with watch mode
  // =========================================================
  console.log('📡 Starting dev servers...\n');

  const processes: Subprocess[] = [];
  const esbuildContexts: esbuild.BuildContext[] = [];

  // 1. Vite dev server (strictPort ensures we don't silently switch ports)
  const viteProc = spawn({
    cmd: [
      VITE_BIN,
      'dev',
      '--config',
      'apps/electron/vite.config.ts',
      '--port',
      vitePort,
      '--strictPort',
    ],
    cwd: ROOT_DIR,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env as Record<string, string>,
  });
  processes.push(viteProc);

  // 2. Main process watcher (using esbuild watch API)
  const mainContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, 'apps/electron/src/main/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(ROOT_DIR, 'apps/electron/dist/main.cjs'),
    external: ['electron'],
    alias: MAIN_PROCESS_ALIAS,
    define: oauthDefines,
    logLevel: 'info',
  });
  await mainContext.watch();
  esbuildContexts.push(mainContext);
  console.log('👀 Watching main process...');

  // 3. Preload watcher (using esbuild watch API)
  const preloadContext = await esbuild.context({
    entryPoints: [join(ROOT_DIR, 'apps/electron/src/preload/bootstrap.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(ROOT_DIR, 'apps/electron/dist/bootstrap-preload.cjs'),
    external: ['electron'],
    logLevel: 'info',
  });
  await preloadContext.watch();
  esbuildContexts.push(preloadContext);
  console.log('👀 Watching preload...');

  // 4. Browser toolbar preload watcher (dedicated browser window bridge)
  const toolbarPreloadContext = await esbuild.context({
    entryPoints: [
      join(ROOT_DIR, 'apps/electron/src/preload/browser-toolbar.ts'),
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(ROOT_DIR, 'apps/electron/dist/browser-toolbar-preload.cjs'),
    external: ['electron'],
    logLevel: 'info',
  });
  await toolbarPreloadContext.watch();
  esbuildContexts.push(toolbarPreloadContext);
  console.log('👀 Watching browser toolbar preload...');

  // 5. Start Electron (build already verified)
  console.log('🚀 Starting Electron...\n');

  const electronProc = spawn({
    cmd: [ELECTRON_BIN, 'apps/electron'],
    cwd: ROOT_DIR,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: getElectronEnv(),
  });
  processes.push(electronProc);

  // Handle cleanup on exit
  const cleanup = async () => {
    console.log('\n🛑 Shutting down...');
    // Dispose esbuild contexts
    for (const ctx of esbuildContexts) {
      try {
        await ctx.dispose();
      } catch {
        // Context may already be disposed
      }
    }
    // Kill subprocesses
    for (const proc of processes) {
      try {
        proc.kill();
      } catch {
        // Process may already be dead
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => cleanup());
  process.on('SIGTERM', () => cleanup());

  // Windows doesn't have SIGINT/SIGTERM in the same way
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => cleanup());
  }

  // Wait for electron to exit (main process)
  await electronProc.exited;
  await cleanup();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
