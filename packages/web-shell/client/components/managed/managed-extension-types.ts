import type { components } from './generated/managed-agent-api';

export type ManagedExtensionPin =
  components['schemas']['ManagedExtensionPackagePin'];
export type ManagedExtensionManifest =
  components['schemas']['ManagedExtensionPackageManifest'];
export type ManagedExtensionCatalog =
  components['schemas']['ManagedExtensionPackageCatalog'];
export type ManagedExtensionPackageOperation =
  components['schemas']['ManagedExtensionPackageOperation'];
export type ManagedExtensionSettings =
  components['schemas']['ManagedExtensionPackageSettings'];
export type ManagedExtensionSnapshot =
  components['schemas']['ManagedExtensionManagementSnapshot'];
export type ManagedExtensionSelection = Omit<
  components['schemas']['ManagedExtensionApplySelection'],
  'selectionVersion' | 'mcpAuthBindings'
> &
  (
    | { selectionVersion?: never; mcpAuthBindings?: never }
    | { selectionVersion: 2; mcpAuthBindings: ManagedMcpAuthBinding[] }
  );

export type ManagedMcpAuthBinding =
  components['schemas']['ManagedMcpAuthBinding'];

export function isManagedMcpAuthBindings(
  value: unknown,
): value is ManagedMcpAuthBinding[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  const servers = new Set<string>();
  return value.every((binding: unknown) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding))
      return false;
    const entry = binding as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(',') !==
        'credentialGeneration,credentialId,serverId' ||
      typeof entry['serverId'] !== 'string' ||
      !entry['serverId'] ||
      entry['serverId'].length > 512 ||
      typeof entry['credentialId'] !== 'string' ||
      !entry['credentialId'] ||
      entry['credentialId'].length > 512 ||
      !Number.isSafeInteger(entry['credentialGeneration']) ||
      Number(entry['credentialGeneration']) < 1 ||
      servers.has(entry['serverId'])
    )
      return false;
    servers.add(entry['serverId']);
    return true;
  });
}

export function managedExtensionSelection(
  snapshot: Pick<
    ManagedExtensionSnapshot,
    'revision' | 'selectionVersion' | 'mcpAuthBindings' | 'extensions'
  >,
  extensions: ManagedExtensionPin[],
): ManagedExtensionSelection {
  return snapshot.selectionVersion === 2
    ? {
        selectionVersion: 2,
        expectedConfigRevision: snapshot.revision,
        extensions,
        mcpAuthBindings: (snapshot.mcpAuthBindings ?? []).filter((binding) =>
          extensions.some((pin) => {
            const previous = snapshot.extensions.find(
              (entry) => entry.extensionId === pin.extensionId,
            );
            return (
              binding.serverId.startsWith(`${pin.extensionId}:`) &&
              previous?.packageRevision === pin.packageRevision &&
              previous.packageDigest === pin.packageDigest &&
              previous.settingsRevision === pin.settingsRevision
            );
          }),
        ),
      }
    : { expectedConfigRevision: snapshot.revision, extensions };
}

export type ManagedExtensionImportMetadata =
  components['schemas']['ManagedExtensionImportMetadata'];
export type ManagedExtensionInspection =
  components['schemas']['ManagedExtensionPackageInspection'];
export type ManagedExtensionSettingDeclaration =
  ManagedExtensionInspection['settings'][number];
export type ManagedRuntimeSkillOwner =
  components['schemas']['ManagedRuntimeSkillOwner'];
export type ManagedRuntimeSkillCandidates =
  components['schemas']['ManagedRuntimeSkillCandidates'];
export type ManagedRuntimeSkillSnapshot =
  components['schemas']['ManagedRuntimeSkillSnapshot'];

export type ManagedRuntimeSkillImport = Omit<
  ManagedRuntimeSkillSnapshot,
  'inspection'
>;

export function isManagedExtensionPins(
  value: unknown,
): value is ManagedExtensionPin[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const pin = item as Record<string, unknown>;
    if (
      Object.keys(pin).some(
        (key) =>
          ![
            'extensionId',
            'packageRevision',
            'packageDigest',
            'settingsRevision',
          ].includes(key),
      ) ||
      typeof pin['extensionId'] !== 'string' ||
      !/^ext_[a-f0-9-]{36}$/.test(pin['extensionId']) ||
      ids.has(pin['extensionId']) ||
      !Number.isSafeInteger(pin['packageRevision']) ||
      Number(pin['packageRevision']) < 1 ||
      typeof pin['packageDigest'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(pin['packageDigest']) ||
      (pin['settingsRevision'] !== undefined &&
        (!Number.isSafeInteger(pin['settingsRevision']) ||
          Number(pin['settingsRevision']) < 1))
    )
      return false;
    ids.add(pin['extensionId']);
  }
  return true;
}

export function requireExtensionSnapshot(
  value: ManagedExtensionSnapshot,
  sessionId: string,
): ManagedExtensionSnapshot {
  if (
    value.sessionId !== sessionId ||
    typeof value.supported !== 'boolean' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.extensions) ||
    !Array.isArray(value.requestedExtensions)
  )
    throw new Error('Invalid Managed extension snapshot');
  for (const pins of [value.extensions, value.requestedExtensions]) {
    if (!isManagedExtensionPins(pins))
      throw new Error('Invalid Managed extension selection');
  }
  if (
    (value.selectionVersion !== undefined && value.selectionVersion !== 2) ||
    (value.selectionVersion === 2 &&
      !isManagedMcpAuthBindings(value.mcpAuthBindings)) ||
    (value.selectionVersion === undefined &&
      value.mcpAuthBindings !== undefined)
  )
    throw new Error('Invalid Managed MCP authorization bindings');
  if (
    value.operation &&
    (!/^[0-9a-f-]{36}$/i.test(value.operation.operationId) ||
      ![
        'preparing',
        'prepared',
        'committed',
        'active',
        'recovery_required',
        'failed',
      ].includes(value.operation.state) ||
      !['apply', 'recoverPrevious'].includes(value.operation.mode) ||
      !Number.isSafeInteger(value.operation.revision) ||
      value.operation.revision < 1)
  )
    throw new Error('Invalid Managed extension operation');
  return value;
}
