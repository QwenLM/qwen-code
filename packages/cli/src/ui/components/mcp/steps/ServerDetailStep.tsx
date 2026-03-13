/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
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

// 标签列宽度
const LABEL_WIDTH = 15;

type ServerAction =
  | 'view-tools'
  | 'reconnect'
  | 'toggle-disable'
  | 'authenticate'
  | 'clear-auth';

export const ServerDetailStep: React.FC<ServerDetailStepProps> = ({
  server,
  onViewTools,
  onReconnect,
  onDisable,
  onAuthenticate,
  onClearAuth,
  onBack,
}) => {
  const statusColor = server
    ? server.isDisabled
      ? 'yellow'
      : getStatusColor(server.status)
    : 'gray';

  // 根据服务器状态动态生成可用操作
  const actions = useMemo(() => {
    const result: Array<{
      key: string;
      label: string;
      value: ServerAction;
    }> = [];

    if (!server) {
      return result;
    }

    // 只在服务器未禁用且有工具时显示"查看工具"选项
    if (!server.isDisabled && (server.toolCount ?? 0) > 0) {
      result.push({
        key: 'view-tools',
        label: t('View tools'),
        value: 'view-tools',
      });
    }

    // 只在服务器未禁用且已断开连接时显示"重新连接"选项
    if (!server.isDisabled && server.status === 'disconnected') {
      result.push({
        key: 'reconnect',
        label: t('Reconnect'),
        value: 'reconnect',
      });
    }

    // 始终显示启用/禁用选项
    result.push({
      key: 'toggle-disable',
      label: server?.isDisabled ? t('Enable') : t('Disable'),
      value: 'toggle-disable',
    });

    // 已认证的服务器显示"重新认证"，未认证的显示"认证"
    if (!server.isDisabled) {
      result.push({
        key: 'authenticate',
        label: server.hasOAuthTokens ? t('Re-authenticate') : t('Authenticate'),
        value: 'authenticate',
      });
    }

    // 只在存储有 OAuth 认证信息时显示“清空认证”选项
    if (!server.isDisabled && server.hasOAuthTokens) {
      result.push({
        key: 'clear-auth',
        label: t('Clear Authentication'),
        value: 'clear-auth',
      });
    }

    return result;
  }, [server]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
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
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('Status:')}</Text>
          </Box>
          <Box>
            <Text
              color={
                statusColor === 'green'
                  ? theme.status.success
                  : statusColor === 'yellow'
                    ? theme.status.warning
                    : theme.status.error
              }
            >
              {getStatusIcon(server.status)}{' '}
              {server.isDisabled ? t('disabled') : t(server.status)}
            </Text>
          </Box>
        </Box>

        <Box>
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('Source:')}</Text>
          </Box>
          <Box>
            <Text color={theme.text.primary}>
              {server.source === 'user'
                ? t('User Settings')
                : server.source === 'project'
                  ? t('Workspace Settings')
                  : t('Extension')}
            </Text>
          </Box>
        </Box>

        <Box>
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('Command:')}</Text>
          </Box>
          <Box>
            <Text wrap="truncate">{formatServerCommand(server)}</Text>
          </Box>
        </Box>

        {server.config.cwd && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Working Directory:')}</Text>
            </Box>
            <Box>
              <Text wrap="truncate">{server.config.cwd}</Text>
            </Box>
          </Box>
        )}

        {!server.isDisabled && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Tools:')}</Text>
            </Box>
            <Box>
              <Text>
                {server.toolCount}{' '}
                {server.toolCount === 1 ? t('tool') : t('tools')}
                {!!server.invalidToolCount && server.invalidToolCount > 0 && (
                  <Text color={theme.status.warning}>
                    {' '}
                    ({server.invalidToolCount}{' '}
                    {server.invalidToolCount === 1
                      ? t('invalid')
                      : t('invalid')}
                    )
                  </Text>
                )}
              </Text>
            </Box>
          </Box>
        )}

        {server.errorMessage && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.status.error}>{t('Error:')}</Text>
            </Box>
            <Box>
              <Text color={theme.status.error} wrap="wrap">
                {server.errorMessage}
              </Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* 操作列表 */}
      <Box>
        <RadioButtonSelect<ServerAction>
          items={actions}
          showNumbers={false}
          onSelect={(value: ServerAction) => {
            switch (value) {
              case 'view-tools':
                onViewTools();
                break;
              case 'reconnect':
                onReconnect?.();
                break;
              case 'toggle-disable':
                onDisable?.();
                break;
              case 'authenticate':
                onAuthenticate?.();
                break;
              case 'clear-auth':
                onClearAuth?.();
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
