/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { loadSettings, SettingScope } from '../../../config/settings.js';
import {
  HooksConfigSource,
  type HookDefinition,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import type {
  HooksManagementDialogProps,
  HookEventDisplayInfo,
} from './types.js';
import { HOOKS_MANAGEMENT_STEPS } from './types.js';
import { HooksListStep } from './HooksListStep.js';
import { HookDetailStep } from './HookDetailStep.js';
import {
  DISPLAY_HOOK_EVENTS,
  getTranslatedSourceDisplayMap,
  createEmptyHookEventInfo,
} from './constants.js';
import { t } from '../../../i18n/index.js';

const debugLogger = createDebugLogger('HOOKS_DIALOG');

export function HooksManagementDialog({
  onClose,
}: HooksManagementDialogProps): React.JSX.Element {
  const config = useConfig();
  const { columns: width } = useTerminalSize();
  const boxWidth = width - 4;

  const [navigationStack, setNavigationStack] = useState<string[]>([
    HOOKS_MANAGEMENT_STEPS.HOOKS_LIST,
  ]);
  const [selectedHookIndex, setSelectedHookIndex] = useState<number>(-1);
  const [hooks, setHooks] = useState<HookEventDisplayInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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

      // Get hooks from user settings
      const userHooks = (userSettings as Record<string, unknown>)?.['hooks'] as
        | Record<string, HookDefinition[]>
        | undefined;
      if (userHooks?.[eventName]) {
        for (const def of userHooks[eventName]) {
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

      // Get hooks from workspace settings
      const workspaceHooks = (workspaceSettings as Record<string, unknown>)?.[
        'hooks'
      ] as Record<string, HookDefinition[]> | undefined;
      if (workspaceHooks?.[eventName]) {
        for (const def of workspaceHooks[eventName]) {
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

      // Get hooks from extensions
      const extensions = config.getExtensions() || [];
      for (const extension of extensions) {
        if (extension.isActive && extension.hooks?.[eventName]) {
          for (const def of extension.hooks[eventName]!) {
            for (const hookConfig of def.hooks) {
              hookInfo.configs.push({
                config: hookConfig,
                source: HooksConfigSource.Extensions,
                sourceDisplay: sourceDisplayMap[HooksConfigSource.Extensions],
                enabled: true,
              });
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
    setIsLoading(true);
    setLoadError(null);
    try {
      const hooksData = fetchHooksData();
      setHooks(hooksData);
    } catch (error) {
      debugLogger.error('Error loading hooks:', error);
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load hooks',
      );
    } finally {
      setIsLoading(false);
    }
  }, [fetchHooksData]);

  // Current step
  const getCurrentStep = useCallback(
    () =>
      navigationStack[navigationStack.length - 1] ||
      HOOKS_MANAGEMENT_STEPS.HOOKS_LIST,
    [navigationStack],
  );

  // Navigation handlers
  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) {
        onClose();
        return prev;
      }
      return prev.slice(0, -1);
    });
  }, [onClose]);

  // Handle escape key globally
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        handleNavigateBack();
      }
    },
    { isActive: getCurrentStep() === HOOKS_MANAGEMENT_STEPS.HOOKS_LIST },
  );

  // Select hook
  const handleSelectHook = useCallback((index: number) => {
    setSelectedHookIndex(index);
    setNavigationStack((prev) => [...prev, HOOKS_MANAGEMENT_STEPS.HOOK_DETAIL]);
  }, []);

  // Selected hook
  const selectedHook = useMemo(() => {
    if (selectedHookIndex >= 0 && selectedHookIndex < hooks.length) {
      return hooks[selectedHookIndex];
    }
    return null;
  }, [hooks, selectedHookIndex]);

  // Render based on current step
  const renderContent = () => {
    const currentStep = getCurrentStep();

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
          <HooksListStep
            hooks={hooks}
            onSelect={handleSelectHook}
            onCancel={onClose}
          />
        );

      case HOOKS_MANAGEMENT_STEPS.HOOK_DETAIL:
        if (selectedHook) {
          return (
            <HookDetailStep hook={selectedHook} onBack={handleNavigateBack} />
          );
        }
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text color={theme.text.secondary}>{t('No hook selected')}</Text>
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
