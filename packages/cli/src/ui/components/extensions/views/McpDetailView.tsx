/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { t } from '../../../../i18n/index.js';
import type { InstalledMcpInfo } from '../types.js';

interface McpDetailViewProps {
  mcp: InstalledMcpInfo;
}

const LABEL_WIDTH = 14;

const InfoRow = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <Box>
    <Box width={LABEL_WIDTH} flexShrink={0}>
      <Text color={theme.text.primary}>{label}</Text>
    </Box>
    <Box flexGrow={1}>
      <Text>{children}</Text>
    </Box>
  </Box>
);

export const McpDetailView = ({ mcp }: McpDetailViewProps) => {
  const statusColor = mcp.isDisabled
    ? theme.text.secondary
    : mcp.status === 'connected'
      ? theme.status.success
      : mcp.status === 'connecting'
        ? theme.status.warning
        : theme.status.error;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <InfoRow label={t('Name:')}>{mcp.name}</InfoRow>
        <InfoRow label={t('Type:')}>{t('MCP Server')}</InfoRow>
        <InfoRow label={t('Scope:')}>{mcp.scope}</InfoRow>
        <InfoRow label={t('Transport:')}>{mcp.transport}</InfoRow>
        <InfoRow label={t('Status:')}>
          <Text color={statusColor}>
            {mcp.isDisabled ? t('disabled') : mcp.status}
          </Text>
        </InfoRow>
        <InfoRow label={t('Tools:')}>{String(mcp.toolCount)}</InfoRow>
      </Box>
    </Box>
  );
};
