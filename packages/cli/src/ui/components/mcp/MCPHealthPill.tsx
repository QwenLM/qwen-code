/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import {
  useMCPHealth,
  type MCPHealthSnapshot,
} from '../../hooks/useMCPHealth.js';

/**
 * Pill label: surfaces MCP servers that need attention. Connecting is
 * intentionally suppressed — boot/reconnect transitions would otherwise
 * make the pill flicker. Only `disconnected` (failed connect or lost
 * link) qualifies in v1, since that's the state that doesn't recover
 * on its own beyond the 30s health-check loop.
 */
export function getPillLabel(snapshot: MCPHealthSnapshot): string {
  const { disconnectedCount } = snapshot;
  if (disconnectedCount === 0) return '';
  return `${disconnectedCount} MCP${disconnectedCount === 1 ? '' : 's'} offline`;
}

/**
 * Footer pill that flags MCP servers stuck in `DISCONNECTED`. Hidden
 * when no MCPs are configured or all are healthy. v1 is a visual
 * indicator only — keyboard navigation (Down-arrow focus chain into
 * the pill, Enter to open `/mcp`) is deferred to a follow-up so this
 * PR stays small and the footer pill framework can absorb a second
 * consumer without growing the focus-chain plumbing yet.
 */
export const MCPHealthPill: React.FC = () => {
  const snapshot = useMCPHealth();
  const label = getPillLabel(snapshot);
  if (!label) return null;
  return (
    <>
      <Text color={theme.text.secondary}> · </Text>
      <Text color={theme.status.warning}>{label}</Text>
    </>
  );
};
