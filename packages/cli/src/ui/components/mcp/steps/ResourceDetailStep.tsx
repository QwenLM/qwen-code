/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';
import { buildMcpResourceRef } from '../../../hooks/mcpResourceRef.js';
import type { ResourceDetailStepProps } from '../types.js';

const LABEL_WIDTH = 15;

export const ResourceDetailStep: React.FC<ResourceDetailStepProps> = ({
  resource,
  onBack,
  isActive = true,
}) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      }
    },
    { isActive },
  );

  if (!resource) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No resource selected')}</Text>
      </Box>
    );
  }

  // 与 URI 不同时才展示友好名称，避免重复信息。
  const friendlyName = resource.title || resource.name;
  const showName = friendlyName && friendlyName !== resource.uri;

  return (
    <Box flexDirection="column" gap={1}>
      {/* 资源元信息 */}
      <Box flexDirection="column">
        <Box>
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('URI:')}</Text>
          </Box>
          <Box>
            <Text wrap="wrap">{resource.uri}</Text>
          </Box>
        </Box>

        {showName && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Name:')}</Text>
            </Box>
            <Box>
              <Text wrap="wrap">{friendlyName}</Text>
            </Box>
          </Box>
        )}

        {resource.mimeType && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('MIME Type:')}</Text>
            </Box>
            <Box>
              <Text wrap="truncate">{resource.mimeType}</Text>
            </Box>
          </Box>
        )}

        {typeof resource.size === 'number' && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Size:')}</Text>
            </Box>
            <Box>
              <Text>
                {t('{{count}} bytes', { count: String(resource.size) })}
              </Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* 资源描述 */}
      {resource.description && (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            {t('Description')}:
          </Text>
          <Text wrap="wrap">{resource.description}</Text>
        </Box>
      )}

      {/* 如何引用：告诉用户在对话里输入 @server:uri 即可注入内容 */}
      <Box flexDirection="column">
        <Text color={theme.text.primary} bold>
          {t('Reference in chat')}:
        </Text>
        <Text color={theme.text.accent}>
          @{buildMcpResourceRef(resource.serverName, resource.uri)}
        </Text>
      </Box>
    </Box>
  );
};
