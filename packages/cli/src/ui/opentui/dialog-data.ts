/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dialog data + result wiring for the mounted OpenTUI dialog family (R2).
 *
 * The ported dialogs are presentational; ink fed them through hooks and
 * UIActions (DialogManager.tsx). The OpenTUI backend reproduces that feeding
 * here with plain functions over `Config` / `LoadedSettings`:
 *
 *  - model list entries + the ModelDialog selection pipeline
 *    (`applyModelSelection`): mode-specific validation, the runtime
 *    switch/setter (`Config.switchModel`, setFastModel/setVisionModel/
 *    setCompactionModel/setImageModel), and persistence only after the
 *    runtime change succeeded;
 *  - permission rules / workspace directories (+ mutation handlers),
 *  - MCP server inventory,
 *  - extension rows,
 *  - theme selection (useThemeCommand parity).
 */

import process from 'node:process';
import { EventEmitter } from 'node:events';
import {
  AuthType,
  checkForExtensionUpdate,
  ExtensionUpdateState,
  getMCPServerStatus,
  isGatedMcpScope,
  isImageCapable,
  isImageGenerationCapable,
  logModelSlashCommand,
  matchesAnyServerPattern,
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  mcpServerRequiresOAuth,
  MCPServerStatus,
  ModelSlashCommandEvent,
  OAUTH_AUTH_URL_EVENT,
  OAUTH_DISPLAY_MESSAGE_EVENT,
  parseVisionModelSetting,
  redactUrlCredentials,
  removeMCPServerStatus,
  resolveModelId,
  SettingScope as CoreSettingScope,
} from '@qwen-code/qwen-code-core';
import type {
  Config,
  ContentGeneratorConfig,
  Extension,
  MCPServerConfig,
  ResolvedModelId,
} from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import { loadMcpApprovals } from '../../config/mcpApprovals.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { t } from '../../i18n/index.js';
import { getErrorMessage } from '../../utils/errors.js';
import { getToolInvalidReasons, isToolValid } from '../components/mcp/utils.js';
import { themeManager, AUTO_THEME_NAME } from '../themes/theme-manager.js';
import {
  isSelectableVoiceModel,
  formatUnsupportedVoiceModelMessage,
} from '../voice/voice-model.js';
import {
  buildModelSelectionKey,
  encodeAuxModelSelector,
  encodeVisionModelSelector,
  maskApiKey,
  parseModelSelectionKey,
  type ModelDialogMode,
  type OpenTuiModelEntry,
} from './dialogs-model.js';
import type { PermissionRuleEntry } from './dialogs-permissions.js';
import type {
  McpResourceInfo,
  McpServerAction,
  McpServerInfo,
  McpToolInfo,
} from './dialogs-mcp.js';
import type { ExtensionRow } from './dialogs-extensions.js';

/**
 * Model list parity of ModelDialog's `availableModelEntries`: runtime entries
 * are listed (tagged) outside image mode, QWEN_OAUTH models only under that
 * auth type, imageOnly/fastOnly/voiceOnly/visionOnly entries only in their
 * own selector modes, and image-mode rows additionally must resolve through
 * `Config.resolveImageGenerationModel`. Rows are keyed like ink's option
 * values: runtime rows by their `$runtime|...` snapshot id, registry rows by
 * `authType::modelId[\0baseUrl]`. The raw registry entry travels on `model`
 * so selection-time validation matches the ink dialog.
 */
export function buildModelEntries(
  config: Config | null | undefined,
  mode: ModelDialogMode,
): OpenTuiModelEntry[] {
  const allModels = config?.getAllConfiguredModels?.() ?? [];
  const authType = config?.getAuthType?.();
  const entries: OpenTuiModelEntry[] = [];
  for (const model of allModels) {
    if (mode === 'image') {
      // ink gates on isImageGenerationCapable (not just imageOnly): dual-role
      // models with supportsImageGeneration and visionOnly image-capable
      // models must both appear in the image selector.
      if (model.isRuntimeModel || !isImageGenerationCapable(model)) continue;
      const selector = encodeVisionModelSelector(
        buildModelSelectionKey(model.authType, model.id, model.baseUrl),
      );
      if (config?.resolveImageGenerationModel?.(selector) === undefined) {
        continue;
      }
    }
    if (mode !== 'image' && model.imageOnly) continue;
    if (!model.isRuntimeModel) {
      if (
        model.authType === AuthType.QWEN_OAUTH &&
        authType !== AuthType.QWEN_OAUTH
      ) {
        continue;
      }
      if (mode !== 'fast' && model.fastOnly) continue;
      if (mode !== 'voice' && model.voiceOnly) continue;
      // ink keeps visionOnly models in vision AND image mode
      // (ModelDialog.tsx: isVisionModelMode || isImageModelMode || !m.visionOnly).
      if (mode !== 'vision' && mode !== 'image' && model.visionOnly) continue;
    }
    const key =
      model.isRuntimeModel && model.runtimeSnapshotId
        ? model.runtimeSnapshotId
        : buildModelSelectionKey(
            String(model.authType ?? ''),
            model.id,
            model.baseUrl,
          );
    entries.push({
      key,
      value: key,
      authType: String(model.authType ?? ''),
      label: model.label || model.id,
      modelId: model.id,
      ...(model.description ? { description: model.description } : {}),
      isRuntime: model.isRuntimeModel ?? false,
      isQwenOAuth: model.authType === AuthType.QWEN_OAUTH,
      ...(model.modalities ? { modalities: model.modalities } : {}),
      ...(model.contextWindowSize
        ? { contextWindowSize: model.contextWindowSize }
        : {}),
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.envKey ? { envKey: model.envKey } : {}),
      model,
    });
  }
  return entries;
}

