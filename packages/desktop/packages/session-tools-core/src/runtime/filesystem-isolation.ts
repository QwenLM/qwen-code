import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export interface FilesystemIsolationPlan {
  status: 'enforced' | 'unavailable';
  backend: 'sandbox-exec' | 'bwrap' | 'firejail' | 'none';
  command: string;
  args: string[];
}

export interface FilesystemIsolationOptions {
  includeNetworkDeny?: boolean;
}

function existsOnPath(binary: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [binary], { stdio: 'ignore' });
  return result.status === 0;
}

let sandboxExecUsableCache: boolean | null = null;

function canUseSandboxExec(): boolean {
  if (sandboxExecUsableCache !== null) return sandboxExecUsableCache;
  if (!existsOnPath('sandbox-exec')) {
    sandboxExecUsableCache = false;
    return false;
  }

  const probe = spawnSync(
    'sandbox-exec',
    ['-p', '(version 1) (allow default)', '/usr/bin/true'],
    { stdio: 'ignore' },
  );
  sandboxExecUsableCache = probe.status === 0;
  return sandboxExecUsableCache;
}

function escapeSandboxPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sandboxWriteRoots(sessionDir: string): string[] {
  const resolved = resolve(sessionDir);
  try {
    const real = realpathSync.native(resolved);
    return real === resolved ? [resolved] : [resolved, real];
  } catch {
    return [resolved];
  }
}

export function combineFirejailFilesystemIsolation(
  args: string[],
  sessionRoot: string,
): string[] | null {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex === -1) {
    return null;
  }

  const outerArgs = args.slice(0, separatorIndex);
  const innerArgs = args.slice(separatorIndex + 1);
  return [
    ...outerArgs,
    `--private=${sessionRoot}`,
    `--whitelist=${sessionRoot}`,
    '--',
    ...innerArgs,
  ];
}

export function buildDarwinSandboxProfile(
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): string {
  const writeAllows = sandboxWriteRoots(sessionDir).map(
    (root) => `(allow file-write* (subpath "${escapeSandboxPath(root)}"))`,
  );
  const profileParts = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    '(deny file-write*)',
    ...writeAllows,
  ];

  if (options?.includeNetworkDeny) {
    profileParts.push('(deny network*)');
  }

  return profileParts.join(' ');
}

/**
 * Wrap command execution to deny writes outside the current session directory.
 *
 * Current support:
 * - macOS: sandbox-exec profile
 * - Linux: bubblewrap (preferred) or firejail private/whitelist profile
 * - others: unavailable (fail-safe for script_sandbox)
 */
export function applyFilesystemIsolation(
  command: string,
  args: string[],
  sessionDir: string,
  options?: FilesystemIsolationOptions,
): FilesystemIsolationPlan {
  const sessionRoot = resolve(sessionDir);

  if (process.platform === 'darwin' && canUseSandboxExec()) {
    const profile = buildDarwinSandboxProfile(sessionRoot, options);

    return {
      status: 'enforced',
      backend: 'sandbox-exec',
      command: 'sandbox-exec',
      args: ['-p', profile, command, ...args],
    };
  }

  if (process.platform === 'linux') {
    if (existsOnPath('bwrap')) {
      // Read-only root + writable bind mount for the session subtree.
      // This limits writes to sessionRoot while preserving runtime/library access.
      return {
        status: 'enforced',
        backend: 'bwrap',
        command: 'bwrap',
        args: [
          '--die-with-parent',
          '--ro-bind',
          '/',
          '/',
          '--bind',
          sessionRoot,
          sessionRoot,
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--',
          command,
          ...args,
        ],
      };
    }

    if (existsOnPath('firejail')) {
      if (command === 'firejail') {
        const combinedArgs = combineFirejailFilesystemIsolation(
          args,
          sessionRoot,
        );
        if (combinedArgs) {
          return {
            status: 'enforced',
            backend: 'firejail',
            command: 'firejail',
            args: combinedArgs,
          };
        }
      }

      return {
        status: 'enforced',
        backend: 'firejail',
        command: 'firejail',
        args: [
          '--quiet',
          `--private=${sessionRoot}`,
          `--whitelist=${sessionRoot}`,
          '--',
          command,
          ...args,
        ],
      };
    }
  }

  return {
    status: 'unavailable',
    backend: 'none',
    command,
    args,
  };
}
