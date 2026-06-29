import { spawnSync } from 'node:child_process';

export interface NetworkIsolationPlan {
  status: 'enforced' | 'unavailable';
  backend: 'sandbox-exec' | 'unshare' | 'firejail' | 'none';
  command: string;
  args: string[];
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

  const probe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { stdio: 'ignore' });
  sandboxExecUsableCache = probe.status === 0;
  return sandboxExecUsableCache;
}

function canUseUnshare(): boolean {
  if (!existsOnPath('unshare')) return false;
  const probe = spawnSync('unshare', ['-n', 'true'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Wrap command execution to deny outbound network where supported.
 *
 * Current support:
 * - macOS: sandbox-exec with deny network profile
 * - Linux: unshare -n (preferred) or firejail --net=none
 * - others: unavailable (fail-safe for script_sandbox)
 */
export function applyNetworkIsolation(command: string, args: string[]): NetworkIsolationPlan {
  if (process.platform === 'darwin' && canUseSandboxExec()) {
    const profile = '(version 1) (deny network*)';
    return {
      status: 'enforced',
      backend: 'sandbox-exec',
      command: 'sandbox-exec',
      args: ['-p', profile, command, ...args],
    };
  }

  if (process.platform === 'linux') {
    if (canUseUnshare()) {
      return {
        status: 'enforced',
        backend: 'unshare',
        command: 'unshare',
        args: ['-n', '--', command, ...args],
      };
    }

    if (existsOnPath('firejail')) {
      return {
        status: 'enforced',
        backend: 'firejail',
        command: 'firejail',
        args: ['--quiet', '--net=none', '--', command, ...args],
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
