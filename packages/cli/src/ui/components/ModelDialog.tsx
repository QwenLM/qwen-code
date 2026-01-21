/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  AuthType,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  type ContentGeneratorConfig,
  type ContentGeneratorConfigSource,
  type ContentGeneratorConfigSources,
} from '@qwen-code/qwen-code-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { UIStateContext } from '../contexts/UIStateContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import {
  getAvailableModelsForAuthType,
  MAINLINE_CODER,
} from '../models/availableModels.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { t } from '../../i18n/index.js';

interface ModelDialogProps {
  onClose: () => void;
}

function formatSourceBadge(
  source: ContentGeneratorConfigSource | undefined,
): string | undefined {
  if (!source) return undefined;

  switch (source.kind) {
    case 'cli':
      return source.detail ? `CLI ${source.detail}` : 'CLI';
    case 'env':
      return source.envKey ? `ENV ${source.envKey}` : 'ENV';
    case 'settings':
      return source.settingsPath
        ? `Settings ${source.settingsPath}`
        : 'Settings';
    case 'modelProviders': {
      const suffix =
        source.authType && source.modelId
          ? `${source.authType}:${source.modelId}`
          : source.authType
            ? `${source.authType}`
            : source.modelId
              ? `${source.modelId}`
              : '';
      return suffix ? `ModelProviders ${suffix}` : 'ModelProviders';
    }
    case 'default':
      return source.detail ? `Default ${source.detail}` : 'Default';
    case 'computed':
      return source.detail ? `Computed ${source.detail}` : 'Computed';
    case 'programmatic':
      return source.detail ? `Programmatic ${source.detail}` : 'Programmatic';
    case 'unknown':
    default:
      return undefined;
  }
}

function readSourcesFromConfig(config: unknown): ContentGeneratorConfigSources {
  if (!config) {
    return {};
  }
  const maybe = config as {
    getContentGeneratorConfigSources?: () => ContentGeneratorConfigSources;
  };
  return maybe.getContentGeneratorConfigSources?.() ?? {};
}

