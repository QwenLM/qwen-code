/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { applyProviderInstallPlan } from '../../auth/install/applyProviderInstallPlan.js';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
  toLlmProvider,
  type ProviderConfig,
} from '../../auth/providerConfig.js';
import { findProviderByCredentials } from '../../auth/allProviders.js';

export interface CodingPlanUpdateRequest {
  prompt: string;
  onConfirm: (confirmed: boolean) => void;
}

interface PlanMetadata {
  version?: string;
  baseUrl?: string;
}

function getPlanMetadata(
  settings: LoadedSettings,
  metadataKey: string,
): PlanMetadata {
  const mergedSettings = settings.merged as Record<string, unknown>;
  const metadata = mergedSettings[metadataKey];
  return metadata && typeof metadata === 'object'
    ? (metadata as PlanMetadata)
    : {};
}

function findManagedProviderInConfigs(
  configs: ReadonlyArray<Record<string, unknown>>,
): ProviderConfig | undefined {
  for (const cfg of configs) {
    const baseUrl =
      typeof cfg['baseUrl'] === 'string' ? cfg['baseUrl'] : undefined;
    const envKey =
      typeof cfg['envKey'] === 'string' ? cfg['envKey'] : undefined;
    const match = findProviderByCredentials(baseUrl, envKey);
    if (match?.metadataKey) {
      return match;
    }
  }
  return undefined;
}

/**
 * Hook for detecting and handling Coding Plan and Token Plan template updates.
 * Keeps the historical export name for compatibility with existing callers.
 */
export function useCodingPlanUpdates(
  settings: LoadedSettings,
  config: Config,
  addItem: (
    item: { type: 'info' | 'error' | 'warning'; text: string },
    timestamp: number,
  ) => void,
) {
  const [updateRequest, setUpdateRequest] = useState<
    CodingPlanUpdateRequest | undefined
  >();

  const executeUpdate = useCallback(
    async (providerCfg: ProviderConfig, baseUrl?: string) => {
      try {
        const resolved = resolveBaseUrl(providerCfg, baseUrl);
        const installPlan = buildInstallPlan(providerCfg, {
          baseUrl: resolved,
          apiKey: '',
          modelIds: getDefaultModelIds(providerCfg),
        });
        const previousModel = config.getModel();
        const newConfigs = installPlan.modelProviders?.[0]?.models ?? [];
        const previousModelStillAvailable = newConfigs.some(
          (cfg) => cfg.id === previousModel,
        );

        await applyProviderInstallPlan(installPlan, {
          settings,
          config,
          provider: toLlmProvider(providerCfg),
        });

        const activeModel = config.getModel();
        const displayName = t(providerCfg.label);

        if (previousModelStillAvailable && activeModel === previousModel) {
          addItem(
            {
              type: 'info',
              text: t('{{plan}} configuration updated successfully.', {
                plan: displayName,
              }),
            },
            Date.now(),
          );
        } else {
          addItem(
            {
              type: 'info',
              text: t(
                '{{plan}} configuration updated successfully. Model switched to "{{model}}".',
                { plan: displayName, model: activeModel },
              ),
            },
            Date.now(),
          );
        }

        addItem(
          {
            type: 'info',
            text: t(
              'Tip: Use /model to switch between available {{plan}} models.',
              { plan: displayName },
            ),
          },
          Date.now(),
        );

        return true;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        addItem(
          {
            type: 'error',
            text: t('Failed to update provider configuration: {{message}}', {
              message: errorMessage,
            }),
          },
          Date.now(),
        );
        return false;
      }
    },
    [settings, config, addItem],
  );

  const checkForUpdates = useCallback(() => {
    const currentConfigs =
      (
        settings.merged.modelProviders as
          | Record<string, Array<Record<string, unknown>>>
          | undefined
      )?.[AuthType.USE_OPENAI] || [];
    const matchedProvider = findManagedProviderInConfigs(currentConfigs);

    if (!matchedProvider?.metadataKey) {
      return;
    }

    const metadata = getPlanMetadata(settings, matchedProvider.metadataKey);
    const savedVersion = metadata.version;

    if (!savedVersion) {
      return;
    }

    const baseUrl = metadata.baseUrl || resolveBaseUrl(matchedProvider);
    const currentTemplate = buildProviderTemplate(matchedProvider, baseUrl);
    const currentVersion = computeModelListVersion(currentTemplate);

    if (savedVersion !== currentVersion) {
      const displayName = t(matchedProvider.label);
      setUpdateRequest({
        prompt: t(
          'New model configurations are available for {{plan}}. Update now?',
          { plan: displayName },
        ),
        onConfirm: async (confirmed: boolean) => {
          setUpdateRequest(undefined);
          if (confirmed) {
            await executeUpdate(matchedProvider, baseUrl);
          }
        },
      });
    }
  }, [settings, executeUpdate]);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  const dismissCodingPlanUpdate = useCallback(() => {
    setUpdateRequest(undefined);
  }, []);

  return {
    codingPlanUpdateRequest: updateRequest,
    dismissCodingPlanUpdate,
  };
}
