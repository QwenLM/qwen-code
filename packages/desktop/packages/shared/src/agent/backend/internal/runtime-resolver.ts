import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { BackendHostRuntimeContext } from '../types.ts';

export interface ResolvedBackendRuntimePaths {
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function qwenSourceCliCandidates(root: string): string[] {
  return [
    join(root, 'scripts', 'dev.js'),
    join(root, 'dist', 'cli.js'),
    join(root, 'cli.js'),
    join(root, 'packages', 'cli', 'dist', 'index.js'),
  ];
}

function isQwenSourceRoot(root: string): boolean {
  return (
    existsSync(join(root, 'packages', 'cli', 'package.json')) &&
    existsSync(join(root, 'packages', 'desktop', 'package.json'))
  );
}

function resolveQwenSourceCliFromAncestors(
  base: string,
  maxLevels = 10,
): { path?: string; foundSourceRoot: boolean } {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    if (isQwenSourceRoot(dir)) {
      return {
        path: firstExistingPath(qwenSourceCliCandidates(dir)),
        foundSourceRoot: true,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { foundSourceRoot: false };
}

function resolveQwenCliOverride(): string | undefined {
  const override =
    process.env.QWEN_CODE_CLI ||
    process.env.QWEN_CODE_PATH ||
    process.env.QWEN_CODE_ROOT;
  if (!override || !existsSync(override)) return undefined;
  if (isDirectory(override)) {
    return firstExistingPath(qwenSourceCliCandidates(override));
  }
  return override;
}

function resolveUpwards(
  base: string,
  relativePath: string,
  maxLevels = 4,
): string | undefined {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function resolveBundledRuntimePath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const bunBasePath =
    process.platform === 'win32'
      ? hostRuntime.resourcesPath || hostRuntime.appRootPath
      : hostRuntime.appRootPath;
  const bunPath = join(bunBasePath, 'vendor', 'bun', bunBinary);
  if (existsSync(bunPath)) return bunPath;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemBun = execFileSync(whichCmd, ['bun'], {
        encoding: 'utf-8',
      }).trim();
      if (systemBun && existsSync(systemBun)) return systemBun;
    } catch {
      // System runtime not found.
    }
  }
  return undefined;
}

function resolveNodeRuntimePath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  if (hostRuntime.nodeRuntimePath && existsSync(hostRuntime.nodeRuntimePath)) {
    return hostRuntime.nodeRuntimePath;
  }

  const nodeBinary = process.platform === 'win32' ? 'node.exe' : 'node';
  const nodeBasePath =
    process.platform === 'win32'
      ? hostRuntime.resourcesPath || hostRuntime.appRootPath
      : hostRuntime.appRootPath;
  const nodePath =
    process.platform === 'win32'
      ? join(nodeBasePath, 'vendor', 'node', nodeBinary)
      : join(nodeBasePath, 'vendor', 'node', 'bin', nodeBinary);
  if (existsSync(nodePath)) return nodePath;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemNode = execFileSync(whichCmd, ['node'], {
        encoding: 'utf-8',
      }).trim();
      if (systemNode && existsSync(systemNode)) return systemNode;
    } catch {
      // System Node runtime not found.
    }
  }

  return undefined;
}

