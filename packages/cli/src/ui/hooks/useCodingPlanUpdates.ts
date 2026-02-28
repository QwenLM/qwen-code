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
  isCodingPlanConfig,
  getCodingPlanConfig,
  CodingPlanRegion,
  CODING_PLAN_ENV_KEY,
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
   * Uses the region from settings.codingPlan.region (defaults to CHINA).
   */
  const executeUpdate = useCallback(
    async (region: CodingPlanRegion = CodingPlanRegion.CHINA) => {
      try {
        const persistScope = getPersistScopeForModelSelection(settings);

        // Get current configs
        const currentConfigs =
          (
            settings.merged.modelProviders as
              | Record<string, Array<Record<string, unknown>>>
              | undefined
          )?.[AuthType.USE_OPENAI] || [];

        // Filter out all Coding Plan configs (since they are mutually exclusive)
        // Keep only non-Coding-Plan user custom configs
        const nonCodingPlanConfigs = currentConfigs.filter(
          (cfg) =>
            !isCodingPlanConfig(
              cfg['baseUrl'] as string | undefined,
              cfg['envKey'] as string | undefined,
            ),
        );

        // Get the configuration for the current region
        const { template, version, regionName } = getCodingPlanConfig(region);

        // Generate new configs from template
        const newConfigs = template.map((templateConfig) => ({
          ...templateConfig,
          envKey: CODING_PLAN_ENV_KEY,
        }));

        // Combine: new Coding Plan configs at the front, user configs preserved
        const updatedConfigs = [
          ...newConfigs,
          ...(nonCodingPlanConfigs as Array<Record<string, unknown>>),
        ] as Array<Record<string, unknown>>;

        // Hot-reload model providers configuration first (in-memory only)
        const updatedModelProviders = {
          ...(settings.merged.modelProviders as
            | Record<string, unknown>
            | undefined),
          [AuthType.USE_OPENAI]: updatedConfigs,
        };
        config.reloadModelProvidersConfig(
          updatedModelProviders as unknown as ModelProvidersConfig,
        );

        // Refresh auth with the new configuration
        // This validates the configuration before persisting
        await config.refreshAuth(AuthType.USE_OPENAI);

        // Persist to settings only after successful auth refresh
        settings.setValue(
          persistScope,
          `modelProviders.${AuthType.USE_OPENAI}`,
          updatedConfigs,
        );

        // Update the version (single version field for backward compatibility)
        settings.setValue(persistScope, 'codingPlan.version', version);

        // Update the region
        settings.setValue(persistScope, 'codingPlan.region', region);

        const activeModel = config.getModel();

        addItem(
          {
            type: 'info',
            text: t(
              '{{region}} configuration updated successfully. Model switched to "{{model}}".',
              { region: regionName, model: activeModel },
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
      const { regionName } = getCodingPlanConfig(region);
      setUpdateRequest({
        prompt: t(
          'New model configurations are available for {{region}}. Update now?',
          { region: regionName },
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