/** Parity of ModelDialog's `resolvePersistScope`. */
export function resolveModelPersistScope(
  settings: LoadedSettings,
  persistScope?: 'workspace' | 'user',
): SettingScope {
  // Workspace settings are ignored when untrusted, so fall back to user scope.
  if (persistScope === 'workspace' && !settings.isTrusted) {
    return SettingScope.User;
  }
  if (persistScope === 'workspace') return SettingScope.Workspace;
  if (persistScope === 'user') return SettingScope.User;
  return getPersistScopeForModelSelection(settings);
}

/**
 * The selection key to highlight when the `/model` dialog opens (ink
 * ModelDialog `preferredKey` parity): the active runtime snapshot or the
 * current auth/model/baseUrl row in primary mode, and the entry owning the
 * persisted selector in the auxiliary modes (fast/voice/vision/compaction/
 * image). Returns undefined when nothing matches (the dialog then starts on
 * the first row, as in ink's `initialIndex === -1 → 0` fallback).
 */
export function computeModelDialogInitialKey(params: {
  config: Config | null | undefined;
  settings: LoadedSettings;
  entries: readonly OpenTuiModelEntry[];
  mode: ModelDialogMode;
}): string | undefined {
  const { config, settings, entries, mode } = params;
  if (entries.length === 0) return undefined;
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));

  if (mode === 'primary') {
    const snapshotId = config?.getActiveRuntimeModelSnapshot?.()?.id?.trim();
    if (snapshotId && byKey.has(snapshotId)) return snapshotId;

    const rawModel = config?.getModel();
    const modelId =
      typeof rawModel === 'string'
        ? rawModel
        : ((rawModel as { id?: string } | undefined)?.id ?? undefined);
    if (!modelId) return undefined;
    const baseUrl = config?.getContentGeneratorConfig?.()?.baseUrl;
    const authType = String(config?.getAuthType?.() ?? '');
    const exact = buildModelSelectionKey(authType, modelId, baseUrl);
    if (byKey.has(exact)) return exact;
    // No same-provider row (e.g. baseUrl drift): any same-id row beats
    // defaulting to the list head.
    return entries.find((entry) => entry.modelId === modelId)?.key;
  }

  const rawSetting =
    mode === 'fast'
      ? settings.merged.fastModel
      : mode === 'voice'
        ? settings.merged.voiceModel
        : mode === 'vision'
          ? settings.merged.visionModel
          : mode === 'compaction'
            ? settings.merged.compactionModel
            : settings.merged.imageModel;
  if (typeof rawSetting !== 'string' || !rawSetting.trim()) return undefined;
  const trimmed = rawSetting.trim();
  if (byKey.has(trimmed)) return trimmed;
  const parsed = parseVisionModelSetting(trimmed);
  if (!parsed) return undefined;
  // Core splits only on a known-AuthType prefix — model IDs may themselves
  // contain colons (e.g. gpt-4o:online), which a raw first-colon split
  // mangles (ink: parsed*ModelSetting in ModelDialog).
  let resolved: ResolvedModelId | undefined;
  try {
    resolved = resolveModelId(parsed.selector);
  } catch {
    resolved = undefined;
  }
  if (!resolved) return undefined;
  const selectorModelId = resolved.modelId;
  const selectorAuth = resolved.authType
    ? String(resolved.authType)
    : undefined;
  const match = entries.find((entry) => {
    if (entry.modelId !== selectorModelId) return false;
    if (selectorAuth && entry.authType !== selectorAuth) return false;
    if (parsed.baseUrl && entry.baseUrl !== parsed.baseUrl) return false;
    return true;
  });
  return match?.key ?? entries.find((e) => e.modelId === selectorModelId)?.key;
}

function persistScopeSuffix(persistScope?: 'workspace' | 'user'): string {
  return persistScope === 'workspace'
    ? t(' (this project)')
    : persistScope === 'user'
      ? t(' (global)')
      : '';
}

/** Parity of ModelDialog's `hydrateApiKeyEnvFromSettings`. */
function hydrateApiKeyEnvFromSettings(
  settings: LoadedSettings,
  envKey: string | undefined,
): void {
  if (!envKey || process.env[envKey]) {
    return;
  }
  const settingsEnvValue = (
    settings?.merged?.env as Record<string, unknown> | undefined
  )?.[envKey];
  if (
    typeof settingsEnvValue === 'string' &&
    settingsEnvValue.trim().length > 0
  ) {
    process.env[envKey] = settingsEnvValue;
  }
}

/** Outcome of one model-dialog selection (parity of ModelDialog.handleSelect). */
export type ModelSelectionOutcome =
  /** Apply succeeded; the dialog closes; `message` goes to the history. */
  | { ok: true; message?: string }
  /** Validation/runtime switch failed; the dialog stays open with `error`. */
  | { ok: false; error: string };

export interface ApplyModelSelectionParams {
  config: Config | null | undefined;
  settings: LoadedSettings;
  /** The entries the dialog shows (selection-time validation input). */
  entries: readonly OpenTuiModelEntry[];
  mode: ModelDialogMode;
  selectionKey: string;
  persistScope?: 'workspace' | 'user';
}

/**
 * Parity of ModelDialog's `handleSelect`: mode-specific validation and the
 * runtime switch/setter come FIRST; settings are persisted only after the
 * runtime change succeeded. Fast/vision/compaction/image modes write their
 * own setting key (`fastModel` / `visionModel` / `compactionModel` /
 * `imageModel`) — never the generic `model.name` — and primary mode calls
 * `Config.switchModel` before persisting `model.name` / `model.baseUrl`.
 * Validation failures return the error so the dialog stays open.
 */
