/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import process from 'node:process';
import { useCallback, useContext, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  AuthType,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  MAINLINE_CODER_MODEL,
  resolveModelId,
  type AvailableModel as CoreAvailableModel,
  type ContentGeneratorConfig,
  type InputModalities,
} from '@qwen-code/qwen-code-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { t } from '../../i18n/index.js';
import {
  formatUnsupportedVoiceModelMessage,
  isSelectableVoiceModel,
} from '../voice/voice-model.js';

function formatModalities(modalities?: InputModalities): string {
  if (!modalities) return t('text-only');
  const parts: string[] = [];
  if (modalities.image) parts.push(t('image'));
  if (modalities.pdf) parts.push(t('pdf'));
  if (modalities.audio) parts.push(t('audio'));
  if (modalities.video) parts.push(t('video'));
  if (parts.length === 0) return t('text-only');
  return `${t('text')} · ${parts.join(' · ')}`;
}

/**
 * Build a unique selection key for a model entry in the model dialog.
 * When baseUrl is present, it's appended after a \0 separator to ensure
 * entries with the same model id but different baseUrls get distinct keys.
 */
function buildModelSelectionKey(
  authType: string,
  modelId: string,
  baseUrl?: string,
): string {
  const base = `${authType}::${modelId}`;
  return baseUrl ? `${base}\0${baseUrl}` : base;
}

/**
 * Parse a model selection key back into its components.
 */
function parseModelSelectionKey(key: string): {
  authType: string;
  modelId: string;
  baseUrl?: string;
} {
  const sep = '::';
  const idx = key.indexOf(sep);
  if (idx < 0) return { authType: '', modelId: key };

  const authType = key.slice(0, idx);
  const rest = key.slice(idx + sep.length);
  const nullIdx = rest.indexOf('\0');
  if (nullIdx >= 0) {
    return {
      authType,
      modelId: rest.slice(0, nullIdx),
      baseUrl: rest.slice(nullIdx + 1),
    };
  }
  return { authType, modelId: rest };
}

interface ModelDialogProps {
  onClose: () => void;
  isFastModelMode?: boolean;
  isVoiceModelMode?: boolean;
}

function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return `(${t('not set')})`;
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return `(${t('not set')})`;
  if (trimmed.length <= 6) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

function persistModelSelection(
  settings: ReturnType<typeof useSettings>,
  modelId: string,
  baseUrl?: string,
): void {
  const scope = getPersistScopeForModelSelection(settings);
  settings.setValue(scope, 'model.name', modelId);
  // Persist the paired baseUrl so the correct provider is restored on next
  // launch when multiple providers share the same model id. When the selection
  // has no baseUrl, write an empty-string tombstone (not undefined): undefined
  // is dropped from JSON, so it would not override a stale model.baseUrl left
  // in a lower-priority scope, whereas '' is a present value that does.
  settings.setValue(scope, 'model.baseUrl', baseUrl ?? '');
}

function persistAuthTypeSelection(
  settings: ReturnType<typeof useSettings>,
  authType: AuthType,
): void {
  const scope = getPersistScopeForModelSelection(settings);
  settings.setValue(scope, 'security.auth.selectedType', authType);
}

function hydrateApiKeyEnvFromSettings(
  settings: ReturnType<typeof useSettings>,
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

interface HandleModelSwitchSuccessParams {
  settings: ReturnType<typeof useSettings>;
  uiState: UIState | null;
  after: ContentGeneratorConfig | undefined;
  effectiveAuthType: AuthType | undefined;
  effectiveModelId: string;
  effectiveBaseUrl: string | undefined;
  isRuntime: boolean;
}

function handleModelSwitchSuccess({
  settings,
  uiState,
  after,
  effectiveAuthType,
  effectiveModelId,
  effectiveBaseUrl,
  isRuntime,
}: HandleModelSwitchSuccessParams): void {
  persistModelSelection(settings, effectiveModelId, effectiveBaseUrl);
  if (effectiveAuthType) {
    persistAuthTypeSelection(settings, effectiveAuthType);
  }

  const baseUrl = after?.baseUrl ?? t('(default)');
  const maskedKey = maskApiKey(after?.apiKey);
  uiState?.historyManager.addItem(
    {
      type: 'info',
      text:
        `authType: ${effectiveAuthType ?? `(${t('none')})`}` +
        `\n` +
        `Using ${isRuntime ? 'runtime ' : ''}model: ${effectiveModelId}` +
        `\n` +
        `Base URL: ${baseUrl}` +
        `\n` +
        `API key: ${maskedKey}`,
    },
    Date.now(),
  );
}

function formatContextWindow(size?: number): string {
  if (!size) return `(${t('unknown')})`;
  return `${size.toLocaleString('en-US')} tokens`;
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box>
      <Box minWidth={16} flexShrink={0}>
        <Text color={theme.text.secondary}>{label}:</Text>
      </Box>
      <Box flexGrow={1} flexDirection="row" flexWrap="wrap">
        <Text>{value}</Text>
      </Box>
    </Box>
  );
}

