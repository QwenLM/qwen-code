import type {
  QwenCoreSettingsScopeState,
  QwenCoreSettingsSnapshot,
  QwenExtensionSettingsEntry,
} from '@craft-agent/shared/protocol'

type PartialScopeState = Partial<QwenCoreSettingsScopeState>

type PartialSnapshot = Partial<Omit<QwenCoreSettingsSnapshot, 'merged'>> & {
  merged?: Partial<QwenCoreSettingsSnapshot['merged']>
  extensions?: Partial<QwenExtensionSettingsEntry>[]
  isTrusted?: boolean
}

function arrayOrEmpty<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function normalizeScopeState(
  state: PartialScopeState | undefined,
): QwenCoreSettingsScopeState {
  return {
    path: state?.path ?? '',
    values: state?.values ?? {},
    mcpServers: arrayOrEmpty(state?.mcpServers),
    hooks: arrayOrEmpty(state?.hooks),
  }
}

function normalizeExtension(
  extension: Partial<QwenExtensionSettingsEntry>,
): QwenExtensionSettingsEntry {
  return {
    id: extension.id ?? extension.name ?? '',
    name: extension.name ?? extension.id ?? '',
    version: extension.version,
    isActive: extension.isActive,
    path: extension.path,
    commands: arrayOrEmpty(extension.commands),
    skills: arrayOrEmpty(extension.skills),
    mcpServers: arrayOrEmpty(extension.mcpServers),
    settings: arrayOrEmpty(extension.settings),
  }
}

export function normalizeQwenSettingsSnapshot(
  snapshot: QwenCoreSettingsSnapshot | null,
): QwenCoreSettingsSnapshot | null {
  if (!snapshot) return null

  const partial = snapshot as PartialSnapshot
  const extensions = partial.merged?.extensions ?? partial.extensions

  return {
    user: normalizeScopeState(partial.user),
    workspace: normalizeScopeState(partial.workspace),
    merged: {
      values: partial.merged?.values ?? {},
      mcpServers: arrayOrEmpty(partial.merged?.mcpServers),
      hooks: arrayOrEmpty(partial.merged?.hooks),
      extensions: arrayOrEmpty(extensions).map(normalizeExtension),
    },
    workspaceTrusted: partial.workspaceTrusted ?? partial.isTrusted ?? false,
  }
}
