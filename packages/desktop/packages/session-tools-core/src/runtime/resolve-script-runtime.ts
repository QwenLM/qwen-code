import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

export type ScriptRuntimeLanguage = 'python3' | 'node' | 'bun';

export interface ResolvedScriptRuntime {
  command: string;
  argsPrefix: string[];
  source: 'env' | 'bundled' | 'path';
}

export interface ResolveScriptRuntimeContext {
  /**
   * Whether host app is packaged. Defaults to CRAFT_IS_PACKAGED=1.
   * In packaged mode, PATH fallback is blocked by default.
   */
  isPackaged?: boolean;

  /**
   * Optional explicit app root path (usually Electron app.getAppPath()).
   */
  appRootPath?: string;

  /**
   * Optional explicit resources base used by Electron startup.
   * Typically:
   * - packaged: <process.resourcesPath>/app
   * - dev: <repo>/apps/electron
   */
  resourcesBasePath?: string;
}

function resolveBinaryOnPath(binary: string): string | null {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [binary], { encoding: 'utf8' });

  if (result.status !== 0) {
    return null;
  }

  const firstMatch = result.stdout
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  return firstMatch ?? null;
}

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolvedCandidate = resolve(candidate);
    if (existsSync(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }
  return null;
}

function getPlatformRuntimeDir(): string {
  return `${process.platform}-${process.arch}`;
}

function inferPackagedMode(ctx?: ResolveScriptRuntimeContext): boolean {
  if (typeof ctx?.isPackaged === 'boolean') return ctx.isPackaged;
  return process.env.CRAFT_IS_PACKAGED === '1';
}

function getProcessResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

function resolveResourcesBase(ctx?: ResolveScriptRuntimeContext): string | null {
  const explicit = ctx?.resourcesBasePath || process.env.CRAFT_RESOURCES_BASE;
  if (explicit) return resolve(explicit);

  const resourcesPath = getProcessResourcesPath();
  if (resourcesPath) {
    const packagedCandidate = join(resourcesPath, 'app');
    if (existsSync(packagedCandidate)) return packagedCandidate;
  }

  return null;
}

function resolveAppRoot(ctx?: ResolveScriptRuntimeContext): string | null {
  const explicit = ctx?.appRootPath || process.env.CRAFT_APP_ROOT;
  return explicit ? resolve(explicit) : null;
}

function resolveBundledUv(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'uv.exe' : 'uv';
  const platformDir = getPlatformRuntimeDir();
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  const resourcesPath = getProcessResourcesPath();

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'resources', 'bin', platformDir, binary) : '',
    appRoot ? join(appRoot, 'resources', 'bin', platformDir, binary) : '',
    resourcesPath ? join(resourcesPath, 'app', 'resources', 'bin', platformDir, binary) : '',
  ]);
}

function resolveBundledNode(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'vendor', 'node', binary) : '',
    appRoot ? join(appRoot, 'vendor', 'node', binary) : '',
  ]);
}

function resolveBundledBun(ctx?: ResolveScriptRuntimeContext): string | null {
  const binary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const resourcesBase = resolveResourcesBase(ctx);
  const appRoot = resolveAppRoot(ctx);

  return firstExistingPath([
    resourcesBase ? join(resourcesBase, 'vendor', 'bun', binary) : '',
    appRoot ? join(appRoot, 'vendor', 'bun', binary) : '',
  ]);
}

function validatePackagedEnvRuntime(command: string, label: string): string {
  const hasPathSeparator = command.includes('/') || command.includes('\\');

  if (!isAbsolute(command) && !hasPathSeparator) {
    throw new Error(
      `${label} runtime from env is not an absolute/bundled path (${command}). ` +
      'Packaged builds do not allow PATH-based runtime resolution. Configure an absolute CRAFT_* path or ship a bundled runtime.'
    );
  }

  const resolvedCommand = resolve(command);
  if (!existsSync(resolvedCommand)) {
    throw new Error(
      `${label} runtime from env does not exist: ${resolvedCommand}. ` +
      'Configure a valid absolute CRAFT_* path or ship a bundled runtime.'
    );
  }

  return resolvedCommand;
}

/**
 * Resolve runtime command and fixed argument prefix for script execution tools.
 *
 * Resolution order:
 * - env override (CRAFT_UV / CRAFT_NODE / CRAFT_BUN)
 * - bundled binary path (when available)
 * - PATH fallback (dev only)
 */
export function resolveScriptRuntime(
  language: ScriptRuntimeLanguage,
  ctx?: ResolveScriptRuntimeContext,
): ResolvedScriptRuntime {
  const isPackaged = inferPackagedMode(ctx);

  if (language === 'python3') {
    if (process.env.CRAFT_UV) {
      const cmd = isPackaged
        ? validatePackagedEnvRuntime(process.env.CRAFT_UV, 'Python/uv')
        : process.env.CRAFT_UV;

      return {
        command: cmd,
        argsPrefix: ['run', '--python', '3.12'],
        source: 'env',
      };
    }

    const bundledUv = resolveBundledUv(ctx);
    if (bundledUv) {
      return {
        command: bundledUv,
        argsPrefix: ['run', '--python', '3.12'],
        source: 'bundled',
      };
    }

    if (!isPackaged) {
      const uvPath = resolveBinaryOnPath('uv');
      if (uvPath) {
        return {
          command: uvPath,
          argsPrefix: ['run', '--python', '3.12'],
          source: 'path',
        };
      }
    }

    throw new Error(
      isPackaged
        ? 'Python runtime unavailable in packaged app: uv was not found in env or bundled resources.'
        : 'Python runtime unavailable: uv was not found. Configure CRAFT_UV or install uv on PATH.'
    );
  }

  if (language === 'node') {
    if (process.env.CRAFT_NODE) {
      const cmd = isPackaged
        ? validatePackagedEnvRuntime(process.env.CRAFT_NODE, 'Node')
        : process.env.CRAFT_NODE;
      return { command: cmd, argsPrefix: [], source: 'env' };
    }

    const bundledNode = resolveBundledNode(ctx);
    if (bundledNode) {
      return { command: bundledNode, argsPrefix: [], source: 'bundled' };
    }

    if (!isPackaged) {
      const nodePath = resolveBinaryOnPath('node');
      if (nodePath) {
        return { command: nodePath, argsPrefix: [], source: 'path' };
      }
    }

    throw new Error(
      isPackaged
        ? 'Node runtime unavailable in packaged app: node was not found in env or bundled resources.'
        : 'Node runtime unavailable: configure CRAFT_NODE or install node on PATH.'
    );
  }

  if (process.env.CRAFT_BUN) {
    const cmd = isPackaged
      ? validatePackagedEnvRuntime(process.env.CRAFT_BUN, 'Bun')
      : process.env.CRAFT_BUN;
    return { command: cmd, argsPrefix: [], source: 'env' };
  }

  const bundledBun = resolveBundledBun(ctx);
  if (bundledBun) {
    return { command: bundledBun, argsPrefix: [], source: 'bundled' };
  }

  if (!isPackaged) {
    const bunPath = resolveBinaryOnPath('bun');
    if (bunPath) {
      return { command: bunPath, argsPrefix: [], source: 'path' };
    }
  }

  throw new Error(
    isPackaged
      ? 'Bun runtime unavailable in packaged app: bun was not found in env or bundled resources.'
      : 'Bun runtime unavailable: configure CRAFT_BUN or install bun on PATH.'
  );
}
