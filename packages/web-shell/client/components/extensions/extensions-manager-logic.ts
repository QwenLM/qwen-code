import type { DaemonExtensionEntry } from '@qwen-code/sdk/daemon';

export function preserveSelectedExtensionName(
  name: string | null,
  extensions: readonly DaemonExtensionEntry[],
): string | null {
  return name && extensions.some((extension) => extension.name === name)
    ? name
    : null;
}

export function filterExtensions(
  extensions: readonly DaemonExtensionEntry[],
  query: string,
): DaemonExtensionEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...extensions];
  return extensions.filter((extension) =>
    [extension.name, extension.displayName, extension.description]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized)),
  );
}
