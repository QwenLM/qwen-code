import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Expands tilde and resolves relative paths to absolute.
 * Mirrors Storage.resolvePath() in packages/core.
 */
export function resolvePath(dir: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const relativeSegments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(resolved);
  }
  return resolved;
}

/**
 * Returns the global Qwen home directory (config, credentials, etc.).
 *
 * Priority: QWEN_HOME env var > ~/.qwen
 *
 * This mirrors packages/core Storage.getGlobalQwenDir() without importing
 * from core to avoid cross-package dependencies.
 */
export function getGlobalQwenDir(): string {
  const envDir = process.env['QWEN_HOME'];
  if (envDir) {
    return resolvePath(envDir);
  }
  const homeDir = os.homedir();
  return homeDir
    ? path.join(homeDir, '.qwen')
    : path.join(os.tmpdir(), '.qwen');
}

/**
 * Directory name for a workspace-scoped slice of channel state, derived from
 * the workspace's working directory.
 *
 * `<sanitized-basename>-<sha256[:12]>`: the basename keeps the directory
 * human-recognizable; the hash of the FULL resolved path makes it unique, so
 * two workspaces named `app` in different parents never collide. The input is
 * resolved first so `/a/b`, `/a/b/`, and `~/…` equivalents map to the same
 * scope.
 */
export function getWorkspaceScopeDirName(workspaceCwd: string): string {
  const resolved = resolvePath(workspaceCwd);
  const hash = crypto
    .createHash('sha256')
    .update(resolved)
    .digest('hex')
    .slice(0, 12);
  const base = path
    .basename(resolved)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 32);
  return base ? `${base}-${hash}` : hash;
}