export async function applyModelSelection(
  params: ApplyModelSelectionParams,
): Promise<ModelSelectionOutcome> {
  const { config, settings, entries, mode, selectionKey, persistScope } =
    params;
  const selectedEntry = entries.find((entry) => entry.key === selectionKey);
  const scopeSuffix = persistScopeSuffix(persistScope);

  if (mode === 'voice') {
    if (!selectedEntry?.model) {
      return { ok: false, error: t('Selected voice model is unavailable.') };
    }
    const voiceModel = selectedEntry.model.id;
    if (!isSelectableVoiceModel(selectedEntry.model)) {
      return {
        ok: false,
        error: formatUnsupportedVoiceModelMessage(voiceModel),
      };
    }
    const matchingEntries = entries.filter(
      (entry) => entry.model?.id === voiceModel,
    );
    if (matchingEntries.length > 1) {
      return {
        ok: false,
        error: t(
          "Voice model '{{model}}' is configured more than once. Remove duplicate model ids before selecting it for voice transcription.",
          { model: voiceModel },
        ),
      };
    }
    const scope = resolveModelPersistScope(settings, persistScope);
    settings.setValue(scope, 'voiceModel', voiceModel);
    return {
      ok: true,
      message: `${t('Voice Model')}: ${voiceModel}${scopeSuffix}`,
    };
  }

  hydrateApiKeyEnvFromSettings(settings, selectedEntry?.model?.envKey);

  // Fast model mode: save authType:modelId so duplicate model ids across
  // providers remain unambiguous. baseUrl is intentionally discarded.
  if (mode === 'fast') {
    const fastModel = encodeAuxModelSelector(selectionKey);
    // Sync the runtime Config so forked agents pick up the change immediately.
    config?.setFastModel?.(fastModel);
    const scope = resolveModelPersistScope(settings, persistScope);
    settings.setValue(scope, 'fastModel', fastModel);
    return {
      ok: true,
      message: `${t('Fast Model')}: ${fastModel}${scopeSuffix}`,
    };
  }

  if (mode === 'vision') {
    const visionModel = encodeVisionModelSelector(selectionKey);
    const visionModelDisplay =
      parseVisionModelSetting(visionModel)?.selector ?? visionModel;
    // Pinning the primary itself is ignored by the bridge at runtime, so
    // reject it here instead of persisting a dead pin and reporting success.
    if (
      selectedEntry?.model &&
      config?.isCurrentPrimaryModel?.(selectedEntry.model)
    ) {
      return {
        ok: false,
        error: t(
          "'{{model}}' is the current primary model and cannot be used as the vision bridge.",
          { model: visionModelDisplay },
        ),
      };
    }
    // Sync runtime Config so the vision bridge picks it up without a restart.
    config?.setVisionModel?.(visionModel);
    const scope = resolveModelPersistScope(settings, persistScope);
    settings.setValue(scope, 'visionModel', visionModel);
    // Honor the pin even if the model isn't image-capable, but warn — the
    // bridge will send images to it.
    const visionWarning =
      selectedEntry?.model && !isImageCapable(selectedEntry.model)
        ? `\n${t("⚠ '{{model}}' is not a known image-capable model; the vision bridge may fail on images.", { model: visionModelDisplay })}`
        : '';
    return {
      ok: true,
      message: `${t('Vision Model')}: ${visionModelDisplay}${scopeSuffix}${visionWarning}`,
    };
  }

  if (mode === 'compaction') {
    if (!selectedEntry || !config) {
      return {
        ok: false,
        error: t('Selected compaction model is unavailable.'),
      };
    }
    const compactionModelId = encodeAuxModelSelector(selectionKey);
    // Sync runtime Config so the compression service picks it up immediately.
    config.setCompactionModel(compactionModelId);
    const scope = resolveModelPersistScope(settings, persistScope);
    settings.setValue(scope, 'compactionModel', compactionModelId);
    return {
      ok: true,
      message: `${t('Compaction Model')}: ${compactionModelId}${scopeSuffix}`,
    };
  }

  if (mode === 'image') {
    if (!selectedEntry || !config) {
      return { ok: false, error: t('Selected image model is unavailable.') };
    }
    const imageModel = encodeVisionModelSelector(selectionKey);
    const imageModelDisplay =
      parseVisionModelSetting(imageModel)?.selector ?? imageModel;
    if (!config.resolveImageGenerationModel?.(imageModel)) {
      return {
        ok: false,
        error: t(
          "'{{model}}' must declare a valid HTTPS baseUrl and credential environment variable.",
          { model: imageModelDisplay },
        ),
      };
    }
    await config.setImageModel(imageModel);
    const scope = resolveModelPersistScope(settings, persistScope);
    settings.setValue(scope, 'imageModel', imageModel);
    return {
      ok: true,
      message: `${t('Image Model')}: ${imageModelDisplay}${scopeSuffix}`,
    };
  }

  // Primary mode. Block selection of discontinued qwen-oauth models
  // (only block non-runtime OAuth; runtime OAuth models from existing
  // cached tokens are still allowed to work until the server rejects them).
  const isQwenOAuthSelection =
    selectionKey.startsWith(`${AuthType.QWEN_OAUTH}::`) ||
    (selectionKey.startsWith('$runtime|') &&
      selectionKey.split('|')[1] === AuthType.QWEN_OAUTH);
  const isRuntimeOAuthSelection = selectionKey.startsWith(
    `$runtime|${AuthType.QWEN_OAUTH}|`,
  );
  if (isQwenOAuthSelection && !isRuntimeOAuthSelection) {
    return {
      ok: false,
      error: t(
        'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.',
      ),
    };
  }

  if (!config) {
    return { ok: true };
  }

  // Runtime model format: $runtime|${authType}|${modelId}
  const isRuntime = selectionKey.startsWith('$runtime|');
  const authType = config.getAuthType?.();
  let selectedAuthType: AuthType;
  let modelId: string;
  let selectedBaseUrl: string | undefined;
  if (isRuntime) {
    const parts = selectionKey.split('|');
    selectedAuthType = (
      parts.length >= 2 && parts[0] === '$runtime' ? parts[1] : authType
    ) as AuthType;
    modelId = selectionKey; // Pass the full snapshot ID to switchModel
  } else {
    const parsed = parseModelSelectionKey(selectionKey);
    selectedAuthType = (parsed.authType || authType) as AuthType;
    modelId = parsed.modelId;
    selectedBaseUrl = parsed.baseUrl;
  }

  let after: ContentGeneratorConfig | undefined;
  try {
    await config.switchModel(selectedAuthType, modelId, {
      ...(selectedAuthType !== authType &&
      selectedAuthType === AuthType.QWEN_OAUTH
        ? { requireCachedCredentials: true }
        : {}),
      baseUrl: selectedBaseUrl,
    });
    if (!isRuntime) {
      logModelSlashCommand(config, new ModelSlashCommandEvent(modelId));
    }
    after = config.getContentGeneratorConfig?.();
  } catch (e) {
    const baseErrorMessage = e instanceof Error ? e.message : String(e);
    // Use parsed modelId for display to avoid showing raw selection key
    // (which contains invisible \0 separator between modelId and baseUrl).
    const displayModelId = isRuntime
      ? modelId
      : parseModelSelectionKey(selectionKey).modelId;
    const errorPrefix = isRuntime
      ? 'Failed to switch to runtime model.'
      : `Failed to switch model to '${displayModelId}'.`;
    return { ok: false, error: `${errorPrefix}\n\n${baseErrorMessage}` };
  }

  const effectiveAuthType = after?.authType ?? selectedAuthType ?? authType;
  const effectiveModelId = after?.model ?? modelId;
  // Persist the selected provider's baseUrl so the right provider is restored
  // next launch when several share the same id; fall back to the picker
  // entry's baseUrl. Runtime models are keyed by snapshot id, so no
  // disambiguator.
  const effectiveBaseUrl = isRuntime
    ? undefined
    : (after?.baseUrl ?? selectedEntry?.model?.baseUrl);

  // Persist only after the runtime switch succeeded.
  const scope = resolveModelPersistScope(settings, persistScope);
  settings.setValue(scope, 'model.name', effectiveModelId);
  settings.setValue(scope, 'model.baseUrl', effectiveBaseUrl ?? '');
  if (effectiveAuthType) {
    settings.setValue(scope, 'security.auth.selectedType', effectiveAuthType);
  }

  const baseUrl = after?.baseUrl ?? t('(default)');
  const maskedKey = maskApiKey(after?.apiKey);
  return {
    ok: true,
    message:
      `authType: ${effectiveAuthType ?? `(${t('none')})`}` +
      `\n` +
      `Using ${isRuntime ? 'runtime ' : ''}model: ${effectiveModelId}${scopeSuffix}` +
      `\n` +
      `Base URL: ${baseUrl}` +
      `\n` +
      `API key: ${maskedKey}`,
  };
}

