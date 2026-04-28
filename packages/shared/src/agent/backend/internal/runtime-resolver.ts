import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { BackendHostRuntimeContext } from '../types.ts';
import {
  setExecutable,
  setInterceptorPath,
  setPathToClaudeCodeExecutable,
} from '../../options.ts';

/**
 * When set, the resolver walks further up from the .app bundle to find SDK,
 * interceptor, and bun in the monorepo / on the system PATH.
 * Intended for local `electron:dist:mac` builds that skip `build-dmg.sh`.
 */
const IS_DEV_RUNTIME = !!process.env.CRAFT_DEV_RUNTIME;

export interface ResolvedBackendRuntimePaths {
  claudeCliPath?: string;
  claudeInterceptorPath?: string;
  interceptorBundlePath?: string;
  copilotCliPath?: string;
  sessionServerPath?: string;
  bridgeServerPath?: string;
  piServerPath?: string;
  qwenCliPath?: string;
  nodeRuntimePath?: string;
  bundledRuntimePath?: string;
}

export interface ResolvedBackendHostTooling {
  ripgrepPath?: string;
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Walk up from `base` checking `join(ancestor, relativePath)` at each level.
 * Stops after `maxLevels` ancestors or when hitting the filesystem root.
 */
function resolveUpwards(base: string, relativePath: string, maxLevels = 4): string | undefined {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

function resolveBundledRuntimePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunBasePath = process.platform === 'win32'
    ? (hostRuntime.resourcesPath || hostRuntime.appRootPath)
    : hostRuntime.appRootPath;
  const bunPath = join(bunBasePath, 'vendor', 'bun', bunBinary);
  if (existsSync(bunPath)) return bunPath;

  // Non-packaged (headless server, dev mode): fall back to system bun via PATH.
  // Packaged apps must ship their own bundled bun — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemBun = execFileSync(whichCmd, ['bun'], { encoding: 'utf-8' }).trim();
      if (systemBun && existsSync(systemBun)) return systemBun;
    } catch { /* system bun not found */ }
  }
  return undefined;
}

function resolveClaudeCliPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const sdkRelative = join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js');
  const result = firstExistingPath([
    join(hostRuntime.appRootPath, sdkRelative),
    join(hostRuntime.appRootPath, '..', '..', sdkRelative),
  ]);
  if (result) return result;

  // Dev runtime: walk further up from .app bundle to reach monorepo root
  if (IS_DEV_RUNTIME) {
    return resolveUpwards(hostRuntime.appRootPath, sdkRelative, 10);
  }
  return undefined;
}

function resolveClaudeInterceptorPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const interceptorRelative = join('packages', 'shared', 'src', 'unified-network-interceptor.ts');
  const result = firstExistingPath([
    join(hostRuntime.appRootPath, interceptorRelative),
    join(hostRuntime.appRootPath, '..', '..', interceptorRelative),
  ]);
  if (result) return result;

  // Dev runtime: walk further up from .app bundle to reach monorepo root
  if (IS_DEV_RUNTIME) {
    return resolveUpwards(hostRuntime.appRootPath, interceptorRelative, 10);
  }
  return undefined;
}

function resolveInterceptorBundlePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  if (hostRuntime.interceptorBundlePath && existsSync(hostRuntime.interceptorBundlePath)) {
    return hostRuntime.interceptorBundlePath;
  }

  return resolveUpwards(hostRuntime.appRootPath, join('dist', 'interceptor.cjs'))
    ?? resolveUpwards(hostRuntime.appRootPath, join('apps', 'electron', 'dist', 'interceptor.cjs'));
}

function resolveCopilotCliPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const platform = process.platform === 'win32'
    ? 'win32'
    : process.platform === 'linux'
      ? 'linux'
      : 'darwin';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const binaryName = platform === 'win32' ? 'copilot.exe' : 'copilot';

  if (hostRuntime.isPackaged) {
    const packaged = join(hostRuntime.appRootPath, 'vendor', 'copilot', `${platform}-${arch}`, binaryName);
    return existsSync(packaged) ? packaged : undefined;
  }

  return resolveUpwards(
    hostRuntime.appRootPath,
    join('node_modules', '@github', `copilot-${platform}-${arch}`, binaryName),
  );
}

function resolveServerPath(hostRuntime: BackendHostRuntimeContext, serverName: string): string | undefined {
  if (hostRuntime.isPackaged) {
    return firstExistingPath([
      join(hostRuntime.appRootPath, 'resources', serverName, 'index.js'),
      join(hostRuntime.appRootPath, 'dist', 'resources', serverName, 'index.js'),
    ]);
  }
  return resolveUpwards(
    hostRuntime.appRootPath,
    join('packages', serverName, 'dist', 'index.js'),
  );
}

function resolveQwenCliPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const envOverride = process.env.QWEN_CODE_CLI || process.env.QWEN_CODE_PATH;
  if (envOverride && existsSync(envOverride)) return envOverride;

  const packageCliRelative = join('node_modules', '@qwen-code', 'qwen-code', 'dist', 'cli.js');
  const packageIndexRelative = join('node_modules', '@qwen-code', 'qwen-code', 'packages', 'cli', 'dist', 'index.js');
  const siblingCliRelative = join('..', 'qwen-code', 'dist', 'cli.js');
  const siblingIndexRelative = join('..', 'qwen-code', 'packages', 'cli', 'dist', 'index.js');

  const fromHostRoot = firstExistingPath([
    join(hostRuntime.appRootPath, packageCliRelative),
    join(hostRuntime.appRootPath, packageIndexRelative),
    join(hostRuntime.appRootPath, '..', '..', packageCliRelative),
    join(hostRuntime.appRootPath, '..', '..', packageIndexRelative),
    // Local development layout documented in docs/acp-capability-context-spec.md.
    join(hostRuntime.appRootPath, siblingCliRelative),
    join(hostRuntime.appRootPath, siblingIndexRelative),
    join(process.cwd(), siblingCliRelative),
    join(process.cwd(), siblingIndexRelative),
  ]);
  if (fromHostRoot) return fromHostRoot;

  const walked = resolveUpwards(hostRuntime.appRootPath, packageCliRelative, 10)
    ?? resolveUpwards(hostRuntime.appRootPath, packageIndexRelative, 10)
    ?? resolveUpwards(hostRuntime.appRootPath, siblingCliRelative, 10)
    ?? resolveUpwards(hostRuntime.appRootPath, siblingIndexRelative, 10);
  if (walked) return walked;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemQwen = execFileSync(whichCmd, ['qwen'], { encoding: 'utf-8' }).trim();
      if (systemQwen && existsSync(systemQwen)) return systemQwen;
    } catch { /* system qwen not found */ }
  }

  return undefined;
}

function resolveRipgrepPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const platform = process.platform === 'win32'
    ? 'x64-win32'
    : process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'arm64-darwin' : 'x64-darwin')
      : (process.arch === 'arm64' ? 'arm64-linux' : 'x64-linux');
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const ripgrepRelative = join(
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'vendor',
    'ripgrep',
    platform,
    binaryName,
  );

  if (hostRuntime.isPackaged) {
    const packaged = join(hostRuntime.appRootPath, ripgrepRelative);
    if (existsSync(packaged)) return packaged;
  }

  const fromHostRoot = resolveUpwards(hostRuntime.appRootPath, ripgrepRelative, 10);
  if (fromHostRoot) return fromHostRoot;

  const cwdFallback = join(process.cwd(), ripgrepRelative);
  if (existsSync(cwdFallback)) return cwdFallback;

  // Non-packaged (headless server, dev mode): fall back to system rg via PATH.
  // Packaged apps must use vendored binary only — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemRg = execFileSync(whichCmd, ['rg'], { encoding: 'utf-8' }).trim();
      if (systemRg && existsSync(systemRg)) return systemRg;
    } catch { /* system rg not found */ }
  }

  return undefined;
}

export function resolveBackendRuntimePaths(hostRuntime: BackendHostRuntimeContext): ResolvedBackendRuntimePaths {
  const bundledRuntimePath = hostRuntime.nodeRuntimePath || resolveBundledRuntimePath(hostRuntime);

  return {
    claudeCliPath: resolveClaudeCliPath(hostRuntime),
    claudeInterceptorPath: resolveClaudeInterceptorPath(hostRuntime),
    interceptorBundlePath: resolveInterceptorBundlePath(hostRuntime),
    copilotCliPath: resolveCopilotCliPath(hostRuntime),
    sessionServerPath: resolveServerPath(hostRuntime, 'session-mcp-server'),
    bridgeServerPath: resolveServerPath(hostRuntime, 'bridge-mcp-server'),
    piServerPath: resolveServerPath(hostRuntime, 'pi-agent-server'),
    qwenCliPath: resolveQwenCliPath(hostRuntime),
    nodeRuntimePath: hostRuntime.nodeRuntimePath || bundledRuntimePath || process.execPath,
    bundledRuntimePath,
  };
}

export function resolveBackendHostTooling(hostRuntime: BackendHostRuntimeContext): ResolvedBackendHostTooling {
  return {
    ripgrepPath: resolveRipgrepPath(hostRuntime),
  };
}

/**
 * Configure anthropic-sdk globals from host runtime context.
 * This mirrors previous Electron bootstrap behavior but keeps it behind backend internals.
 *
 * When `strict` is true (default), throws on missing SDK, interceptor, or bundled runtime.
 * When `strict` is false, sets paths opportunistically — missing paths are silently skipped.
 */
export function applyAnthropicRuntimeBootstrap(
  hostRuntime: BackendHostRuntimeContext,
  paths: ResolvedBackendRuntimePaths,
  options?: { strict?: boolean },
): void {
  const strict = options?.strict ?? true;

  if (paths.claudeCliPath) {
    setPathToClaudeCodeExecutable(paths.claudeCliPath);
  } else if (strict) {
    throw new Error('Claude Code SDK not found. The app package may be corrupted.');
  }

  if (paths.claudeInterceptorPath) {
    setInterceptorPath(paths.claudeInterceptorPath);
  } else if (strict) {
    throw new Error('Network interceptor not found. The app package may be corrupted.');
  }

  if (hostRuntime.isPackaged) {
    if (paths.bundledRuntimePath) {
      setExecutable(paths.bundledRuntimePath);
    } else if (strict) {
      throw new Error('Bundled Bun runtime not found. The app package may be corrupted.');
    }
  }
}
