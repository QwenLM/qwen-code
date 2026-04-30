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
  codingPlanProvider,
  createCodingPlanInstallPlan,
  findCodingPlanConfig,
  getCodingPlanConfig,
  type CodingPlanConfig,
} from '../../auth/providers/alibaba/codingPlan.js';
import {
  createTokenPlanInstallPlan,
  findTokenPlanConfig,
  getTokenPlanConfig,
  tokenPlanProvider,
  type TokenPlanConfig,
} from '../../auth/providers/alibaba/tokenPlan.js';

export interface CodingPlanUpdateRequest {
  prompt: string;
  onConfirm: (confirmed: boolean) => void;
}

interface PlanMetadata {
  version?: string;
  baseUrl?: string;
}

type ManagedPlan = CodingPlanConfig | TokenPlanConfig;

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

function findManagedPlanInConfigs(
  configs: ReadonlyArray<Record<string, unknown>>,
): ManagedPlan | undefined {
  for (const config of configs) {
    const baseUrl =
      typeof config['baseUrl'] === 'string' ? config['baseUrl'] : undefined;
    const envKey =
      typeof config['envKey'] === 'string' ? config['envKey'] : undefined;
    const match =
      findCodingPlanConfig(baseUrl, envKey) ||
      findTokenPlanConfig(baseUrl, envKey);
    if (match) {
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
    async (plan: ManagedPlan) => {
      try {
        const provider =
          plan.id === 'token' ? tokenPlanProvider : codingPlanProvider;
        const installPlan =
          plan.id === 'token'
            ? createTokenPlanInstallPlan({})
            : createCodingPlanInstallPlan({ baseUrl: plan.baseUrl });
        const previousModel = config.getModel();
        const newConfigs = installPlan.modelProviders?.[0]?.models ?? [];
        const previousModelStillAvailable = newConfigs.some(
          (cfg) => cfg.id === previousModel,
        );

        await applyProviderInstallPlan(installPlan, {
          settings,
          config,
          provider,
        });

        const activeModel = config.getModel();

        if (previousModelStillAvailable && activeModel === previousModel) {
          addItem(
            {
              type: 'info',
              text: t('{{plan}} configuration updated successfully.', {
                plan: t(plan.displayName),
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
                { plan: t(plan.displayName), model: activeModel },
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
              {
                plan: t(plan.displayName),
              },
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
    const legacyCodingPlanMetadata = getPlanMetadata(settings, 'codingPlan');
    const matchedPlan =
      findManagedPlanInConfigs(currentConfigs) ||
      (legacyCodingPlanMetadata.version
        ? getCodingPlanConfig(legacyCodingPlanMetadata.baseUrl)
        : undefined);

    if (!matchedPlan) {
      return;
    }

    const metadata = getPlanMetadata(settings, matchedPlan.metadataKey);
    const savedVersion = metadata.version;

    if (!savedVersion) {
      return;
    }

    const currentPlan =
      matchedPlan.id === 'token'
        ? getTokenPlanConfig()
        : getCodingPlanConfig(metadata.baseUrl || matchedPlan.baseUrl);

    if (savedVersion !== currentPlan.version) {
      setUpdateRequest({
        prompt: t(
          'New model configurations are available for {{plan}}. Update now?',
          { plan: t(currentPlan.displayName) },
        ),
        onConfirm: async (confirmed: boolean) => {
          setUpdateRequest(undefined);
          if (confirmed) {
            await executeUpdate(currentPlan);
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