function persistScopeToSettingScope(
  persistScope: 'workspace' | 'user',
): SettingScope {
  return persistScope === 'workspace'
    ? SettingScope.Workspace
    : SettingScope.User;
}

/** Parity of useThemeCommand's handleThemeSelect (cancel = undefined). */
export interface ThemeSelectionResult {
  applied?: string;
  error?: string;
}

export function applyThemeSelection(
  settings: LoadedSettings,
  themeName: string | undefined,
  scope: SettingScope,
): ThemeSelectionResult {
  if (themeName === undefined) {
    return {};
  }
  const mergedCustomThemes = {
    ...(settings.user.settings.ui?.customThemes || {}),
    ...(settings.workspace.settings.ui?.customThemes || {}),
  };
  const isAuto = themeName === AUTO_THEME_NAME;
  const isBuiltIn = themeManager.findThemeByName(themeName);
  const isCustom = themeName && mergedCustomThemes[themeName];
  if (!isAuto && !isBuiltIn && !isCustom) {
    return {
      error: t('Theme "{{themeName}}" not found in selected scope.', {
        themeName: themeName ?? '',
      }),
    };
  }
  settings.setValue(scope, 'ui.theme', themeName);
  if (settings.merged.ui?.customThemes) {
    themeManager.loadCustomThemes(settings.merged.ui.customThemes);
  }
  const effective = settings.merged.ui?.theme;
  themeManager.setActiveTheme(effective ?? AUTO_THEME_NAME);
  return { applied: themeName };
}

export interface PermissionsData {
  rules: PermissionRuleEntry[];
  directories: readonly string[];
  initialDirectories: readonly string[];
}

export function buildPermissionsData(
  config: Config | null | undefined,
): PermissionsData {
  const manager = config?.getPermissionManager?.();
  const rules = (manager?.listRules() ?? []).map((entry) => ({
    raw: entry.rule.raw,
    toolName: entry.rule.toolName,
    type: entry.type,
    scope: entry.scope,
  }));
  const workspace = config?.getWorkspaceContext();
  return {
    rules,
    directories: workspace?.getDirectories() ?? [],
    initialDirectories: workspace?.getInitialDirectories() ?? [],
  };
}

