/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { loadSettings, SettingScope } from '../../../config/settings.js';
import {
  HooksConfigSource,
  type HookDefinition,
  type HookConfig,
  createDebugLogger,
  HOOKS_CONFIG_FIELDS,
} from '@qwen-code/qwen-code-core';
import type {
  HooksManagementDialogProps,
  HookEventDisplayInfo,
} from './types.js';
import { HOOKS_MANAGEMENT_STEPS } from './types.js';
import { HooksListStep } from './HooksListStep.js';
import { HookDetailStep } from './HookDetailStep.js';
import { HookConfigDetailStep } from './HookConfigDetailStep.js';
import { HooksDisabledStep } from './HooksDisabledStep.js';
import {
  DISPLAY_HOOK_EVENTS,
  getTranslatedSourceDisplayMap,
  createEmptyHookEventInfo,
} from './constants.js';
import { t } from '../../../i18n/index.js';

const debugLogger = createDebugLogger('HOOKS_DIALOG');

/**
 * Type guard to check if a value is a valid HookConfig
 */
function isValidHookConfig(config: unknown): config is HookConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'type' in config &&
    'command' in config &&
    typeof (config as HookConfig).command === 'string'
  );
}

/**
 * Type guard to check if a value is a valid HookDefinition
 */
function isValidHookDefinition(def: unknown): def is HookDefinition {
  if (typeof def !== 'object' || def === null) {
    return false;
  }
  const obj = def as Record<string, unknown>;
  // hooks array is required
  if (!('hooks' in obj) || !Array.isArray(obj['hooks'])) {
    return false;
  }
  // Validate each hook config in the array
  for (const hook of obj['hooks']) {
    if (!isValidHookConfig(hook)) {
      return false;
    }
  }
  // matcher is optional but must be a string if present
  if ('matcher' in obj && typeof obj['matcher'] !== 'string') {
    return false;
  }
  // sequential is optional but must be a boolean if present
  if ('sequential' in obj && typeof obj['sequential'] !== 'boolean') {
    return false;
  }
  return true;
}

/**
 * Type guard to check if a value is a valid hooks record
 */
function isValidHooksRecord(
  hooks: unknown,
): hooks is Record<string, HookDefinition[]> {
  if (typeof hooks !== 'object' || hooks === null) {
    return false;
  }
  const record = hooks as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    // Skip non-event configuration fields
    if (HOOKS_CONFIG_FIELDS.includes(key)) {
      continue;
    }
    if (!Array.isArray(value)) {
      return false;
    }
    for (const def of value) {
      if (!isValidHookDefinition(def)) {
        return false;
      }
    }
  }
  return true;
}