function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '(not set)';
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return '(not set)';
  if (trimmed.length <= 6) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}…${tail}`;
}

function persistModelSelection(
  settings: ReturnType<typeof useSettings>,
  modelId: string,
): void {
  const scope = getPersistScopeForModelSelection(settings);
  settings.setValue(scope, 'model.name', modelId);
}

function persistAuthTypeSelection(
  settings: ReturnType<typeof useSettings>,
  authType: AuthType,
): void {
  const scope = getPersistScopeForModelSelection(settings);
  settings.setValue(scope, 'security.auth.selectedType', authType);
}

function ConfigRow({
  label,
  value,
  badge,
}: {
  label: string;
  value: React.ReactNode;
  badge?: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box>
        <Box minWidth={12} flexShrink={0}>
          <Text color={theme.text.secondary}>{label}:</Text>
        </Box>
        <Box flexGrow={1} flexDirection="row" flexWrap="wrap">
          <Text>{value}</Text>
        </Box>
      </Box>
      {badge ? (
        <Box>
          <Box minWidth={12} flexShrink={0}>
            <Text> </Text>
          </Box>
          <Box flexGrow={1}>
            <Text color={theme.text.secondary}>{badge}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const uiState = useContext(UIStateContext);
  const settings = useSettings();

  // Local error state for displaying errors within the dialog
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const authType = config?.getAuthType();
  const effectiveConfig =
    (config?.getContentGeneratorConfig?.() as
      | ContentGeneratorConfig
      | undefined) ?? undefined;
  const sources = readSourcesFromConfig(config);

  const availableModelEntries = useMemo(() => {
    const allAuthTypes = Object.values(AuthType) as AuthType[];
    const modelsByAuthType = allAuthTypes
      .map((t) => ({
        authType: t,
        models: getAvailableModelsForAuthType(t, config ?? undefined),
      }))
      .filter((x) => x.models.length > 0);

    // Fixed order: qwen-oauth first, then others in a stable order
    const authTypeOrder: AuthType[] = [
      AuthType.QWEN_OAUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
      AuthType.USE_VERTEX_AI,
    ];

    // Filter to only include authTypes that have models
    const availableAuthTypes = new Set(modelsByAuthType.map((x) => x.authType));
    const orderedAuthTypes = authTypeOrder.filter((t) =>
      availableAuthTypes.has(t),
    );

    return orderedAuthTypes.flatMap((t) => {
      const models =
        modelsByAuthType.find((x) => x.authType === t)?.models ?? [];
      return models.map((m) => ({ authType: t, model: m }));
    });
  }, [config]);

  const MODEL_OPTIONS = useMemo(
    () =>
      availableModelEntries.map(({ authType: t2, model }) => {
        const value = `${t2}::${model.id}`;
        const title = (
          <Text>
            <Text bold color={theme.text.accent}>
              [{t2}]
            </Text>
            <Text>{` ${model.label}`}</Text>
          </Text>
        );
        const description = model.description || '';
        return {
          value,
          title,
          description,
          key: value,
        };
      }),
    [availableModelEntries],
  );

  const preferredModelId = config?.getModel() || MAINLINE_CODER;
  const preferredKey = authType ? `${authType}::${preferredModelId}` : '';

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
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

  const handleSelect = useCallback(
    async (selected: string) => {
      // Clear any previous error
      setErrorMessage(null);

      const sep = '::';
      const idx = selected.indexOf(sep);
      const selectedAuthType = (
        idx >= 0 ? selected.slice(0, idx) : authType
      ) as AuthType;
      const modelId = idx >= 0 ? selected.slice(idx + sep.length) : selected;

      if (config) {
        try {
          await config.switchModel(
            selectedAuthType,
            modelId,
            selectedAuthType !== authType &&
              selectedAuthType === AuthType.QWEN_OAUTH
              ? { requireCachedCredentials: true }
              : undefined,
            {
              reason: 'user_manual',
              context:
                selectedAuthType === authType
                  ? 'Model switched via /model dialog'
                  : 'AuthType+model switched via /model dialog',
            },
          );
        } catch (e) {
          const baseErrorMessage = e instanceof Error ? e.message : String(e);
          setErrorMessage(
            `Failed to switch model to '${modelId}'.\n\n${baseErrorMessage}`,
          );
          return;
        }
        const event = new ModelSlashCommandEvent(modelId);
        logModelSlashCommand(config, event);

        const after = config.getContentGeneratorConfig?.() as
          | ContentGeneratorConfig
          | undefined;
        const effectiveAuthType =
          after?.authType ?? selectedAuthType ?? authType;
        const effectiveModelId = after?.model ?? modelId;

        persistModelSelection(settings, effectiveModelId);
        persistAuthTypeSelection(settings, effectiveAuthType);

        const baseUrl = after?.baseUrl ?? t('(default)');
        const maskedKey = maskApiKey(after?.apiKey);
        uiState?.historyManager.addItem(
          {
            type: 'info',
            text:
              `authType: ${effectiveAuthType}\n` +
              `Using model: ${effectiveModelId}\n` +
              `Base URL: ${baseUrl}\n` +
              `API key: ${maskedKey}`,
          },
          Date.now(),
        );
      }
      onClose();
    },
    [authType, config, onClose, settings, uiState, setErrorMessage],
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
      <Text bold>{t('Select Model')}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('Current (effective) configuration')}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <ConfigRow label="AuthType" value={authType} />
          <ConfigRow
            label="Model"
            value={effectiveConfig?.model ?? config?.getModel?.() ?? ''}
            badge={formatSourceBadge(sources['model'])}
          />

          {authType !== AuthType.QWEN_OAUTH && (
            <>
              <ConfigRow
                label="Base URL"
                value={effectiveConfig?.baseUrl ?? t('(default)')}
                badge={formatSourceBadge(sources['baseUrl'])}
              />
              <ConfigRow
                label="API Key"
                value={effectiveConfig?.apiKey ? t('(set)') : t('(not set)')}
                badge={formatSourceBadge(sources['apiKey'])}
              />
            </>
          )}
        </Box>
      </Box>

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
            initialIndex={initialIndex}
            showNumbers={true}
          />
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
        <Text color={theme.text.secondary}>{t('(Press Esc to close)')}</Text>
      </Box>
    </Box>
  );
}