/** Parity of PermissionsDialog's scope-select mutation. */
export function addPermissionRule(
  config: Config | null | undefined,
  settings: LoadedSettings,
  ruleText: string,
  type: PermissionRuleEntry['type'],
  scope: SettingScope,
): void {
  const manager = config?.getPermissionManager?.();
  manager?.addPersistentRule(ruleText, type);
  const key = `permissions.${type}`;
  const current =
    (
      (settings.merged as Record<string, unknown>)['permissions'] as
        | Record<string, string[]>
        | undefined
    )?.[type] ?? [];
  if (!current.includes(ruleText)) {
    settings.setValue(scope, key, [...current, ruleText]);
  }
}

/** Parity of PermissionsDialog's delete-confirm mutation. */
export function deletePermissionRule(
  config: Config | null | undefined,
  settings: LoadedSettings,
  raw: string,
  type: PermissionRuleEntry['type'],
): void {
  const manager = config?.getPermissionManager?.();
  manager?.removePersistentRule(raw, type);
  for (const scope of ['user', 'workspace'] as const) {
    const settingScope = persistScopeToSettingScope(scope);
    const scopeSettings = settings.forScope(settingScope).settings;
    const rules = (scopeSettings as Record<string, unknown>)['permissions'] as
      | Record<string, string[]>
      | undefined;
    const scopeRules = rules?.[type];
    if (scopeRules?.includes(raw)) {
      settings.setValue(
        settingScope,
        `permissions.${type}`,
        scopeRules.filter((rule) => rule !== raw),
      );
      break;
    }
  }
}

/** MCP server inventory parity of MCPManagementDialog's fetchServerData. */
export function buildMcpServers(
  config: Config | null | undefined,
): McpServerInfo[] {
  const servers = config?.getMcpServers?.() ?? {};
  const toolRegistry = config?.getToolRegistry?.();
  const promptRegistry = config?.getPromptRegistry?.();
  const resourceRegistry = config?.getResourceRegistry?.();
  const infos: McpServerInfo[] = [];
  for (const [name, serverConfig] of Object.entries(servers)) {
    const typedConfig = serverConfig as {
      extensionName?: string;
      scope?: string;
      command?: string;
      cwd?: string;
    };
    let source: McpServerInfo['source'] = 'user';
    if (typedConfig.extensionName) source = 'extension';
    else if (typedConfig.scope === 'project') source = 'project';
    else if (typedConfig.scope === 'workspace') source = 'workspace';
    else if (typedConfig.scope === 'system') source = 'system';
    const allTools = toolRegistry?.getAllTools() ?? [];
    const serverTools = allTools.filter(
      (tool) => (tool as { serverName?: string }).serverName === name,
    );
    const allPrompts = promptRegistry?.getAllPrompts() ?? [];
    const serverPrompts = allPrompts.filter((prompt) =>
      'serverName' in prompt
        ? (prompt as { serverName?: string }).serverName === name
        : false,
    );
    infos.push({
      name,
      status: getMCPServerStatus(name),
      source,
      toolCount: serverTools.length,
      invalidToolCount: serverTools.filter(
        (tool) => !tool.name || !tool.description,
      ).length,
      promptCount: serverPrompts.length,
      resourceCount: resourceRegistry?.getResourcesByServer(name)?.length ?? 0,
      isDisabled: config?.isMcpServerDisabled(name) ?? false,
      hasOAuthTokens: false,
      requiresAuth: false,
      ...(typedConfig.command ? { command: typedConfig.command } : {}),
      ...(typedConfig.cwd ? { workingDirectory: typedConfig.cwd } : {}),
    });
  }
  return infos;
}

/**
 * Tool detail feed for the MCP dialog's tool list step (ink getServerTools
 * parity: validity via isToolValid, invalidReason, and tool annotations).
 */
export function getMcpServerTools(
  config: Config | null | undefined,
  serverName: string,
): McpToolInfo[] {
  const allTools = config?.getToolRegistry?.()?.getAllTools() ?? [];
  return allTools
    .filter(
      (tool) => (tool as { serverName?: string }).serverName === serverName,
    )
    .map((tool) => {
      const discovered = tool as {
        name?: string;
        description?: string;
        annotations?: McpToolInfo['annotations'];
      };
      const isValid = isToolValid(discovered.name, discovered.description);
      const invalidReason = isValid
        ? undefined
        : getToolInvalidReasons(discovered.name, discovered.description).join(
            ', ',
          );
      return {
        name: discovered.name ?? '',
        ...(discovered.description
          ? { description: discovered.description }
          : {}),
        ...(discovered.annotations
          ? { annotations: discovered.annotations }
          : {}),
        isValid,
        ...(invalidReason ? { invalidReason } : {}),
      };
    });
}

/** Resource feed for the MCP dialog's resource list step. */
export function getMcpServerResources(
  config: Config | null | undefined,
  serverName: string,
): McpResourceInfo[] {
  const resources =
    config?.getResourceRegistry?.()?.getResourcesByServer(serverName) ?? [];
  return resources.map((resource) => {
    const r = resource as { uri?: string; name?: string; title?: string };
    return {
      uri: r.uri ?? '',
      ...(r.name ? { name: r.name } : {}),
      ...(r.title ? { title: r.title } : {}),
    };
  });
}

/**
 * Real OAuth token state (audit 01 G-6): ink's MCPManagementDialog reads
 * `MCPOAuthTokenStorage.getCredentials` per server and derives `requiresAuth`
 * from the 401 marker / declared-but-tokenless OAuth. `buildMcpServers` is
 * synchronous, so this async pass enriches its output before mounting.
 */
