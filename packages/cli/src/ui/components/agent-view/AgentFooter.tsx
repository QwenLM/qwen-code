/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Lightweight footer for agent tabs showing approval mode
 * and context usage. Mirrors the main Footer layout but without
 * main-agent-specific concerns (vim mode, shell mode, exit prompts, etc.).
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { AutoAcceptIndicator } from '../AutoAcceptIndicator.js';
import { ContextUsageDisplay } from '../ContextUsageDisplay.js';
import { theme } from '../../semantic-colors.js';

interface AgentFooterProps {
  approvalMode: ApprovalMode | undefined;
  promptTokenCount: number;
  contextWindowSize: number | undefined;
  terminalWidth: number;
}

export const AgentFooter: React.FC<AgentFooterProps> = ({
  approvalMode,
  promptTokenCount,
  contextWindowSize,
  terminalWidth,
}) => {
  const showApproval =
    approvalMode !== undefined && approvalMode !== ApprovalMode.DEFAULT;
  const showContext = promptTokenCount > 0 && contextWindowSize !== undefined;

  if (!showApproval && !showContext) {
    return null;
  }

  return (
    <Box
      justifyContent="space-between"
      width="100%"
      flexDirection="row"
      alignItems="center"
    >
      <Box marginLeft={2}>
        {showApproval ? (
          <AutoAcceptIndicator approvalMode={approvalMode} />
        ) : null}
      </Box>
      <Box marginRight={2}>
        {showContext && (
          <Text color={theme.text.accent}>
            <ContextUsageDisplay
              promptTokenCount={promptTokenCount}
              terminalWidth={terminalWidth}
              contextWindowSize={contextWindowSize!}
            />
          </Text>
        )}
      </Box>
    </Box>
  );
};
