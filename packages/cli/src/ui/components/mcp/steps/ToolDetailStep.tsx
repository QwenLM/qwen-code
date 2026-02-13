/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';
import type { ToolDetailStepProps } from '../types.js';

export const ToolDetailStep: React.FC<ToolDetailStepProps> = ({
  tool,
  onBack,
}) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      }
    },
    { isActive: true },
  );

  if (!tool) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No tool selected')}</Text>
      </Box>
    );
  }

  // 格式化schema显示
  const formatSchema = (schema: object | undefined): string => {
    if (!schema) return t('No schema available');
    return JSON.stringify(schema, null, 2);
  };

  return (
    <Box flexDirection="column" gap={1}>
      {/* 工具名称 */}
      <Box>
        <Text bold>{tool.name}</Text>
      </Box>

      {/* 工具描述 */}
      {tool.description && (
        <Box marginTop={1}>
          <Text wrap="wrap">{tool.description}</Text>
        </Box>
      )}

      {/* 工具注解 */}
      {tool.annotations && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.primary}>{t('Annotations:')}</Text>
          <Box marginLeft={2} flexDirection="column">
            {tool.annotations.title && (
              <Text color={theme.text.secondary}>
                • {t('Title')}: {tool.annotations.title}
              </Text>
            )}
            {tool.annotations.readOnlyHint !== undefined && (
              <Text color={theme.text.secondary}>
                • {t('Read Only')}:{' '}
                {tool.annotations.readOnlyHint ? t('Yes') : t('No')}
              </Text>
            )}
            {tool.annotations.destructiveHint !== undefined && (
              <Text color={theme.text.secondary}>
                • {t('Destructive')}:{' '}
                {tool.annotations.destructiveHint ? t('Yes') : t('No')}
              </Text>
            )}
            {tool.annotations.idempotentHint !== undefined && (
              <Text color={theme.text.secondary}>
                • {t('Idempotent')}:{' '}
                {tool.annotations.idempotentHint ? t('Yes') : t('No')}
              </Text>
            )}
            {tool.annotations.openWorldHint !== undefined && (
              <Text color={theme.text.secondary}>
                • {t('Open World')}:{' '}
                {tool.annotations.openWorldHint ? t('Yes') : t('No')}
              </Text>
            )}
          </Box>
        </Box>
      )}

      {/* Schema */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.text.primary}>{t('Schema:')}</Text>
        <Box
          marginLeft={2}
          marginTop={1}
          padding={1}
          borderStyle="single"
          borderColor={theme.border.default}
        >
          <Text color={theme.text.secondary} wrap="wrap">
            {formatSchema(tool.schema)}
          </Text>
        </Box>
      </Box>

      {/* 所属服务器 */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Server')}: {tool.serverName}
        </Text>
      </Box>
    </Box>
  );
};
