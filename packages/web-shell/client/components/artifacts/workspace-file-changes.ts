import type { TurnOutputFileChange } from './TurnOutputs';
import { normalizePath } from './artifactUtils';

export function fileChangeOwnerSessionId(
  sessionId: string,
): string | undefined {
  if (!sessionId.startsWith('subagent.')) return sessionId;
  if (sessionId.length > 2_000) return undefined;
  const parts = /^subagent\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(sessionId);
  if (!parts) return undefined;
  try {
    const parent = atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'));
    return /^[A-Za-z0-9_-]{1,500}$/.test(parent) &&
      btoa(parent)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '') === parts[1]
      ? parent
      : undefined;
  } catch {
    return undefined;
  }
}

export function workspaceRelativeChangePath(
  filePath: string,
  workspaceCwd: string,
): string | undefined {
  const normalize = (value: string) => {
    const drive = /^[a-zA-Z]:[\\/]/.test(value) ? value.slice(0, 2) : '';
    const rest = drive ? value.slice(2) : value;
    return drive + (normalizePath(rest) || (drive || rest === '/' ? '/' : ''));
  };
  const root = normalize(workspaceCwd);
  const file = normalize(filePath);
  if (
    !root ||
    !file ||
    file === '~' ||
    file.startsWith('~/') ||
    file.includes('\0')
  )
    return undefined;
  if (file.startsWith('/') || /^[a-zA-Z]:\//.test(file)) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return file.startsWith(prefix) && file.length > prefix.length
      ? file.slice(prefix.length)
      : undefined;
  }
  return file === '..' || file.startsWith('../') || /^[a-zA-Z]+:/.test(file)
    ? undefined
    : file;
}

export async function loadGitIgnoredChangePaths(
  paths: readonly string[],
  load: (batch: string[]) => Promise<{ ignoredPaths: string[] }>,
): Promise<ReadonlySet<string>> {
  const ignored = new Set<string>();
  for (let index = 0; index < paths.length; index += 256) {
    const result = await load(paths.slice(index, index + 256));
    for (const file of result.ignoredPaths) ignored.add(file);
  }
  return ignored;
}

export function filterWorkspaceFileChanges(
  byTurn: ReadonlyMap<string, readonly TurnOutputFileChange[]>,
  workspaceCwd: string,
  ignoredPaths: ReadonlySet<string> = new Set(),
  knownPaths?: ReadonlySet<string>,
): ReadonlyMap<string, readonly TurnOutputFileChange[]> {
  const result = new Map<string, readonly TurnOutputFileChange[]>();
  for (const [turnId, changes] of byTurn) {
    const visible = changes.filter((change) => {
      const relative = workspaceRelativeChangePath(change.path, workspaceCwd);
      return (
        relative !== undefined &&
        !ignoredPaths.has(relative) &&
        (!knownPaths || knownPaths.has(relative))
      );
    });
    if (visible.length) result.set(turnId, visible);
  }
  return result;
}
