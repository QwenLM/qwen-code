import type { DaemonSessionArtifactInput } from '@qwen-code/sdk/daemon';

export function readReportedArtifacts(
  meta: Record<string, unknown> | undefined,
): DaemonSessionArtifactInput[] {
  if (
    meta?.['source'] !== 'slash_command' ||
    !Array.isArray(meta['sessionArtifacts'])
  ) {
    return [];
  }
  return meta['sessionArtifacts'].flatMap((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const artifact = value as Record<string, unknown>;
    const { title, workspacePath, kind, storage, mimeType, sizeBytes } =
      artifact;
    if (
      storage !== 'workspace' ||
      (kind !== 'file' && kind !== 'html') ||
      typeof title !== 'string' ||
      !title ||
      typeof workspacePath !== 'string' ||
      !workspacePath ||
      /^(?:[\\/]|[a-z]:)/i.test(workspacePath) ||
      workspacePath.split(/[\\/]/).includes('..') ||
      artifact['url'] !== undefined ||
      artifact['managedId'] !== undefined
    )
      return [];
    return [
      {
        title,
        workspacePath,
        kind,
        storage,
        ...(typeof mimeType === 'string' ? { mimeType } : {}),
        ...(typeof sizeBytes === 'number' &&
        Number.isSafeInteger(sizeBytes) &&
        sizeBytes >= 0
          ? { sizeBytes }
          : {}),
      },
    ];
  });
}
