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
