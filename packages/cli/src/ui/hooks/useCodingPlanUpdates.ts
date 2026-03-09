/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import type { Config, ModelProvidersConfig } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import {
  getCodingPlanConfig,
  CodingPlanRegion,
} from '../../constants/codingPlan.js';
import { t } from '../../i18n/index.js';

export interface CodingPlanUpdateRequest {
  prompt: string;
  onConfirm: (confirmed: boolean) => void;
}

/**
 * Hook for detecting and handling Coding Plan template updates.
 * Compares the persisted version with the current template version
 * and prompts the user to update if they differ.
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

  /**
   * Execute the Coding Plan configuration update.
   * Removes old Coding Plan configs and replaces them with new ones from the template.
   * Preserves the user's current model selection if it still exists in the new template.
   * Uses the region from settings.codingPlan.region (defaults to CHINA).
   */
  const executeUpdate = useCallback(
    async (region: CodingPlanRegion = CodingPlanRegion.CHINA) => {
      try {
        const persistScope = getPersistScopeForModelSelection(settings);

        // Replace the managed Coding Plan provider by providerId
        const { providerId, providerConfig, version } =
          getCodingPlanConfig(region);

        // Record the user's current model before the update
        const previousModel = config.getModel();
        const previousModelStillAvailable = providerConfig.models.some(
          (cfg) => cfg.id === previousModel,
        );

        // Build updated modelProviders: replace only the managed provider, preserve all others
        const currentProviders = (settings.merged.modelProviders ??
          {}) as ModelProvidersConfig;
        const updatedModelProviders: ModelProvidersConfig = {
          ...currentProviders,
          [providerId]: providerConfig,
        };

        // Hot-reload model providers configuration (in-memory only)
        config.reloadModelProvidersConfig(updatedModelProviders);

        await config.refreshAuth(AuthType.USE_OPENAI);

        // Persist the managed provider by providerId
        settings.setValue(
          persistScope,
          `modelProviders.${providerId}`,
          providerConfig,
        );

        settings.setValue(persistScope, 'codingPlan.version', version);
        settings.setValue(persistScope, 'codingPlan.region', region);

        const activeModel = config.getModel();

        if (previousModelStillAvailable && activeModel === previousModel) {
          addItem(
            {
              type: 'info',
              text: t('{{region}} configuration updated successfully.', {
                region: t('Alibaba Cloud Coding Plan'),
              }),
            },
            Date.now(),
          );
        } else {
          addItem(
            {
              type: 'info',
              text: t(
                '{{region}} configuration updated successfully. Model switched to "{{model}}".',
                { region: t('Alibaba Cloud Coding Plan'), model: activeModel },
              ),
            },
            Date.now(),
          );
        }

        addItem(
          {
            type: 'info',
            text: t(
              'Tip: Use /model to switch between available Coding Plan models.',
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
            text: t('Failed to update Coding Plan configuration: {{message}}', {
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

  /**
   * Check for version mismatch and prompt user for update if needed.
   * Uses the region from settings.codingPlan.region (defaults to CHINA if not set).
   */
  const checkForUpdates = useCallback(() => {
    const mergedSettings = settings.merged as {
      codingPlan?: {
        version?: string;
        region?: CodingPlanRegion;
      };
    };

    // Get the region (default to CHINA if not set)
    const region = mergedSettings.codingPlan?.region ?? CodingPlanRegion.CHINA;

    // Get the saved version for the current region
    const savedVersion = mergedSettings.codingPlan?.version;

    // If no version is stored, user hasn't used Coding Plan yet - skip check
    if (!savedVersion) {
      return;
    }

    // Get current version for the region
    const currentVersion = getCodingPlanConfig(region).version;

    // Check if version matches
    if (savedVersion !== currentVersion) {
      setUpdateRequest({
        prompt: t(
          'New model configurations are available for {{region}}. Update now?',
          { region: t('Alibaba Cloud Coding Plan') },
        ),
        onConfirm: async (confirmed: boolean) => {
          setUpdateRequest(undefined);
          if (confirmed) {
            await executeUpdate(region);
          }
        },
      });
    }
  }, [settings, executeUpdate]);

  // Check for updates on mount
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
