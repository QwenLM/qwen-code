import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';

export type DevInstance = {
  kind: 'numbered' | 'git-worktree';
  source: string;
  instanceNumber: string;
  label: string;
  appName: string;
  configDir?: string;
  runtimeDir: string;
  userDataDir: string;
  serverLockFile: string;
  deeplinkScheme: string;
  resolvePort(defaultPort: number): number;
};

export type ResolvedDevPort = {
  port: number;
  source: 'env' | 'instance' | 'default';
  instance: DevInstance | null;
};

export type ResolveDevPortOptions = {
  allowZero?: boolean;
};

function hashNumber(value: string): number {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

function sanitizeInstanceLabel(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .toLowerCase() || 'worktree'
  );
}

function gitOutput(rootDir: string, args: string[]): string | undefined {
  try {
    return (
      execFileSync('git', args, {
        cwd: rootDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function isLinkedGitWorktree(rootDir: string): boolean {
  const gitPath = join(rootDir, '.git');
  if (!existsSync(gitPath)) return false;
  try {
    return !statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function appPortOffset(defaultPort: number): number {
  if (defaultPort >= 5173 && defaultPort <= 5272) {
    return defaultPort - 5173;
  }
  if (defaultPort === 9100) {
    return 100;
  }
  if (defaultPort === 3100) {
    return 101;
  }
  return 100 + (Math.abs(defaultPort) % 900);
}

function numberedPort(instanceNumber: string, defaultPort: number): number {
  const suffix = String(defaultPort).slice(-3).padStart(3, '0');
  const port = Number(`${instanceNumber}${suffix}`);
  return Number.isFinite(port) && port > 0 && port <= 65535
    ? port
    : defaultPort + Number(instanceNumber) * 100;
}

export function detectDevInstance(rootDir: string): DevInstance | null {
  const home = process.env.HOME || homedir() || '';
  const folderName = basename(rootDir);
  const numberedMatch = folderName.match(/-(\d+)$/);

  if (numberedMatch) {
    const instanceNumber = numberedMatch[1]!;
    const configDir = join(home, `.craft-agent-${instanceNumber}`);
    return {
      kind: 'numbered',
      source: 'Numbered dev instance',
      instanceNumber,
      label: instanceNumber,
      appName: `Qwen Code Desktop [${instanceNumber}]`,
      configDir,
      runtimeDir: configDir,
      userDataDir: join(configDir, 'electron-user-data'),
      serverLockFile: join(configDir, '.server.lock'),
      deeplinkScheme: `craftagents${instanceNumber}`,
      resolvePort: (defaultPort) => numberedPort(instanceNumber, defaultPort),
    };
  }

  if (!isLinkedGitWorktree(rootDir)) return null;

  const hash = hashNumber(rootDir);
  const branchName = gitOutput(rootDir, ['branch', '--show-current']);
  const parentName = basename(dirname(rootDir));
  const label = sanitizeInstanceLabel(branchName || parentName || rootDir);
  const shortHash = hash.toString(36).slice(0, 6);
  const basePort = 41_000 + (hash % 20_000);
  const runtimeDir = join(home, '.craft-agent-dev', `${label}-${shortHash}`);

  return {
    kind: 'git-worktree',
    source: 'Git worktree dev instance',
    instanceNumber: String((hash % 90) + 10),
    label,
    appName: `Qwen Code Desktop [${label}]`,
    runtimeDir,
    userDataDir: join(runtimeDir, 'electron-user-data'),
    serverLockFile: join(runtimeDir, '.server.lock'),
    deeplinkScheme: `craftagents${shortHash}`,
    resolvePort: (defaultPort) => basePort + appPortOffset(defaultPort),
  };
}

export function resolveDevPort(
  rootDir: string,
  defaultPort: number,
  envVar?: string,
  options: ResolveDevPortOptions = {},
): ResolvedDevPort {
  const envPort = envVar ? process.env[envVar] : undefined;
  if (envPort) {
    const parsed = Number(envPort);
    const minPort = options.allowZero ? 0 : 1;
    if (!Number.isInteger(parsed) || parsed < minPort || parsed > 65535) {
      throw new Error(
        `Invalid ${envVar}: expected a TCP port from ${minPort} to 65535.`,
      );
    }
    return {
      port: parsed,
      source: 'env',
      instance: detectDevInstance(rootDir),
    };
  }

  const instance = detectDevInstance(rootDir);
  if (instance) {
    return {
      port: instance.resolvePort(defaultPort),
      source: 'instance',
      instance,
    };
  }

  return { port: defaultPort, source: 'default', instance: null };
}
