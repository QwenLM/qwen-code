/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { useConfig, useModel } from '../contexts/ConfigContext.js';
import { Text, Box } from 'ink';
import { theme } from '../semantic-colors.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import type { SessionMetrics } from '@qwen-code/core';
import {
  BRAND_CLI_NAME,
  boundPeerIdentity,
  getDisplayString,
} from '@qwen-code/core';

/** One `label: value` line of the usage/status panel. */
export type UsageStatusRow = readonly [label: string, value: string];

interface UsageStatusPanelProps {
  /** Which tab to show first */
  initialTab: 'usage' | 'status';
  /** Current model key for display in status tab */
  currentModel?: string;
  /** Session start time for duration calculation */
  sessionStartTime?: Date;
  /** Session ID (UUID) */
  sessionId?: string;
  /** Session metrics for duration/code change stats */
  sessionMetrics?: SessionMetrics;
  /** CLI version string */
  cliVersion?: string;
  /** Callback to close this panel */
  onClose: () => void;
}

/** Format seconds with one decimal: "399.0s" */
function formatSecondsFixed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Session rows of the Usage tab: API time, wall time and code changes. */
export function buildSessionUsageRows({
  sessionStartTime,
  sessionMetrics,
}: {
  sessionStartTime?: Date;
  sessionMetrics?: SessionMetrics;
}): UsageStatusRow[] {
  // Total Duration (API) — sum of all model API latency
  const totalApiDurationMs = sessionMetrics
    ? Object.values(sessionMetrics.models).reduce(
        (sum, m) => sum + m.api.totalLatencyMs,
        0,
      )
    : 0;
  const totalApiDuration = sessionMetrics
    ? formatSecondsFixed(totalApiDurationMs)
    : '0.0s';

  // Total Duration (wall) — wall clock since session start
  const totalWallDuration = sessionStartTime
    ? formatSecondsFixed(Date.now() - sessionStartTime.getTime())
    : '0.0s';

  // Total Code Changes
  const linesAdded = sessionMetrics?.files?.totalLinesAdded ?? 0;
  const linesRemoved = sessionMetrics?.files?.totalLinesRemoved ?? 0;
  const codeChanges = `${linesAdded} lines added, ${linesRemoved} lines removed`;

  return [
    ['Total Duration (API)', totalApiDuration],
    ['Total Duration (wall)', totalWallDuration],
    ['Total Code Changes', codeChanges],
  ];
}

/** Session rows of the Status tab: version, session, cwd and peer socket. */
export function buildSessionStatusRows({
  sessionId,
  cliVersion,
}: {
  sessionId?: string;
  cliVersion?: string;
}): UsageStatusRow[] {
  // Ambient process state like the cwd, and fixed for the life of the
  // process: the socket binds once at startup and unbinds only at teardown.
  const peer = boundPeerIdentity();
  return [
    ['Version', cliVersion || 'unknown'],
    ['Session ID', sessionId || 'unknown'],
    ['Working Directory', process.cwd()],
    // The socket this session listens on — what lsof and
    // --messaging-socket-path show.
    ...(peer ? [['Peer address', peer.address] as const] : []),
  ];
}

/** Aligned `label: value` lines, as used by both panel tabs. */
export function UsageStatusRows({
  rows,
  labelWidth,
}: {
  rows: readonly UsageStatusRow[];
  labelWidth: number;
}): React.JSX.Element {
  return (
    <Box paddingLeft={1} flexDirection="column">
      {rows.map(([label, value]) => (
        <Box key={label} flexDirection="row">
          <Box width={labelWidth}>
            <Text color={theme.text.secondary}>{label}</Text>
          </Box>
          <Text color={theme.text.secondary}>{': '}</Text>
          <Text color={theme.text.primary}>{value}</Text>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Session-only panel for /usage and /status.
 *
 * Both commands open this component; the difference is which tab is focused
 * on mount. It shows what the CLI knows locally about the session; a product
 * build replaces both commands with a panel that adds account details.
 */
export function UsageStatusPanel({
  initialTab,
  currentModel,
  sessionStartTime,
  sessionId,
  sessionMetrics,
  cliVersion,
  onClose,
}: UsageStatusPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'usage' | 'status'>(initialTab);
  const config = useConfig();
  const listed = useModel(config, currentModel);

  const tabs = [
    { key: 'usage' as const, label: 'Usage' },
    { key: 'status' as const, label: 'Status' },
  ];

  return (
    <BaseTabDialog
      title={BRAND_CLI_NAME}
      tabs={tabs}
      activeKey={activeTab}
      onTabChange={(key) => {
        if (key === 'usage' || key === 'status') setActiveTab(key);
      }}
      onClose={onClose}
      equalizeTabHeight
      tabPanels={{
        usage: (
          <Box flexDirection="column">
            <Box paddingLeft={1} marginBottom={1}>
              <Text color={theme.text.secondary} dimColor>
                Session usage for the current conversation.
              </Text>
            </Box>
            <UsageStatusRows
              labelWidth={26}
              rows={buildSessionUsageRows({ sessionStartTime, sessionMetrics })}
            />
          </Box>
        ),
        status: (
          <Box flexDirection="column">
            <Box paddingLeft={1} marginBottom={1}>
              <Text color={theme.text.secondary} dimColor>
                Current model, session info, and runtime environment details.
              </Text>
            </Box>
            <UsageStatusRows
              labelWidth={22}
              rows={[
                [
                  'Model',
                  currentModel
                    ? getDisplayString(listed, currentModel)
                    : 'Auto',
                ],
                ...buildSessionStatusRows({ sessionId, cliVersion }),
              ]}
            />
          </Box>
        ),
      }}
    >
      {null}
    </BaseTabDialog>
  );
}
