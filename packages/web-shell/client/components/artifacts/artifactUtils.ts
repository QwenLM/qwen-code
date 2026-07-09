import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';

export function artifactKindLabel(kind: string): string {
  switch (kind) {
    case 'html':
      return 'HTML';
    case 'pdf':
      return 'PDF';
    case 'notebook':
      return 'Notebook';
    default:
      return kind || 'artifact';
  }
}

export function formatArtifactSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return '';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

export function getArtifactLocation(artifact: DaemonSessionArtifact): string {
  return artifact.workspacePath ?? artifact.url ?? artifact.managedId ?? '';
}

export function normalizePath(value: string | undefined): string {
  return (value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function stripWorkspacePath(
  path: string,
  workspaceCwd?: string,
): string {
  const normalizedPath = normalizePath(path);
  const normalizedCwd = normalizePath(workspaceCwd);
  if (!normalizedCwd) return normalizedPath;
  if (normalizedPath === normalizedCwd) {
    return normalizedPath.split('/').pop() ?? normalizedPath;
  }
  const prefix = `${normalizedCwd}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
}

export function isSamePath(
  left: string | undefined,
  right: string | undefined,
  workspaceCwd?: string,
): boolean {
  const normalizedLeft = stripWorkspacePath(left ?? '', workspaceCwd);
  const normalizedRight = stripWorkspacePath(right ?? '', workspaceCwd);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}
