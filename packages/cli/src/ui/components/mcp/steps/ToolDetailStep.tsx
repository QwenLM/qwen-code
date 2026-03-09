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

/**
 * 截断过长的字符串
 */
const truncate = (str: string, maxLen: number = 50): string => {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
};

/**
 * 渲染单个参数
 */
const renderParameter = (
  name: string,
  param: Record<string, unknown>,
  isRequired: boolean,
): React.ReactNode => {
  const type = (param['type'] as string) || 'any';
  const description = (param['description'] as string) || '';
  const defaultValue = param['default'];
  const enumValues = param['enum'] as string[] | undefined;

  return (
    <Box key={name} flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.text.primary}>• {name}</Text>
        {isRequired && (
          <Text color={theme.status.error}> ({t('required')})</Text>
        )}
      </Box>
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>{t('Type')}: </Text>
        <Text color={theme.status.success}>{type}</Text>
      </Box>
      {description && (
        <Box marginLeft={2}>
          <Text color={theme.text.secondary} wrap="wrap">
            {truncate(description, 80)}
          </Text>
        </Box>
      )}
      {enumValues && enumValues.length > 0 && (
        <Box marginLeft={2}>
          <Text color={theme.text.secondary}>
            {t('Enum')}: {enumValues.join(', ')}
          </Text>
        </Box>
      )}
      {defaultValue !== undefined && (
        <Box marginLeft={2}>
          <Text color={theme.text.secondary}>
            {t('Default')}:{' '}
            {typeof defaultValue === 'string'
              ? `"${truncate(defaultValue, 30)}"`
              : String(defaultValue)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * 渲染参数列表
 */
const ParametersList: React.FC<{
  properties: Record<string, unknown>;
  required: string[];
}> = ({ properties, required }) => {
  const requiredSet = new Set(required);

  return (
    <Box flexDirection="column">
      <Text color={theme.text.secondary}>{t('Parameters')}:</Text>
      <Box marginLeft={2} flexDirection="column">
        {Object.entries(properties).map(([name, param]) =>
          renderParameter(
            name,
            param as Record<string, unknown>,
            requiredSet.has(name),
          ),
        )}
      </Box>
    </Box>
  );
};

/**
 * 提取并展示schema的关键信息，使用类似示例的格式
 */
const SchemaSummary: React.FC<{ schema: object }> = ({ schema }) => {
  const obj = schema as Record<string, unknown>;
  const properties = obj['properties'] as Record<string, unknown> | undefined;
  const required = (obj['required'] as string[]) || [];

  return (
    <Box flexDirection="column">
      {/* 参数列表 */}
      {properties && Object.keys(properties).length > 0 && (
        <ParametersList properties={properties} required={required} />
      )}
    </Box>
  );
};

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

  return (
    <Box flexDirection="column" gap={1}>
      {/* 无效工具警告 */}
      {!tool.isValid && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.status.error} bold>
            {t('Warning: This tool cannot be called by the LLM')}
          </Text>
          <Text color={theme.status.error}>
            {t('Reason')}: {tool.invalidReason || t('unknown')}
          </Text>
          <Text color={theme.text.secondary}>
            {t(
              'Tools must have both name and description to be used by the LLM.',
            )}
          </Text>
        </Box>
      )}

      {/* 工具描述 */}
      {tool.description && (
        <Box>
          <Text wrap="wrap">{tool.description}</Text>
        </Box>
      )}

      {/* 工具注解 */}
      {tool.annotations && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.secondary}>{t('Annotations')}:</Text>
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
      {tool.schema && (
        <Box flexDirection="column" marginTop={1}>
          <SchemaSummary schema={tool.schema} />
        </Box>
      )}

      {/* 所属服务器 */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Server')}: {tool.serverName}
        </Text>
      </Box>
    </Box>
  );
};