export function ModelDialog({
  onClose,
  isFastModelMode,
  isVoiceModelMode,
}: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const uiState = useContext(UIStateContext);
  const settings = useSettings();

  // Local error state for displaying errors within the dialog
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);

  const authType = config?.getAuthType();

  const availableModelEntries = useMemo(() => {
    const allModels = config ? config.getAllConfiguredModels() : [];

    // Separate runtime models from registry models
    const runtimeModels = allModels.filter((m) => m.isRuntimeModel);
    const registryModels = allModels.filter(
      (m) =>
        !m.isRuntimeModel &&
        (m.authType !== AuthType.QWEN_OAUTH ||
          authType === AuthType.QWEN_OAUTH),
    );

    // Group registry models by authType
    const modelsByAuthTypeMap = new Map<AuthType, CoreAvailableModel[]>();
    for (const model of registryModels) {
      const authType = model.authType;
      if (!modelsByAuthTypeMap.has(authType)) {
        modelsByAuthTypeMap.set(authType, []);
      }
      modelsByAuthTypeMap.get(authType)!.push(model);
    }

    // Fixed order: qwen-oauth first, then built-in authTypes, then custom authTypes
    const builtinAuthTypeOrder: AuthType[] = [
      AuthType.QWEN_OAUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
      AuthType.USE_VERTEX_AI,
    ];

    // Get all available authTypes
    const availableAuthTypes = new Set(modelsByAuthTypeMap.keys());

    // Build ordered list: built-in authTypes first (in fixed order), then custom authTypes
    const orderedAuthTypes: AuthType[] = [];
    for (const authType of builtinAuthTypeOrder) {
      if (availableAuthTypes.has(authType)) {
        orderedAuthTypes.push(authType);
      }
    }
    // Add custom authTypes (not in builtin list)
    for (const authType of availableAuthTypes) {
      if (!builtinAuthTypeOrder.includes(authType)) {
        orderedAuthTypes.push(authType);
      }
    }

    // Build ordered list: runtime models first, then registry models grouped by authType
    const result: Array<{
      authType: AuthType;
      model: CoreAvailableModel;
      isRuntime?: boolean;
      snapshotId?: string;
    }> = [];

    // Add all runtime models first
    for (const runtimeModel of runtimeModels) {
      result.push({
        authType: runtimeModel.authType,
        model: runtimeModel,
        isRuntime: true,
        snapshotId: runtimeModel.runtimeSnapshotId,
      });
    }

    // Add registry models grouped by authType
    for (const t of orderedAuthTypes) {
      for (const model of modelsByAuthTypeMap.get(t) ?? []) {
        result.push({ authType: t, model, isRuntime: false });
      }
    }

    return result;
  }, [authType, config]);

  const MODEL_OPTIONS = useMemo(
    () =>
      availableModelEntries.map(
        ({ authType: t2, model, isRuntime, snapshotId }) => {
          const value =
            isRuntime && snapshotId
              ? snapshotId
              : buildModelSelectionKey(t2, model.id, model.baseUrl);

          const isQwenOAuth = t2 === AuthType.QWEN_OAUTH;

          const title = (
            <Text>
              <Text
                bold
                color={
                  isQwenOAuth
                    ? theme.status.warning
                    : isRuntime
                      ? theme.status.warning
                      : theme.text.accent
                }
              >
                [{t2}]
              </Text>
              <Text>{` ${model.label}`}</Text>
              {model.id !== model.label && (
                <Text color={theme.text.secondary} italic>
                  {' '}
                  ({model.id})
                </Text>
              )}
              {isRuntime && (
                <Text color={theme.status.warning}> (Runtime)</Text>
              )}
              {isQwenOAuth && !isRuntime && (
                <Text color={theme.status.warning}> ({t('Discontinued')})</Text>
              )}
            </Text>
          );

          // Include runtime / discontinued indicator in description
          let description = model.description || '';
          if (isRuntime) {
            description = description
              ? `${description} (Runtime)`
              : 'Runtime model';
          }
          if (isQwenOAuth && !isRuntime) {
            description = t('Discontinued — switch to Coding Plan or API Key');
          }

          return {
            value,
            title,
            description,
            key: value,
          };
        },
      ),
    [availableModelEntries],
  );

  // In fast model mode, default to the currently configured fast model
  const fastModelSetting = settings?.merged?.fastModel as string | undefined;
  const voiceModelSetting = settings?.merged?.voiceModel as string | undefined;
  const parsedFastModelSetting = useMemo(() => {
    if (!isFastModelMode) return undefined;
    try {
      return resolveModelId(fastModelSetting);
    } catch {
      return undefined;
    }
  }, [fastModelSetting, isFastModelMode]);
  const preferredModelId =
    isFastModelMode && parsedFastModelSetting
      ? parsedFastModelSetting.modelId
      : config?.getModel() || MAINLINE_CODER_MODEL;
  // Check if current model is a runtime model
  // Runtime snapshot ID is already in $runtime|${authType}|${modelId} format
  const activeRuntimeSnapshot =
    isFastModelMode || isVoiceModelMode
      ? undefined // fast and voice models are never runtime model selections
      : config?.getActiveRuntimeModelSnapshot?.();
  const currentBaseUrl = config
    ?.getModelsConfig()
    .getGenerationConfig()?.baseUrl;
  // When `/model --fast <bare-id>` validated the model across all providers,
  // the setting persists as a bare model ID (no authType prefix) so that
  // runtime cross-auth lookups still work. Highlight the row that owns it
  // regardless of which provider that turns out to be — otherwise the
  // dialog would default to the current auth's first row and Enter would
  // silently overwrite the user's fast-model setting.
  const preferredFastModelEntry =
    isFastModelMode && parsedFastModelSetting
      ? parsedFastModelSetting.authType
        ? availableModelEntries.find(
            ({ authType: t2, model }) =>
              t2 === parsedFastModelSetting.authType &&
              model.id === parsedFastModelSetting.modelId,
          )
        : availableModelEntries.find(
            ({ model }) => model.id === parsedFastModelSetting.modelId,
          )
      : undefined;
  const preferredVoiceModelEntry =
    isVoiceModelMode && voiceModelSetting
      ? availableModelEntries.find(
          ({ model }) => model.id === voiceModelSetting,
        )
      : undefined;
  const preferredKey = activeRuntimeSnapshot
    ? activeRuntimeSnapshot.id
    : preferredVoiceModelEntry
      ? buildModelSelectionKey(
          preferredVoiceModelEntry.authType,
          preferredVoiceModelEntry.model.id,
          preferredVoiceModelEntry.model.baseUrl,
        )
      : preferredFastModelEntry
        ? buildModelSelectionKey(
            preferredFastModelEntry.authType,
            preferredFastModelEntry.model.id,
            preferredFastModelEntry.model.baseUrl,
          )
        : authType
          ? buildModelSelectionKey(authType, preferredModelId, currentBaseUrl)
          : '';

  useKeypress(
    (key) => {
      if (
        key.name === 'escape' ||
        (key.name === 'left' && (isFastModelMode || isVoiceModelMode))
      ) {
        onClose();
      }
    },
    { isActive: true },
  );

  const initialIndex = useMemo(() => {
    const index = MODEL_OPTIONS.findIndex(
      (option) => option.value === preferredKey,
    );
    return index === -1 ? 0 : index;
  }, [MODEL_OPTIONS, preferredKey]);

  const handleHighlight = useCallback((value: string) => {
    setHighlightedValue(value);
  }, []);

  const highlightedEntry = useMemo(() => {
    const key = highlightedValue ?? preferredKey;
    return availableModelEntries.find(
      ({ authType: t2, model, isRuntime, snapshotId }) => {
        const v =
          isRuntime && snapshotId
            ? snapshotId
            : buildModelSelectionKey(t2, model.id, model.baseUrl);
        return v === key;
      },
    );
  }, [highlightedValue, preferredKey, availableModelEntries]);

  const handleSelect = useCallback(
    async (selected: string) => {
      setErrorMessage(null);
      const selectedEntry = availableModelEntries.find(
        ({ authType: t2, model, isRuntime, snapshotId }) => {
          const value =
            isRuntime && snapshotId
              ? snapshotId
              : buildModelSelectionKey(t2, model.id, model.baseUrl);
          return value === selected;
        },
      );

      if (isVoiceModelMode) {
        if (!selectedEntry) {
          setErrorMessage(t('Selected voice model is unavailable.'));
          return;
        }

        const voiceModel = selectedEntry.model.id;
        if (!isSelectableVoiceModel(selectedEntry.model)) {
          setErrorMessage(formatUnsupportedVoiceModelMessage(voiceModel));
          return;
        }

        const matchingEntries = availableModelEntries.filter(
          ({ model }) => model.id === voiceModel,
        );
        if (matchingEntries.length > 1) {
          setErrorMessage(
            t(
              "Voice model '{{model}}' is configured more than once. Remove duplicate model ids before selecting it for voice transcription.",
              { model: voiceModel },
            ),
          );
          return;
        }

        const scope = getPersistScopeForModelSelection(settings);
        settings.setValue(scope, 'voiceModel', voiceModel);
        uiState?.historyManager.addItem(
          {
            type: 'success',
            text: `${t('Voice Model')}: ${voiceModel}`,
          },
          Date.now(),
        );
        onClose();
        return;
      }

      hydrateApiKeyEnvFromSettings(settings, selectedEntry?.model.envKey);

      // Fast model mode: save authType:modelId so duplicate model ids across
      // providers remain unambiguous. baseUrl is intentionally discarded.
      if (isFastModelMode) {
        let fastModel: string;
        if (selected.includes('::')) {
          const parsed = parseModelSelectionKey(selected);
          fastModel = `${parsed.authType}:${parsed.modelId}`;
        } else if (selected.startsWith('$runtime|')) {
          const parts = selected.split('|');
          fastModel =
            parts[1] && parts[2] ? `${parts[1]}:${parts[2]}` : selected;
        } else {
          fastModel = selected;
        }
        const scope = getPersistScopeForModelSelection(settings);
        settings.setValue(scope, 'fastModel', fastModel);
        // Sync the runtime Config so forked agents pick up the change immediately.
        config?.setFastModel(fastModel);
        uiState?.historyManager.addItem(
          {
            type: 'success',
            text: `${t('Fast Model')}: ${fastModel}`,
          },
          Date.now(),
        );
        onClose();
        return;
      }

      // Block selection of discontinued qwen-oauth models
      // (only block non-runtime OAuth; runtime OAuth models from existing
      //  cached tokens are still allowed to work until the server rejects them)
      const isQwenOAuthSelection =
        selected.startsWith(`${AuthType.QWEN_OAUTH}::`) ||
        (selected.startsWith('$runtime|') &&
          selected.split('|')[1] === AuthType.QWEN_OAUTH);
      const isRuntimeOAuthSelection = selected.startsWith(
        `$runtime|${AuthType.QWEN_OAUTH}|`,
      );
      if (isQwenOAuthSelection && !isRuntimeOAuthSelection) {
        setErrorMessage(
          t(
            'Qwen OAuth free tier was discontinued on 2026-04-15. Please select a model from another provider or run /auth to switch.',
          ),
        );
        return;
      }

      let after: ContentGeneratorConfig | undefined;
      let effectiveAuthType: AuthType | undefined;
      let effectiveModelId = selected;
      let isRuntime = false;

      if (!config) {
        onClose();
        return;
      }

      try {
        // Determine if this is a runtime model selection
        // Runtime model format: $runtime|${authType}|${modelId}
        isRuntime = selected.startsWith('$runtime|');

        let selectedAuthType: AuthType;
        let modelId: string;

        let selectedBaseUrl: string | undefined;
        if (isRuntime) {
          // For runtime models, extract authType from the snapshot ID
          // Format: $runtime|${authType}|${modelId}
          const parts = selected.split('|');
          if (parts.length >= 2 && parts[0] === '$runtime') {
            selectedAuthType = parts[1] as AuthType;
          } else {
            selectedAuthType = authType as AuthType;
          }
          modelId = selected; // Pass the full snapshot ID to switchModel
        } else {
          const parsed = parseModelSelectionKey(selected);
          selectedAuthType = (parsed.authType || authType) as AuthType;
          modelId = parsed.modelId;
          selectedBaseUrl = parsed.baseUrl;
        }

        await config.switchModel(selectedAuthType, modelId, {
          ...(selectedAuthType !== authType &&
          selectedAuthType === AuthType.QWEN_OAUTH
            ? { requireCachedCredentials: true }
            : {}),
          baseUrl: selectedBaseUrl,
        });

        if (!isRuntime) {
          const event = new ModelSlashCommandEvent(modelId);
          logModelSlashCommand(config, event);
        }

        after = config.getContentGeneratorConfig?.() as
          | ContentGeneratorConfig
          | undefined;
        effectiveAuthType = after?.authType ?? selectedAuthType ?? authType;
        effectiveModelId = after?.model ?? modelId;
      } catch (e) {
        const baseErrorMessage = e instanceof Error ? e.message : String(e);
        // Use parsed modelId for display to avoid showing raw selection key
        // (which contains invisible \0 separator between modelId and baseUrl)
        const displayModelId = isRuntime
          ? effectiveModelId
          : parseModelSelectionKey(selected).modelId;
        const errorPrefix = isRuntime
          ? 'Failed to switch to runtime model.'
          : `Failed to switch model to '${displayModelId}'.`;
        setErrorMessage(`${errorPrefix}\n\n${baseErrorMessage}`);
        return;
      }

      handleModelSwitchSuccess({
        settings,
        uiState,
        after,
        effectiveAuthType,
        effectiveModelId,
        // Persist the selected provider's baseUrl so the right provider is
        // restored next launch when several share the same id. Pair it with the
        // same resolved config that effectiveModelId comes from (`after`) so the
        // persisted (model.name, model.baseUrl) stays consistent even if
        // switchModel transforms the id; fall back to the picker entry's
        // baseUrl. Runtime models are keyed by snapshot id, so no disambiguator.
        effectiveBaseUrl: isRuntime
          ? undefined
          : (after?.baseUrl ?? selectedEntry?.model.baseUrl),
        isRuntime,
      });
      onClose();
    },
    [
      authType,
      config,
      onClose,
      settings,
      uiState,
      setErrorMessage,
      isFastModelMode,
      isVoiceModelMode,
      availableModelEntries,
    ],
  );

  const hasModels = MODEL_OPTIONS.length > 0;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>
        {isVoiceModelMode
          ? t('Select Voice Model')
          : isFastModelMode
            ? t('Select Fast Model')
            : t('Select Model')}
      </Text>

      {!hasModels ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.warning}>
            {t(
              'No models available for the current authentication type ({{authType}}).',
              {
                authType: authType ? String(authType) : t('(none)'),
              },
            )}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t(
                'Please configure models in settings.modelProviders or use environment variables.',
              )}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={MODEL_OPTIONS}
            onSelect={handleSelect}
            onHighlight={handleHighlight}
            initialIndex={initialIndex}
            showNumbers={true}
          />
        </Box>
      )}

      {highlightedEntry && (
        <Box marginTop={1} flexDirection="column">
          <Box
            borderStyle="single"
            borderTop
            borderBottom={false}
            borderLeft={false}
            borderRight={false}
            borderColor={theme.border.default}
          />
          {highlightedEntry.authType === AuthType.QWEN_OAUTH &&
            !highlightedEntry.isRuntime && (
              <Box marginTop={1}>
                <Text color={theme.status.warning}>
                  ⚠ {t('Discontinued — switch to Coding Plan or API Key')}
                </Text>
              </Box>
            )}
          <DetailRow
            label={t('Modality')}
            value={formatModalities(highlightedEntry.model.modalities)}
          />
          <DetailRow
            label={t('Context Window')}
            value={formatContextWindow(
              highlightedEntry.model.contextWindowSize,
            )}
          />
          {highlightedEntry.authType !== AuthType.QWEN_OAUTH && (
            <>
              <DetailRow
                label="Base URL"
                value={highlightedEntry.model.baseUrl ?? t('(default)')}
              />
              <DetailRow
                label="API Key"
                value={highlightedEntry.model.envKey ?? t('(not set)')}
              />
            </>
          )}
        </Box>
      )}

      {errorMessage && (
        <Box marginTop={1} flexDirection="column" paddingX={1}>
          <Text color={theme.status.error} wrap="wrap">
            ✕ {errorMessage}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('Enter to select, ↑↓ to navigate, Esc to close')}
        </Text>
      </Box>
    </Box>
  );
}