export async function enrichMcpOAuthState(
  config: Config | null | undefined,
  servers: McpServerInfo[],
): Promise<McpServerInfo[]> {
  const mcpServers = config?.getMcpServers?.() ?? {};
  const tokenStorage = new MCPOAuthTokenStorage();
  // Approval state is keyed by the same project root discovery gated on
  // (`config.getWorkingDir()`, ink fetchServerData parity).
  const approvalRoot = config?.getWorkingDir?.();
  const approvals = approvalRoot ? loadMcpApprovals() : undefined;
  const enriched: McpServerInfo[] = [];
  for (const info of servers) {
    let hasOAuthTokens = false;
    try {
      hasOAuthTokens = (await tokenStorage.getCredentials(info.name)) !== null;
    } catch {
      // Unreadable token store = no tokens.
    }
    const serverConfig = mcpServers[info.name] as MCPServerConfig | undefined;
    const status = getMCPServerStatus(info.name);
    const requiresAuth =
      status !== MCPServerStatus.CONNECTED &&
      (mcpServerRequiresOAuth.get(info.name) === true ||
        (Boolean(serverConfig?.oauth?.enabled) && !hasOAuthTokens));
    // Why a gated (#4615) server is skipped by discovery: pending or
    // rejected. `approved` (and non-gated scopes) leave approvalState unset.
    let approvalState: McpServerInfo['approvalState'];
    if (
      approvals &&
      approvalRoot &&
      serverConfig &&
      isGatedMcpScope(serverConfig.scope)
    ) {
      const state = approvals.getState(approvalRoot, info.name, serverConfig);
      if (state !== 'approved') {
        approvalState = state;
      }
    }
    enriched.push({
      ...info,
      status,
      hasOAuthTokens,
      requiresAuth,
      ...(approvalState ? { approvalState } : {}),
    });
  }
  return enriched;
}

export interface McpActionResult {
  /** User-facing outcome line (null = silent success). */
  message: string | null;
  /** The server inventory changed and should be reloaded. */
  changed: boolean;
}

/**
 * Real server actions for the OpenTUI MCP dialog (audit 01 G-6 / 05 G-13),
 * mirroring MCPManagementDialog's handlers: enable/disable via the
 * extension-scoped flag or the user/workspace `mcp.excluded` lists,
 * reconnect via re-discovery, clear-auth via the token storage + disconnect,
 * approve via the gated-approval store, and authenticate via the real
 * MCPOAuthProvider (auth URL surfaced through the returned message).
 */
