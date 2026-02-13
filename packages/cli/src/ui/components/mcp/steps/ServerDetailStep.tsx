/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { t } from '../../../../i18n/index.js';
import type { ServerDetailStepProps } from '../types.js';
import {
  getStatusColor,
  getStatusIcon,
  formatServerCommand,
} from '../utils.js';

type ServerAction = 'view-tools' | 'view-logs' | 'reconnect' | 'toggle-disable';

export const ServerDetailStep: React.FC<ServerDetailStepProps> = ({
  server,
  onViewTools,
  onViewLogs,
  onReconnect,
  onDisable,
  onBack,
}) => {
  const [selectedAction, setSelectedAction] =
    useState<ServerAction>('view-tools');

  const statusColor = server ? getStatusColor(server.status) : 'gray';

  const actions = [
    {
      key: 'view-tools',
      get label() {
        return t('View tools');
      },
      value: 'view-tools' as const,
    },
    {
      key: 'view-logs',
      get label() {
        return t('View logs');
      },
      value: 'view-logs' as const,
    },
    {
      key: 'reconnect',
      get label() {
        return t('Reconnect');
      },
      value: 'reconnect' as const,
    },
    {
      key: 'toggle-disable',
      get label() {
        return server?.isDisabled ? t('Enable') : t('Disable');
      },
      value: 'toggle-disable' as const,
    },
  ];

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      } else if (key.name === 'return') {
        switch (selectedAction) {
          case 'view-tools':
            onViewTools();
            break;
          case 'view-logs':
            onViewLogs?.();
            break;
          case 'reconnect':
            onReconnect?.();
            break;
          case 'toggle-disable':
            onDisable?.();
            break;
          default:
            break;
        }
      }
    },
    { isActive: true },
  );

  if (!server) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No server selected')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* 服务器详情 */}
      <Box flexDirection="column">
        <Box>
          <Text color={theme.text.primary}>{t('Status:')}</Text>
          <Box marginLeft={2}>
            <Text
              color={
                statusColor === 'green'
                  ? theme.status.success
                  : statusColor === 'yellow'
                    ? theme.status.warning
                    : theme.status.error
              }
            >
              {getStatusIcon(server.status)} {t(server.status)}
              {server.isDisabled && (
                <Text color={theme.status.warning}> (disabled)</Text>
              )}
            </Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Source:')}</Text>
          <Box marginLeft={2}>
            <Text color={theme.text.secondary}>
              {server.scope === 'user'
                ? t('User Settings')
                : server.scope === 'workspace'
                  ? t('Workspace Settings')
                  : t('Extension')}
            </Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Command:')}</Text>
          <Box marginLeft={2}>
            <Text wrap="truncate">{formatServerCommand(server)}</Text>
          </Box>
        </Box>

        {server.config.cwd && (
          <Box marginTop={1}>
            <Text color={theme.text.primary}>{t('Working Directory:')}</Text>
            <Box marginLeft={2}>
              <Text wrap="truncate">{server.config.cwd}</Text>
            </Box>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Capabilities:')}</Text>
          <Box marginLeft={2}>
            <Text>
              {server.toolCount > 0 ? t('tools') : ''}
              {server.toolCount > 0 && server.promptCount > 0 ? ', ' : ''}
              {server.promptCount > 0 ? t('prompts') : ''}
            </Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Tools:')}</Text>
          <Box marginLeft={2}>
            <Text>
              {server.toolCount}{' '}
              {server.toolCount === 1 ? t('tool') : t('tools')}
            </Text>
          </Box>
        </Box>

        {server.errorMessage && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{t('Error:')}</Text>
            <Box marginLeft={2}>
              <Text color={theme.status.error} wrap="wrap">
                {server.errorMessage}
              </Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* 操作列表 */}
      <Box marginTop={1}>
        <RadioButtonSelect<ServerAction>
          items={actions}
          onHighlight={(value: ServerAction) => setSelectedAction(value)}
          onSelect={(value: ServerAction) => {
            switch (value) {
              case 'view-tools':
                onViewTools();
                break;
              case 'view-logs':
                onViewLogs?.();
                break;
              case 'reconnect':
                onReconnect?.();
                break;
              case 'toggle-disable':
                onDisable?.();
                break;
              default:
                break;
            }
          }}
        />
      </Box>
    </Box>
  );
};
