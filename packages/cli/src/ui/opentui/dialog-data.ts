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
import {
  AuthType,
  getMCPServerStatus,
  isImageCapable,
  logModelSlashCommand,
  ModelSlashCommandEvent,
  parseVisionModelSetting,
} from '@qwen-code/qwen-code-core';
import type { Config, ContentGeneratorConfig } from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import type { LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { t } from '../../i18n/index.js';
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
import type { McpServerInfo, McpToolInfo } from './dialogs-mcp.js';
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
      if (model.isRuntimeModel || !model.imageOnly) continue;
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
      if (mode !== 'vision' && model.visionOnly) continue;
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

/** Tool detail feed for the MCP dialog's tool list step. */
export function getMcpServerTools(
  config: Config | null | undefined,
  serverName: string,
): McpToolInfo[] {
  const allTools = config?.getToolRegistry?.()?.getAllTools() ?? [];
  return allTools
    .filter(
      (tool) => (tool as { serverName?: string }).serverName === serverName,
    )
    .map((tool) => ({
      name: tool.name ?? '',
      ...(tool.description ? { description: tool.description } : {}),
      isValid: Boolean(tool.name && tool.description),
    }));
}

/** Installed-extension rows for the extensions dialog. */
export function buildExtensionRows(
  config: Config | null | undefined,
): ExtensionRow[] {
  const extensions = config?.getExtensions?.() ?? [];
  return extensions.map((extension) => ({
    key: extension.name,
    label: extension.name,
    meta: extension.path ?? '',
    enabled: extension.isActive,
  }));
}
