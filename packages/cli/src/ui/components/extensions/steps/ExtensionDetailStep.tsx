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

  // Fixed width for labels to ensure alignment
  const LABEL_WIDTH = 12;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text color={theme.text.primary}>{t('Name:')}</Text>
          </Box>
          <Text>{ext.name}</Text>
        </Box>

        <Box>
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text color={theme.text.primary}>{t('Version:')}</Text>
          </Box>
          <Text>{ext.version}</Text>
        </Box>

        <Box>
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text color={theme.text.primary}>{t('Status:')}</Text>
          </Box>
          <Text color={activeColor}>{activeString}</Text>
        </Box>

        <Box>
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text color={theme.text.primary}>{t('Path:')}</Text>
          </Box>
          <Text>{ext.path}</Text>
        </Box>

        {ext.installMetadata && (
          <Box>
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text color={theme.text.primary}>{t('Source:')}</Text>
            </Box>
            <Text>{ext.installMetadata.source}</Text>
          </Box>
        )}

        {ext.mcpServers && Object.keys(ext.mcpServers).length > 0 && (
          <Box>
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text color={theme.text.primary}>{t('MCP Servers:')}</Text>
            </Box>
            <Text>{Object.keys(ext.mcpServers).join(', ')}</Text>
          </Box>
        )}

        {ext.commands && ext.commands.length > 0 && (
          <Box>
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text color={theme.text.primary}>{t('Commands:')}</Text>
            </Box>
            <Text>{ext.commands.join(', ')}</Text>
          </Box>
        )}

        {ext.skills && ext.skills.length > 0 && (
          <Box>
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text color={theme.text.primary}>{t('Skills:')}</Text>
            </Box>
            <Text>{ext.skills.map((s) => s.name).join(', ')}</Text>
          </Box>
        )}

        {ext.agents && ext.agents.length > 0 && (
          <Box>
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text color={theme.text.primary}>{t('Agents:')}</Text>
            </Box>
            <Text>{ext.agents.map((a) => a.name).join(', ')}</Text>
          </Box>
        )}

        {ext.resolvedSettings && ext.resolvedSettings.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box width={LABEL_WIDTH} flexShrink={0}>
              <Text color={theme.text.primary}>{t('Settings:')}</Text>
            </Box>
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
