/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { HookConfigDisplayInfo, HookEventDisplayInfo } from './types.js';
import {
  HooksConfigSource,
  type HookConfig,
  type PromptHookConfig,
} from '@qwen-code/qwen-code-core';
import { t } from '../../../i18n/index.js';

// Type guard to check if hook config is a prompt hook
function isPromptHook(config: HookConfig): config is PromptHookConfig {
  return config.type === 'prompt';
}

interface HookConfigDetailStepProps {
  hookEvent: HookEventDisplayInfo;
  hookConfig: HookConfigDisplayInfo;
}

export function HookConfigDetailStep({
  hookEvent,
  hookConfig,
}: HookConfigDetailStepProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();

  // Get source display
  const getSourceDisplay = (): string => {
    switch (hookConfig.source) {
      case HooksConfigSource.Project:
        return t('Local Settings');
      case HooksConfigSource.User:
        return t('User Settings');
      case HooksConfigSource.System:
        return t('System Settings');
      case HooksConfigSource.Extensions:
        return t('Extensions');
      default:
        return hookConfig.source;
    }
  };

  // Check if this is from an extension
  const isFromExtension = hookConfig.source === HooksConfigSource.Extensions;

  // Get hook type display
  const getHookTypeDisplay = (): string => {
    if (isPromptHook(hookConfig.config)) {
      return 'prompt';
    }
    return 'command';
  };

  // Get command to display
  const getCommand = (): string => {
    if (!isPromptHook(hookConfig.config)) {
      return hookConfig.config.command;
    }
    return '';
  };

  // Get prompt to display
  const getPrompt = (): string => {
    if (isPromptHook(hookConfig.config)) {
      return hookConfig.config.prompt;
    }
    return '';
  };

  // Check if this is a prompt hook
  const isPromptHookType = isPromptHook(hookConfig.config);

  // Calculate box width for command/prompt display
  const commandBoxWidth = Math.min(terminalWidth - 6, 80);

  // Label width for alignment (Extension: is the longest label)
  const labelWidth = 12;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          {t('Hook details')}
        </Text>
      </Box>

      {/* Event */}
      <Box>
        <Box width={labelWidth}>
          <Text color={theme.text.secondary}>{t('Event:')}</Text>
        </Box>
        <Text color={theme.text.primary}>{hookEvent.event}</Text>
      </Box>

      {/* Type */}
      <Box>
        <Box width={labelWidth}>
          <Text color={theme.text.secondary}>{t('Type:')}</Text>
        </Box>
        <Text color={theme.text.primary}>{getHookTypeDisplay()}</Text>
      </Box>

      {/* Source */}
      <Box>
        <Box width={labelWidth}>
          <Text color={theme.text.secondary}>{t('Source:')}</Text>
        </Box>
        <Text color={theme.text.primary}>{getSourceDisplay()}</Text>
        {hookConfig.sourcePath && (
          <Text color={theme.text.secondary}> ({hookConfig.sourcePath})</Text>
        )}
      </Box>

      {/* Extension name (only for extensions) */}
      {isFromExtension && hookConfig.sourceDisplay && (
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Extension:')}</Text>
          </Box>
          <Text color={theme.text.primary}>{hookConfig.sourceDisplay}</Text>
        </Box>
      )}

      {/* Name (if exists) */}
      {hookConfig.config.name && (
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Name:')}</Text>
          </Box>
          <Text color={theme.text.primary}>{hookConfig.config.name}</Text>
        </Box>
      )}

      {/* Description (if exists) */}
      {hookConfig.config.description && (
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Desc:')}</Text>
          </Box>
          <Text color={theme.text.primary}>
            {hookConfig.config.description}
          </Text>
        </Box>
      )}

      {/* Command/Prompt section */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {isPromptHookType ? t('Prompt:') : t('Command:')}
        </Text>
      </Box>

      {/* Command/Prompt box */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        width={commandBoxWidth}
      >
        <Text color={theme.text.primary}>
          {isPromptHookType ? getPrompt() : getCommand()}
        </Text>
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t(
            'To modify or remove this hook, edit settings.json directly or ask Qwen to help.',
          )}
        </Text>
      </Box>

      {/* Footer hint */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{t('Esc to go back')}</Text>
      </Box>
    </Box>
  );
}