export function HooksManagementDialog({
  onClose,
}: HooksManagementDialogProps): React.JSX.Element {
  const config = useConfig();
  const { columns: width } = useTerminalSize();
  const boxWidth = width - 4;

  // Check if hooks are disabled
  // Note: This value is captured at dialog open time. If disableAllHooks
  // changes while the dialog is open (e.g., via settings.json edit),
  // the dialog will not react to the change until it's closed and reopened.
  // This is intentional - the dialog represents a snapshot of the current state.
  const disableAllHooks = config?.getDisableAllHooks() ?? false;

  const [navigationStack, setNavigationStack] = useState<string[]>([
    disableAllHooks
      ? HOOKS_MANAGEMENT_STEPS.HOOKS_DISABLED
      : HOOKS_MANAGEMENT_STEPS.HOOKS_LIST,
  ]);
  const [selectedHookIndex, setSelectedHookIndex] = useState<number>(-1);
  const [selectedConfigIndex, setSelectedConfigIndex] = useState<number>(-1);
  // Track selected index within each step for keyboard navigation
  const [listSelectedIndex, setListSelectedIndex] = useState<number>(0);
  const [detailSelectedIndex, setDetailSelectedIndex] = useState<number>(0);
  const [hooks, setHooks] = useState<HookEventDisplayInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Current step
  const currentStep =
    navigationStack[navigationStack.length - 1] ||
    HOOKS_MANAGEMENT_STEPS.HOOKS_LIST;

  // Selected hook event
  const selectedHook = useMemo(() => {
    if (selectedHookIndex >= 0 && selectedHookIndex < hooks.length) {
      return hooks[selectedHookIndex];
    }
    return null;
  }, [hooks, selectedHookIndex]);

  // Centralized keyboard handler
  useKeypress(
    (key) => {
      if (isLoading || loadError) {
        // Allow Escape to close even during loading/error states
        if (key.name === 'escape') {
          onClose();
        }
        return;
      }

      switch (currentStep) {
        case HOOKS_MANAGEMENT_STEPS.HOOKS_DISABLED:
          if (key.name === 'escape') {
            onClose();
          }
          break;

        case HOOKS_MANAGEMENT_STEPS.HOOKS_LIST:
          if (key.name === 'up') {
            setListSelectedIndex((prev) => Math.max(0, prev - 1));
          } else if (key.name === 'down') {
            setListSelectedIndex((prev) =>
              Math.min(hooks.length - 1, prev + 1),
            );
          } else if (key.name === 'return') {
            if (hooks.length > 0 && listSelectedIndex >= 0) {
              setSelectedHookIndex(listSelectedIndex);
              setSelectedConfigIndex(-1);
              setDetailSelectedIndex(0);
              setNavigationStack((prev) => [
                ...prev,
                HOOKS_MANAGEMENT_STEPS.HOOK_DETAIL,
              ]);
            }
          } else if (key.name === 'escape') {
            onClose();
          }
          break;

        case HOOKS_MANAGEMENT_STEPS.HOOK_DETAIL:
          if (key.name === 'escape') {
            handleNavigateBack();
          } else if (selectedHook && selectedHook.configs.length > 0) {
            if (key.name === 'up') {
              setDetailSelectedIndex((prev) => Math.max(0, prev - 1));
            } else if (key.name === 'down') {
              setDetailSelectedIndex((prev) =>
                Math.min(selectedHook.configs.length - 1, prev + 1),
              );
            } else if (key.name === 'return') {
              setSelectedConfigIndex(detailSelectedIndex);
              setNavigationStack((prev) => [
                ...prev,
                HOOKS_MANAGEMENT_STEPS.HOOK_CONFIG_DETAIL,
              ]);
            }
          }
          break;

        case HOOKS_MANAGEMENT_STEPS.HOOK_CONFIG_DETAIL:
          if (key.name === 'escape') {
            handleNavigateBack();
          }
          break;

        default:
          // No action for unknown steps
          break;
      }
    },
    { isActive: true },
  );

  // Load hooks data
  const fetchHooksData = useCallback((): HookEventDisplayInfo[] => {
    if (!config) return [];

    const settings = loadSettings();
    const userSettings = settings.forScope(SettingScope.User).settings;
    const workspaceSettings = settings.forScope(
      SettingScope.Workspace,
    ).settings;

    // Get translated source display map
    const sourceDisplayMap = getTranslatedSourceDisplayMap();

    const result: HookEventDisplayInfo[] = [];

    for (const eventName of DISPLAY_HOOK_EVENTS) {
      const hookInfo = createEmptyHookEventInfo(eventName);

      // Get hooks from user settings (with type validation)
      const userSettingsRecord = userSettings as Record<string, unknown>;
      const userHooksRaw = userSettingsRecord?.['hooks'];
      if (isValidHooksRecord(userHooksRaw) && userHooksRaw[eventName]) {
        for (const def of userHooksRaw[eventName]) {
          for (const hookConfig of def.hooks) {
            hookInfo.configs.push({
              config: hookConfig,
              source: HooksConfigSource.User,
              sourceDisplay: sourceDisplayMap[HooksConfigSource.User],
              enabled: true,
            });
          }
        }
      }

      // Get hooks from workspace settings (with type validation)
      const workspaceSettingsRecord = workspaceSettings as Record<
        string,
        unknown
      >;
      const workspaceHooksRaw = workspaceSettingsRecord?.['hooks'];
      if (
        isValidHooksRecord(workspaceHooksRaw) &&
        workspaceHooksRaw[eventName]
      ) {
        for (const def of workspaceHooksRaw[eventName]) {
          for (const hookConfig of def.hooks) {
            hookInfo.configs.push({
              config: hookConfig,
              source: HooksConfigSource.Project,
              sourceDisplay: sourceDisplayMap[HooksConfigSource.Project],
              enabled: true,
            });
          }
        }
      }

      // Get hooks from extensions (with type validation)
      const extensions = config.getExtensions() || [];
      for (const extension of extensions) {
        if (extension.isActive && extension.hooks?.[eventName]) {
          const extensionHooks = extension.hooks[eventName];
          if (Array.isArray(extensionHooks)) {
            for (const def of extensionHooks) {
              if (isValidHookDefinition(def)) {
                for (const hookConfig of def.hooks) {
                  hookInfo.configs.push({
                    config: hookConfig,
                    source: HooksConfigSource.Extensions,
                    sourceDisplay: extension.name,
                    sourcePath: extension.path,
                    enabled: true,
                  });
                }
              }
            }
          }
        }
      }

      result.push(hookInfo);
    }

    return result;
  }, [config]);

  // Load hooks data on initial render
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    try {
      const hooksData = fetchHooksData();
      if (!cancelled) {
        setHooks(hooksData);
      }
    } catch (error) {
      if (!cancelled) {
        debugLogger.error('Error loading hooks:', error);
        setLoadError(
          error instanceof Error ? error.message : 'Failed to load hooks',
        );
      }
    } finally {
      if (!cancelled) {
        setIsLoading(false);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [fetchHooksData]);

  // Navigation handler for going back
  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) {
        onClose();
        return prev;
      }
      return prev.slice(0, -1);
    });
  }, [onClose]);

  // Selected hook config
  const selectedConfig = useMemo(() => {
    if (
      selectedHook &&
      selectedConfigIndex >= 0 &&
      selectedConfigIndex < selectedHook.configs.length
    ) {
      return selectedHook.configs[selectedConfigIndex];
    }
    return null;
  }, [selectedHook, selectedConfigIndex]);

  // Calculate total configured hooks count
  const configuredHooksCount = useMemo(
    () => hooks.reduce((sum, hook) => sum + hook.configs.length, 0),
    [hooks],
  );

  // Render based on current step
  const renderContent = () => {
    // Show disabled state first (before loading check)
    if (currentStep === HOOKS_MANAGEMENT_STEPS.HOOKS_DISABLED) {
      return <HooksDisabledStep configuredHooksCount={configuredHooksCount} />;
    }

    if (isLoading) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.text.secondary}>{t('Loading hooks...')}</Text>
        </Box>
      );
    }

    if (loadError) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.status.error}>{t('Error loading hooks:')}</Text>
          <Text color={theme.text.secondary}>{loadError}</Text>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Press Escape to close')}
            </Text>
          </Box>
        </Box>
      );
    }

    switch (currentStep) {
      case HOOKS_MANAGEMENT_STEPS.HOOKS_LIST:
        return (
          <HooksListStep hooks={hooks} selectedIndex={listSelectedIndex} />
        );

      case HOOKS_MANAGEMENT_STEPS.HOOK_DETAIL:
        if (selectedHook) {
          return (
            <HookDetailStep
              hook={selectedHook}
              selectedIndex={detailSelectedIndex}
            />
          );
        }
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text color={theme.text.secondary}>{t('No hook selected')}</Text>
          </Box>
        );

      case HOOKS_MANAGEMENT_STEPS.HOOK_CONFIG_DETAIL:
        if (selectedHook && selectedConfig) {
          return (
            <HookConfigDetailStep
              hookEvent={selectedHook}
              hookConfig={selectedConfig}
            />
          );
        }
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text color={theme.text.secondary}>
              {t('No hook config selected')}
            </Text>
          </Box>
        );

      default:
        return null;
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      width={boxWidth}
      paddingX={1}
      paddingY={1}
    >
      {renderContent()}
    </Box>
  );
}