export async function applyMcpServerAction(
  config: Config | null | undefined,
  settings: LoadedSettings,
  server: McpServerInfo,
  action: McpServerAction,
): Promise<McpActionResult> {
  if (!config) return { message: null, changed: false };
  const toolRegistry = config.getToolRegistry();
  try {
    switch (action) {
      case 'reconnect': {
        if (toolRegistry) {
          await toolRegistry.discoverToolsForServer(server.name);
        }
        return { message: `Reconnecting '${server.name}'…`, changed: true };
      }
      case 'clear-auth': {
        const tokenStorage = new MCPOAuthTokenStorage();
        await tokenStorage.deleteCredentials(server.name);
        if (toolRegistry) {
          await toolRegistry.disconnectServer(server.name);
        }
        return {
          message: `Cleared OAuth tokens for '${server.name}'.`,
          changed: true,
        };
      }
      case 'approve': {
        const serverConfig = (config.getMcpServers?.() ?? {})[server.name];
        if (serverConfig) {
          const approvals = loadMcpApprovals();
          await approvals.setState(
            config.getWorkingDir(),
            server.name,
            serverConfig,
            'approved',
          );
        }
        config.approveMcpServerForSession(server.name);
        if (toolRegistry) {
          await toolRegistry.discoverToolsForServer(server.name);
        }
        return { message: `Approved '${server.name}'.`, changed: true };
      }
      case 'toggle-disable': {
        if (server.isDisabled) {
          // Enable: clear the extension flag and both exclusion lists.
          const rawConfig = (config.getMcpServers?.() ?? {})[server.name] as
            | { extensionName?: string }
            | undefined;
          const extensionName = rawConfig?.extensionName;
          if (extensionName) {
            config
              .getExtensionManager()
              ?.setMcpServerDisabled(extensionName, server.name, false);
          }
          for (const scope of [SettingScope.User, SettingScope.Workspace]) {
            const scopeSettings = settings.forScope(scope).settings;
            const currentExcluded = scopeSettings.mcp?.excluded ?? [];
            if (currentExcluded.includes(server.name)) {
              settings.setValue(
                scope,
                'mcp.excluded',
                currentExcluded.filter((name: string) => name !== server.name),
              );
            }
          }
          const currentExcluded = config.getExcludedMcpServers() ?? [];
          config.setExcludedMcpServers(
            currentExcluded.filter((name: string) => name !== server.name),
          );
          if (toolRegistry) {
            await toolRegistry.discoverToolsForServer(server.name);
          }
          return { message: `Enabled '${server.name}'.`, changed: true };
        }
        // Disable.
        if (server.source === 'extension') {
          const rawConfig = (config.getMcpServers?.() ?? {})[server.name] as
            | { extensionName?: string }
            | undefined;
          const extensionName = rawConfig?.extensionName;
          const manager = config.getExtensionManager();
          if (!extensionName || !manager) {
            return {
              message: `Cannot disable extension MCP server '${server.name}'.`,
              changed: false,
            };
          }
          manager.setMcpServerDisabled(extensionName, server.name, true);
          await toolRegistry?.disconnectServer(server.name);
          removeMCPServerStatus(server.name);
          return { message: `Disabled '${server.name}'.`, changed: true };
        }
        // Scope by config location (ink parity): project → workspace.
        const targetScope =
          server.source === 'project'
            ? SettingScope.Workspace
            : SettingScope.User;
        const scopeSettings = settings.forScope(targetScope).settings;
        const currentExcluded = scopeSettings.mcp?.excluded ?? [];
        if (!matchesAnyServerPattern(server.name, currentExcluded)) {
          settings.setValue(targetScope, 'mcp.excluded', [
            ...currentExcluded,
            server.name,
          ]);
        }
        if (toolRegistry) {
          await toolRegistry.disableMcpServer(server.name);
        }
        return { message: `Disabled '${server.name}'.`, changed: true };
      }
      case 'authenticate': {
        const rawConfig = (config.getMcpServers?.() ?? {})[server.name] as
          | { oauth?: { enabled?: boolean }; url?: string; httpUrl?: string }
          | undefined;
        const oauthConfig = rawConfig?.oauth ?? { enabled: false };
        const events = new EventEmitter();
        const notices: string[] = [];
        events.on(OAUTH_DISPLAY_MESSAGE_EVENT, (message: unknown) => {
          if (typeof message === 'string') notices.push(message);
        });
        events.on(OAUTH_AUTH_URL_EVENT, (url: unknown) => {
          if (typeof url === 'string') {
            notices.push(`Open this URL to authenticate:\n${url}`);
          }
        });
        const provider = new MCPOAuthProvider(new MCPOAuthTokenStorage());
        // Streamable-http servers expose httpUrl; ink passes it ahead of the
        // SSE url (AuthenticateStep parity) — the provider's discovery only
        // runs when a server URL is present.
        await provider.authenticate(
          server.name,
          oauthConfig,
          rawConfig?.httpUrl || rawConfig?.url,
          events,
        );
        if (toolRegistry) {
          await toolRegistry.discoverToolsForServer(server.name);
        }
        return {
          message:
            notices.length > 0
              ? notices.join('\n')
              : `Authenticated '${server.name}'.`,
          changed: true,
        };
      }
      default:
        return { message: null, changed: false };
    }
  } catch (error) {
    return {
      message: `MCP action failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      changed: true,
    };
  }
}

/** Installed-extension rows for the extensions dialog. */
export function buildExtensionRows(
  config: Config | null | undefined,
): ExtensionRow[] {
  const manager = config?.getExtensionManager?.();
  const favorites = new Set(manager?.getFavorites() ?? []);
  const scopes = manager?.getExtensionScopes() ?? {};
  const extensions = config?.getExtensions?.() ?? [];
  return extensions.map((extension) => ({
    key: extension.name,
    label: extension.name,
    meta: extension.path ?? '',
    enabled: extension.isActive,
    favorite: favorites.has(extension.name),
    scope: scopes[extension.name] ?? 'user',
    version: extension.version,
    source: extension.installMetadata?.source
      ? redactUrlCredentials(extension.installMetadata.source)
      : undefined,
    origin: extension.installMetadata?.originSource,
    components: extensionComponentsSummary(extension),
  }));
}

/** Parity of componentSummary in extensions/views/PluginDetailView.tsx. */
function extensionComponentsSummary(extension: Extension): string {
  const parts: string[] = [];
  const mcpCount = extension.mcpServers
    ? Object.keys(extension.mcpServers).length
    : 0;
  if (mcpCount) parts.push(t('{{count}} MCP', { count: String(mcpCount) }));
  if (extension.skills?.length)
    parts.push(
      t('{{count}} Skills', { count: String(extension.skills.length) }),
    );
  if (extension.commands?.length)
    parts.push(
      t('{{count}} Commands', { count: String(extension.commands.length) }),
    );
  if (extension.agents?.length)
    parts.push(
      t('{{count}} Agents', { count: String(extension.agents.length) }),
    );
  return parts.length ? parts.join(' · ') : t('None');
}

export interface ExtensionActionResult {
  message: string;
  changed: boolean;
  level: 'info' | 'success' | 'warning' | 'error';
}

/** Update-check result feeding the "Update Now" action (detail view). */
export type ExtensionUpdateCheckState =
  | 'update-available'
  | 'up-to-date'
  | 'not-updatable'
  | 'error';

const extensionUnavailable = (): ExtensionActionResult => ({
  message: t('Extensions are not available in this environment.'),
  changed: false,
  level: 'error',
});

function loadedExtension(
  config: Config | null | undefined,
  name: string,
): Extension | undefined {
  return config?.getExtensions?.().find((ext) => ext.name === name);
}

function warningsDetail(warnings: Array<{ error: string }>): string {
  return warnings.map((warning) => warning.error).join('; ');
}

/** Space on an installed row: enable/disable via the extension manager. */
export async function applyExtensionToggle(
  config: Config | null | undefined,
  name: string,
  currentlyActive: boolean,
): Promise<ExtensionActionResult> {
  const manager = config?.getExtensionManager?.();
  if (!manager) return extensionUnavailable();
  const scope =
    manager.getExtensionScope(name) === 'project'
      ? CoreSettingScope.Workspace
      : CoreSettingScope.User;
  try {
    const result = currentlyActive
      ? await manager.disableExtension(name, scope)
      : await manager.enableExtension(name, scope);
    await manager.refreshCache();
    const warnings = result.warnings ?? [];
    return {
      message:
        warnings.length > 0
          ? t('"{{name}}" changed with warnings: {{detail}}', {
              name,
              detail: warningsDetail(warnings),
            })
          : t('"{{name}}" {{state}}.', {
              name,
              state: currentlyActive ? t('disabled') : t('enabled'),
            }),
      changed: true,
      level: warnings.length > 0 ? 'warning' : 'success',
    };
  } catch (error) {
    return { message: getErrorMessage(error), changed: false, level: 'error' };
  }
}

/** `f` on an installed row: toggle the favorite preference. */
export function applyExtensionFavorite(
  config: Config | null | undefined,
  name: string,
): ExtensionActionResult {
  const manager = config?.getExtensionManager?.();
  if (!manager) return extensionUnavailable();
  try {
    const nowFavorite = manager.toggleFavorite(name);
    return {
      message: nowFavorite
        ? t('Added "{{name}}" to favorites.', { name })
        : t('Removed "{{name}}" from favorites.', { name }),
      changed: true,
      level: 'info',
    };
  } catch (error) {
    return { message: getErrorMessage(error), changed: false, level: 'error' };
  }
}

/** Uninstall action (after the in-dialog confirm). */
export async function applyExtensionUninstall(
  config: Config | null | undefined,
  name: string,
): Promise<ExtensionActionResult> {
  const manager = config?.getExtensionManager?.();
  if (!manager) return extensionUnavailable();
  try {
    const result = await manager.uninstallExtension(name, false);
    await manager.refreshCache();
    const warnings = result.warnings ?? [];
    return {
      message:
        warnings.length > 0
          ? t('Uninstalled "{{name}}" with warnings: {{detail}}', {
              name,
              detail: warningsDetail(warnings),
            })
          : t('Uninstalled "{{name}}".', { name }),
      changed: true,
      level: warnings.length > 0 ? 'warning' : 'success',
    };
  } catch (error) {
    return { message: getErrorMessage(error), changed: false, level: 'error' };
  }
}

/** Change-scope action: user <-> project (parity of InstalledTab handleScope). */
export async function applyExtensionScopeChange(
  config: Config | null | undefined,
  name: string,
  nextScope: 'user' | 'project',
): Promise<ExtensionActionResult> {
  const manager = config?.getExtensionManager?.();
  const extension = loadedExtension(config, name);
  if (!manager || !extension) return extensionUnavailable();
  try {
    const result =
      nextScope === 'project'
        ? await manager.setExtensionActivationScope(extension.id, {
            scope: 'workspace',
            workspacePath: process.cwd(),
          })
        : await manager.setExtensionActivationScope(extension.id, {
            scope: 'user',
          });
    let preferenceWarning: string | undefined;
    try {
      manager.setExtensionScope(name, nextScope);
    } catch (error) {
      preferenceWarning = getErrorMessage(error);
    }
    await manager.refreshCache();
    const warnings = [
      ...(result.warnings ?? []).map((warning) => warning.error),
      ...(preferenceWarning ? [preferenceWarning] : []),
    ];
    return {
      message:
        warnings.length > 0
          ? t('Set "{{name}}" scope with warnings: {{detail}}', {
              name,
              detail: warnings.join('; '),
            })
          : t('Set "{{name}}" scope to {{scope}}.', {
              name,
              scope: nextScope === 'user' ? t('User') : t('Project'),
            }),
      changed: true,
      level: warnings.length > 0 ? 'warning' : 'success',
    };
  } catch (error) {
    return { message: getErrorMessage(error), changed: false, level: 'error' };
  }
}

/** Mark-for-Update action: check one extension for updates. */
export async function applyExtensionUpdateCheck(
  config: Config | null | undefined,
  name: string,
): Promise<{
  message: string;
  state: ExtensionUpdateCheckState;
}> {
  const manager = config?.getExtensionManager?.();
  const extension = loadedExtension(config, name);
  if (!manager || !extension)
    return {
      message: t('Extensions are not available in this environment.'),
      state: 'error',
    };
  try {
    const checked = await checkForExtensionUpdate(extension, manager);
    switch (checked) {
      case ExtensionUpdateState.UPDATE_AVAILABLE:
        return {
          message: t('Update available for "{{name}}".', { name }),
          state: 'update-available',
        };
      case ExtensionUpdateState.ERROR:
        return {
          message: t('Failed to check "{{name}}" for updates.', { name }),
          state: 'error',
        };
      case ExtensionUpdateState.NOT_UPDATABLE:
        return {
          message:
            extension.installMetadata?.originSource === 'Claude'
              ? t(
                  '"{{name}}" cannot be update-checked (Claude marketplace plugins update by reinstalling).',
                  { name },
                )
              : t('"{{name}}" does not support update checks.', { name }),
          state: 'not-updatable',
        };
      default:
        return {
          message: t('"{{name}}" is already up to date.', { name }),
          state: 'up-to-date',
        };
    }
  } catch (error) {
    return { message: getErrorMessage(error), state: 'error' };
  }
}

/** Update Now action (offered after a positive update check). */
export async function applyExtensionUpdate(
  config: Config | null | undefined,
  name: string,
): Promise<ExtensionActionResult> {
  const manager = config?.getExtensionManager?.();
  const extension = loadedExtension(config, name);
  if (!manager || !extension) return extensionUnavailable();
  try {
    const result = await manager.updateExtension(
      extension,
      ExtensionUpdateState.UPDATE_AVAILABLE,
      () => {},
    );
    const warnings = result?.warnings ?? [];
    return {
      message:
        warnings.length > 0
          ? t('Updated "{{name}}" with warnings: {{warnings}}.', {
              name,
              warnings: warnings
                .map((warning) => `${warning.code}: ${warning.error}`)
                .join('; '),
            })
          : t('Updated "{{name}}".', { name }),
      changed: true,
      level: warnings.length > 0 ? 'warning' : 'success',
    };
  } catch (error) {
    return { message: getErrorMessage(error), changed: false, level: 'error' };
  }
}
