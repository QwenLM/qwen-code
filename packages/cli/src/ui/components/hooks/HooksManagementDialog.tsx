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
import { keyMatchers, Command } from '../../keyMatchers.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { buildHooksListing } from '@qwen-code/qwen-code-core/hooks/hooks-listing.js';
import type {
  HooksManagementDialogProps,
  HookEventDisplayInfo,
} from './types.js';
import { HOOKS_MANAGEMENT_STEPS } from './types.js';
import { addConfigToMatcherGroup, getAllConfigs } from './matcherGrouping.js';
import { HooksListStep } from './HooksListStep.js';
import { HookDetailStep } from './HookDetailStep.js';
import { HookMatcherDetailStep } from './HookMatcherDetailStep.js';
import { HookConfigDetailStep } from './HookConfigDetailStep.js';
import { HooksDisabledStep } from './HooksDisabledStep.js';
import {
  DISPLAY_HOOK_EVENTS,
  getTranslatedSourceDisplayMap,
  createEmptyHookEventInfo,
  supportsMatchers,
} from './constants.js';
import { t } from '../../../i18n/index.js';

const debugLogger = createDebugLogger('HOOKS_DIALOG');

export function HooksManagementDialog({
  onClose,
}: HooksManagementDialogProps): React.JSX.Element {
  const config = useConfig();
  const { columns: width } = useTerminalSize();
  const boxWidth = width - 4;

  const disableAllHooks = config?.getDisableAllHooks() ?? false;

  const [navigationStack, setNavigationStack] = useState<string[]>([
    disableAllHooks
      ? HOOKS_MANAGEMENT_STEPS.HOOKS_DISABLED
      : HOOKS_MANAGEMENT_STEPS.HOOKS_LIST,
  ]);
  const [selectedHookIndex, setSelectedHookIndex] = useState<number>(-1);
  const [selectedMatcherIndex, setSelectedMatcherIndex] = useState<number>(-1);
  const [selectedConfigIndex, setSelectedConfigIndex] = useState<number>(-1);
  const [listSelectedIndex, setListSelectedIndex] = useState<number>(0);
  const [detailSelectedIndex, setDetailSelectedIndex] = useState<number>(0);
  const [matcherSelectedIndex, setMatcherSelectedIndex] = useState<number>(0);
  const [hooks, setHooks] = useState<HookEventDisplayInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const currentStep =
    navigationStack[navigationStack.length - 1] ||
    HOOKS_MANAGEMENT_STEPS.HOOKS_LIST;

  const selectedHook = useMemo(() => {
    if (selectedHookIndex >= 0 && selectedHookIndex < hooks.length) {
      return hooks[selectedHookIndex];
    }
    return null;
  }, [hooks, selectedHookIndex]);

  const selectedMatcher = useMemo(() => {
    if (
      selectedHook &&
      selectedMatcherIndex >= 0 &&
      selectedMatcherIndex < selectedHook.matcherGroups.length
    ) {
      return selectedHook.matcherGroups[selectedMatcherIndex];
    }
    return null;
  }, [selectedHook, selectedMatcherIndex]);

  useKeypress(
    (key) => {
      if (isLoading || loadError) {
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
          if (keyMatchers[Command.SELECTION_UP](key)) {
            setListSelectedIndex((prev) => Math.max(0, prev - 1));
          } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
            setListSelectedIndex((prev) =>
              Math.min(hooks.length - 1, prev + 1),
            );
          } else if (key.name === 'return') {
            if (hooks.length > 0 && listSelectedIndex >= 0) {
              setSelectedHookIndex(listSelectedIndex);
              setSelectedMatcherIndex(-1);
              setSelectedConfigIndex(-1);
              setDetailSelectedIndex(0);
              setMatcherSelectedIndex(0);
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
          } else if (selectedHook) {
            const matcherMode = supportsMatchers(selectedHook.event);
            if (matcherMode) {
              if (selectedHook.matcherGroups.length === 0) {
                break;
              }
              if (keyMatchers[Command.SELECTION_UP](key)) {
                setDetailSelectedIndex((prev) => Math.max(0, prev - 1));
              } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
                setDetailSelectedIndex((prev) =>
                  Math.min(selectedHook.matcherGroups.length - 1, prev + 1),
                );
              } else if (key.name === 'return') {
                setSelectedMatcherIndex(detailSelectedIndex);
                setMatcherSelectedIndex(0);
                setSelectedConfigIndex(-1);
                setNavigationStack((prev) => [
                  ...prev,
                  HOOKS_MANAGEMENT_STEPS.HOOK_MATCHER_DETAIL,
                ]);
              }
            } else {
              const flatConfigs = getAllConfigs(selectedHook);
              if (flatConfigs.length === 0) {
                break;
              }
              if (keyMatchers[Command.SELECTION_UP](key)) {
                setDetailSelectedIndex((prev) => Math.max(0, prev - 1));
              } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
                setDetailSelectedIndex((prev) =>
                  Math.min(flatConfigs.length - 1, prev + 1),
                );
              } else if (key.name === 'return') {
                setSelectedMatcherIndex(-1);
                setSelectedConfigIndex(detailSelectedIndex);
                setNavigationStack((prev) => [
                  ...prev,
                  HOOKS_MANAGEMENT_STEPS.HOOK_CONFIG_DETAIL,
                ]);
              }
            }
          }
          break;

        case HOOKS_MANAGEMENT_STEPS.HOOK_MATCHER_DETAIL:
          if (key.name === 'escape') {
            handleNavigateBack();
          } else if (selectedMatcher && selectedMatcher.configs.length > 0) {
            if (keyMatchers[Command.SELECTION_UP](key)) {
              setMatcherSelectedIndex((prev) => Math.max(0, prev - 1));
            } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
              setMatcherSelectedIndex((prev) =>
                Math.min(selectedMatcher.configs.length - 1, prev + 1),
              );
            } else if (key.name === 'return') {
              setSelectedConfigIndex(matcherSelectedIndex);
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
          break;
      }
    },
    { isActive: true },
  );

  const fetchHooksData = useCallback((): HookEventDisplayInfo[] => {
    if (!config) return [];

    const listing = buildHooksListing(config);
    const sourceDisplayMap = getTranslatedSourceDisplayMap();
    return DISPLAY_HOOK_EVENTS.map((eventName) => {
      const hookInfo = createEmptyHookEventInfo(eventName);
      const groupByMatcher = supportsMatchers(eventName);
      for (const row of listing.rows) {
        if (row.eventName !== eventName) continue;
        addConfigToMatcherGroup(
          hookInfo,
          row.matcher,
          row.sequential,
          {
            config: row.config,
            source: row.source,
            sourceDisplay:
              row.extensionName ??
              (row.source === 'extensions' ? '' : sourceDisplayMap[row.source]),
            sourcePath: row.extensionPath,
            enabled: row.enabled,
            skillRoot: row.skillRoot,
          },
          groupByMatcher,
        );
      }
      return hookInfo;
    });
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    try {
      debugLogger.debug('Fetching hooks data for dialog');
      const hooksData = fetchHooksData();
      debugLogger.debug('Hooks data fetched:', hooksData.length, 'events');
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

  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) {
        onClose();
        return prev;
      }
      return prev.slice(0, -1);
    });
  }, [onClose]);

  const selectedConfig = useMemo(() => {
    if (!selectedHook) return null;
    if (!supportsMatchers(selectedHook.event)) {
      const flatConfigs = getAllConfigs(selectedHook);
      if (
        selectedConfigIndex >= 0 &&
        selectedConfigIndex < flatConfigs.length
      ) {
        return flatConfigs[selectedConfigIndex];
      }
      return null;
    }
    if (
      selectedMatcher &&
      selectedConfigIndex >= 0 &&
      selectedConfigIndex < selectedMatcher.configs.length
    ) {
      return selectedMatcher.configs[selectedConfigIndex];
    }
    return null;
  }, [selectedHook, selectedMatcher, selectedConfigIndex]);

  const configuredHooksCount = useMemo(
    () =>
      hooks.reduce(
        (sum, hook) =>
          sum + hook.matcherGroups.reduce((s, g) => s + g.configs.length, 0),
        0,
      ),
    [hooks],
  );

  const renderContent = () => {
    if (currentStep === HOOKS_MANAGEMENT_STEPS.HOOKS_DISABLED) {
      return (
        <HooksDisabledStep
          configuredHooksCount={
            config?.getHookSystem() ? configuredHooksCount : undefined
          }
        />
      );
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
          <HooksListStep
            hooks={hooks}
            selectedIndex={listSelectedIndex}
            hooksReloadable={Boolean(config?.getHookSystem())}
          />
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

      case HOOKS_MANAGEMENT_STEPS.HOOK_MATCHER_DETAIL:
        if (selectedHook && selectedMatcher) {
          return (
            <HookMatcherDetailStep
              hookEvent={selectedHook}
              matcherGroup={selectedMatcher}
              selectedIndex={matcherSelectedIndex}
            />
          );
        }
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text color={theme.text.secondary}>{t('No matcher selected')}</Text>
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
