import type {
  DaemonExtensionEntry,
  DaemonWorkspaceExtensionsStatus,
  DaemonWorkspaceRuntimeStatus,
  ExtensionActivationState,
  ExtensionCatalogEntry,
  WorkspaceExtensionProjection,
} from '@qwen-code/sdk/daemon';

export type ManagedExtensionEntry = Pick<
  DaemonExtensionEntry,
  'id' | 'name' | 'version'
> &
  Partial<Omit<DaemonExtensionEntry, 'id' | 'name' | 'version'>> & {
    defaultActivation?: ExtensionActivationState;
    workspaceActivation?: 'inherit' | ExtensionActivationState;
  };

export function extensionSnapshotsCurrent(
  catalogGeneration: number,
  activation: WorkspaceExtensionProjection | null,
  runtime: DaemonWorkspaceExtensionsStatus | undefined,
  coordinator: DaemonWorkspaceRuntimeStatus | undefined,
): boolean {
  const extensionCapability = coordinator?.capabilities?.extensions;
  return (
    activation?.desiredGeneration === catalogGeneration &&
    activation.appliedGeneration === catalogGeneration &&
    extensionCapability?.state === 'ready' &&
    extensionCapability.runtimeEpoch === coordinator?.runtimeEpoch &&
    extensionCapability.desiredGeneration === catalogGeneration &&
    extensionCapability.appliedGeneration === catalogGeneration &&
    runtime?.initialized === true &&
    runtime.runtimeEpoch === coordinator?.runtimeEpoch
  );
}

export function mergeExtensionCatalog(
  configured: readonly (DaemonExtensionEntry | ExtensionCatalogEntry)[],
  activation: WorkspaceExtensionProjection | null,
  runtime: DaemonWorkspaceExtensionsStatus | undefined,
  coordinator: DaemonWorkspaceRuntimeStatus | undefined,
  catalogGeneration?: number,
): ManagedExtensionEntry[] {
  const activationCurrent =
    catalogGeneration === undefined ||
    activation?.desiredGeneration === catalogGeneration;
  const activations = new Map(
    (activationCurrent ? (activation?.extensions ?? []) : []).map((entry) => [
      entry.extensionId,
      entry,
    ]),
  );
  const runtimeCurrent =
    catalogGeneration !== undefined &&
    extensionSnapshotsCurrent(
      catalogGeneration,
      activation,
      runtime,
      coordinator,
    );
  const runtimeById = new Map(
    (runtimeCurrent ? (runtime?.extensions ?? []) : []).map((entry) => [
      entry.id,
      entry,
    ]),
  );
  return configured.map((extension) => {
    const configuredEntry: ManagedExtensionEntry = extension;
    const projection = activations.get(extension.id);
    const live = runtimeById.get(extension.id);
    return {
      ...configuredEntry,
      ...live,
      updateState: configuredEntry.updateState,
      isActive:
        live?.isActive ??
        (projection
          ? projection.effectiveActivation === 'enabled'
          : configuredEntry.isActive),
      ...(projection
        ? {
            defaultActivation: projection.defaultActivation,
            workspaceActivation:
              projection.workspaceActivation ?? ('inherit' as const),
          }
        : {}),
    };
  });
}

export function preserveSelectedExtensionName(
  name: string | null,
  extensions: readonly ManagedExtensionEntry[],
): string | null {
  return name && extensions.some((extension) => extension.name === name)
    ? name
    : null;
}

export function filterExtensions(
  extensions: readonly ManagedExtensionEntry[],
  query: string,
): ManagedExtensionEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...extensions];
  return extensions.filter((extension) =>
    [extension.name, extension.displayName, extension.description]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized)),
  );
}