function resolveQwenCliPath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  const envOverride = resolveQwenCliOverride();
  if (envOverride) return envOverride;

  const packagedCliRelative = join('vendor', 'qwen-code', 'dist', 'cli.js');
  const packagedRootCliRelative = join('vendor', 'qwen-code', 'cli.js');
  const packagedIndexRelative = join(
    'vendor',
    'qwen-code',
    'packages',
    'cli',
    'dist',
    'index.js',
  );
  const packagedCandidates = [
    join(hostRuntime.appRootPath, packagedCliRelative),
    join(hostRuntime.appRootPath, packagedRootCliRelative),
    join(hostRuntime.appRootPath, packagedIndexRelative),
    join(hostRuntime.appRootPath, 'apps', 'electron', packagedCliRelative),
    join(hostRuntime.appRootPath, 'apps', 'electron', packagedRootCliRelative),
    join(hostRuntime.appRootPath, 'apps', 'electron', packagedIndexRelative),
    ...(hostRuntime.resourcesPath
      ? [
          join(hostRuntime.resourcesPath, 'app', packagedCliRelative),
          join(hostRuntime.resourcesPath, 'app', packagedRootCliRelative),
          join(hostRuntime.resourcesPath, 'app', packagedIndexRelative),
        ]
      : []),
  ];

  if (hostRuntime.isPackaged) {
    return firstExistingPath(packagedCandidates);
  }

  const packageCliRelative = join(
    'node_modules',
    '@qwen-code',
    'qwen-code',
    'dist',
    'cli.js',
  );
  const packageRootCliRelative = join(
    'node_modules',
    '@qwen-code',
    'qwen-code',
    'cli.js',
  );
  const packageIndexRelative = join(
    'node_modules',
    '@qwen-code',
    'qwen-code',
    'packages',
    'cli',
    'dist',
    'index.js',
  );
  const appRootCheckout = resolveQwenSourceCliFromAncestors(
    hostRuntime.appRootPath,
  );
  const cwdCheckout = resolveQwenSourceCliFromAncestors(process.cwd());
  const currentCheckoutCli = appRootCheckout.path ?? cwdCheckout.path;
  if (currentCheckoutCli) return currentCheckoutCli;

  if (appRootCheckout.foundSourceRoot || cwdCheckout.foundSourceRoot) {
    return undefined;
  }

  const fromHostRoot = firstExistingPath([
    ...packagedCandidates,
    join(hostRuntime.appRootPath, packageCliRelative),
    join(hostRuntime.appRootPath, packageRootCliRelative),
    join(hostRuntime.appRootPath, packageIndexRelative),
    join(hostRuntime.appRootPath, '..', '..', packageCliRelative),
    join(hostRuntime.appRootPath, '..', '..', packageRootCliRelative),
    join(hostRuntime.appRootPath, '..', '..', packageIndexRelative),
  ]);
  if (fromHostRoot) return fromHostRoot;

  const walked =
    resolveUpwards(hostRuntime.appRootPath, packageCliRelative, 10) ??
    resolveUpwards(hostRuntime.appRootPath, packageRootCliRelative, 10) ??
    resolveUpwards(hostRuntime.appRootPath, packageIndexRelative, 10);
  if (walked) return walked;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemQwen = execFileSync(whichCmd, ['qwen'], {
        encoding: 'utf-8',
      }).trim();
      if (systemQwen && existsSync(systemQwen)) return systemQwen;
    } catch {
      // System Qwen CLI not found.
    }
  }

  return undefined;
}

function resolveRipgrepPath(
  hostRuntime: BackendHostRuntimeContext,
): string | undefined {
  const packaged = join(
    hostRuntime.appRootPath,
    'vendor',
    'ripgrep',
    process.platform === 'win32' ? 'rg.exe' : 'rg',
  );
  if (hostRuntime.isPackaged && existsSync(packaged)) return packaged;

  if (!hostRuntime.isPackaged) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemRg = execFileSync(whichCmd, ['rg'], {
        encoding: 'utf-8',
      }).trim();
      if (systemRg && existsSync(systemRg)) return systemRg;
    } catch {
      // System ripgrep not found.
    }
  }

  return undefined;
}

export function resolveBackendRuntimePaths(
  hostRuntime: BackendHostRuntimeContext,
): ResolvedBackendRuntimePaths {
  const bundledRuntimePath = resolveBundledRuntimePath(hostRuntime);

  return {
    qwenCliPath: resolveQwenCliPath(hostRuntime),
    nodeRuntimePath:
      resolveNodeRuntimePath(hostRuntime) ||
      bundledRuntimePath ||
      process.execPath,
    bundledRuntimePath,
  };
}

export function resolveBackendHostTooling(
  hostRuntime: BackendHostRuntimeContext,
): ResolvedBackendHostTooling {
  return {
    ripgrepPath: resolveRipgrepPath(hostRuntime),
  };
}
