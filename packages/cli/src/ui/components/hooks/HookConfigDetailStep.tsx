/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import type { HookConfigDisplayInfo, HookEventDisplayInfo } from './types.js';
import { HooksConfigSource } from '@qwen-code/qwen-code-core';
import { t } from '../../../i18n/index.js';
import {
  getTranslatedSourceDisplayMap,
  supportsMatchers,
} from './constants.js';

interface HookConfigDetailStepProps {
  hookEvent: HookEventDisplayInfo;
  hookConfig: HookConfigDisplayInfo;
}

export function HookConfigDetailStep({
  hookEvent,
  hookConfig,
}: HookConfigDetailStepProps): React.JSX.Element {
  const { columns: terminalWidth } = useTerminalSize();

  const sourceDisplay = getTranslatedSourceDisplayMap()[hookConfig.source];

  const isFromExtension = hookConfig.source === HooksConfigSource.Extensions;

  const getHookTypeDisplay = (): string => {
    switch (hookConfig.config.type) {
      case 'command':
        return 'command';
      default:
        return hookConfig.config.type;
    }
  };

  const getCommand = (): string => {
    if (hookConfig.config.type === 'command') {
      return hookConfig.config.command;
    }
    return '';
  };

  const getPrompt = (): string => {
    if (hookConfig.config.type === 'prompt') {
      return hookConfig.config.prompt;
    }
    return '';
  };

  const getUrl = (): string => {
    if (hookConfig.config.type === 'http') {
      return hookConfig.config.url;
    }
    return '';
  };

  const commandBoxWidth = Math.min(terminalWidth - 6, 80);

  const labelWidth = 12;
  const showMatcher = supportsMatchers(hookEvent.event);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          {t('Hook details')}
        </Text>
      </Box>

      <Box>
        <Box width={labelWidth}>
          <Text color={theme.text.secondary}>{t('Event:')}</Text>
        </Box>
        <Text color={theme.text.primary}>{hookEvent.event}</Text>
      </Box>

      {showMatcher && (
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Matcher:')}</Text>
          </Box>
          <Text color={theme.text.primary}>{hookConfig.matcher || '*'}</Text>
        </Box>
      )}

      <Box>
        <Box width={labelWidth}>
          <Text color={theme.text.secondary}>{t('Type:')}</Text>
        </Box>
        <Text color={theme.text.primary}>{getHookTypeDisplay()}</Text>
      </Box>

      <Box>
        <Box width={labelWidth}>
          <Text color={theme.text.secondary}>{t('Source:')}</Text>
        </Box>
        <Text color={theme.text.primary}>{sourceDisplay}</Text>
        {hookConfig.sourcePath && (
          <Text color={theme.text.secondary}> ({hookConfig.sourcePath})</Text>
        )}
      </Box>

      {isFromExtension && hookConfig.sourceDisplay && (
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Extension:')}</Text>
          </Box>
          <Text color={theme.text.primary}>{hookConfig.sourceDisplay}</Text>
        </Box>
      )}

      {hookConfig.config.name && (
        <Box>
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{t('Name:')}</Text>
          </Box>
          <Text color={theme.text.primary}>{hookConfig.config.name}</Text>
        </Box>
      )}

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

      {hookConfig.config.type === 'command' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Command:')}</Text>
          </Box>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.border.default}
            paddingX={1}
            width={commandBoxWidth}
          >
            <Text color={theme.text.primary}>{getCommand()}</Text>
          </Box>
        </>
      )}

      {hookConfig.config.type === 'prompt' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Prompt:')}</Text>
          </Box>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.border.default}
            paddingX={1}
            width={commandBoxWidth}
          >
            <Text color={theme.text.primary}>{getPrompt()}</Text>
          </Box>
        </>
      )}

      {hookConfig.config.type === 'http' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('URL:')}</Text>
          </Box>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.border.default}
            paddingX={1}
            width={commandBoxWidth}
          >
            <Text color={theme.text.primary}>{getUrl()}</Text>
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t(
            'To modify or remove this hook, edit settings.json directly or ask Qwen to help.',
          )}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{t('Esc to go back')}</Text>
      </Box>
    </Box>
  );
}
