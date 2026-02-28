/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { type Extension } from '@qwen-code/qwen-code-core';
import { t } from '../../../../i18n/index.js';

interface ExtensionDetailStepProps {
  selectedExtension: Extension | null;
}

export const ExtensionDetailStep = ({
  selectedExtension,
}: ExtensionDetailStepProps) => {
  if (!selectedExtension) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No extension selected')}</Text>
      </Box>
    );
  }

  const ext = selectedExtension;
  const isActive = ext.isActive;
  const activeColor = isActive ? theme.status.success : theme.text.secondary;
  const activeString = isActive ? t('active') : t('disabled');

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.text.primary}>{`${t('Name:')} `}</Text>
          <Text>{ext.name}</Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>{`${t('Version:')} `}</Text>
          <Text>{ext.version}</Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>{`${t('Status:')} `}</Text>
          <Text color={activeColor}>{activeString}</Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>{`${t('Path:')} `}</Text>
          <Text>{ext.path}</Text>
        </Box>

        {ext.installMetadata && (
          <Box>
            <Text color={theme.text.primary}>{`${t('Source:')} `}</Text>
            <Text>{ext.installMetadata.source}</Text>
          </Box>
        )}

        {ext.mcpServers && Object.keys(ext.mcpServers).length > 0 && (
          <Box>
            <Text color={theme.text.primary}>{`${t('MCP Servers:')} `}</Text>
            <Text>{Object.keys(ext.mcpServers).join(', ')}</Text>
          </Box>
        )}

        {ext.commands && ext.commands.length > 0 && (
          <Box>
            <Text color={theme.text.primary}>{`${t('Commands:')} `}</Text>
            <Text>{ext.commands.join(', ')}</Text>
          </Box>
        )}

        {ext.skills && ext.skills.length > 0 && (
          <Box>
            <Text color={theme.text.primary}>{`${t('Skills:')} `}</Text>
            <Text>{ext.skills.map((s) => s.name).join(', ')}</Text>
          </Box>
        )}

        {ext.agents && ext.agents.length > 0 && (
          <Box>
            <Text color={theme.text.primary}>{`${t('Agents:')} `}</Text>
            <Text>{ext.agents.map((a) => a.name).join(', ')}</Text>
          </Box>
        )}

        {ext.resolvedSettings && ext.resolvedSettings.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.text.primary}>{`${t('Settings:')} `}</Text>
            <Box flexDirection="column" paddingLeft={2}>
              {ext.resolvedSettings.map((setting) => (
                <Text key={setting.name}>
                  - {setting.name}: {setting.value}
                </Text>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};
