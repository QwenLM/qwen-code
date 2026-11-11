/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { useMemo, useCallback } from 'react';
import { theme } from '../semantic-colors.js';
import type { MCPServerConfig } from '@qwen-code/core';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';

export enum McpApprovalChoice {
  APPROVE_ALL = 'approve_all',
  APPROVE = 'approve',
  REJECT = 'reject',
}

export interface McpApprovalResult {
  serverName: string;
  choice: McpApprovalChoice;
}

interface McpServerApprovalDialogProps {
  pendingServers: Record<string, MCPServerConfig>;
  onComplete: (results: McpApprovalResult[]) => void;
}

function getServerDescription(config: MCPServerConfig): string {
  if (config.command) {
    const args = config.args ? ` ${config.args.join(' ')}` : '';
    return `${config.command}${args}`;
  }
  if (config.url) {
    return config.url;
  }
  return 'unknown';
}

/**
 * Dialog for approving/rejecting project-level MCP servers.
 * For a single pending server: shows 3 radio options.
 * For multiple: iterates through each server one at a time.
 */
export const McpServerApprovalDialog: React.FC<
  McpServerApprovalDialogProps
> = ({ pendingServers, onComplete }) => {
  const serverNames = useMemo(
    () => Object.keys(pendingServers),
    [pendingServers],
  );

  const handleReject = useCallback(() => {
    // On escape, reject all pending servers
    const results: McpApprovalResult[] = serverNames.map((name) => ({
      serverName: name,
      choice: McpApprovalChoice.REJECT,
    }));
    onComplete(results);
  }, [serverNames, onComplete]);

  if (serverNames.length === 0) {
    return null;
  }

  // Handle all servers at once with a single choice
  const isSingle = serverNames.length === 1;

  const options: Array<RadioSelectItem<McpApprovalChoice>> = isSingle
    ? [
        {
          label: 'Approve this server',
          value: McpApprovalChoice.APPROVE,
          key: 'approve',
        },
        {
          label: 'Always approve all project MCP servers',
          value: McpApprovalChoice.APPROVE_ALL,
          key: 'approve_all',
        },
        {
          label: 'Reject this server',
          value: McpApprovalChoice.REJECT,
          key: 'reject',
        },
      ]
    : [
        {
          label: 'Approve all listed servers',
          value: McpApprovalChoice.APPROVE,
          key: 'approve',
        },
        {
          label: 'Always approve all project MCP servers',
          value: McpApprovalChoice.APPROVE_ALL,
          key: 'approve_all',
        },
        {
          label: 'Reject all listed servers',
          value: McpApprovalChoice.REJECT,
          key: 'reject',
        },
      ];

  const handleSelect = (choice: McpApprovalChoice): void => {
    const results: McpApprovalResult[] = serverNames.map((name) => ({
      serverName: name,
      choice,
    }));
    onComplete(results);
  };

  const title = isSingle
    ? 'A project MCP server needs approval'
    : `${serverNames.length} project MCP servers need approval`;

  return (
    <BaseTabDialog
      title={title}
      onClose={handleReject}
      borderColor={theme.status.warning}
    >
      <Box marginBottom={1}>
        <Text color={theme.text.primary}>
          {isSingle
            ? 'This project defines an MCP server that has not been approved yet. MCP servers can execute code and access external services.'
            : 'This project defines MCP servers that have not been approved yet. MCP servers can execute code and access external services.'}
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {serverNames.map((name) => (
          <Box key={name} marginLeft={2} flexDirection="column">
            <Text color={theme.text.primary} bold>
              {name}
            </Text>
            <Text color={theme.text.secondary} dimColor>
              {getServerDescription(pendingServers[name])}
            </Text>
          </Box>
        ))}
      </Box>

      <RadioButtonSelect
        items={options}
        onSelect={handleSelect}
        isFocused={true}
      />
    </BaseTabDialog>
  );
};
