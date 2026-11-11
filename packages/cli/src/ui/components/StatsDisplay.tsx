/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { ThemedGradient } from './ThemedGradient.js';
import { theme } from '../semantic-colors.js';
import { formatDuration } from '../utils/formatters.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import {
  getStatusColor,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
  USER_AGREEMENT_RATE_HIGH,
  USER_AGREEMENT_RATE_MEDIUM,
} from '../utils/displayUtils.js';
import { computeSessionStats } from '../utils/computeStats.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';

// A more flexible and powerful StatRow component
interface StatRowProps {
  title: string;
  children: React.ReactNode; // Use children to allow for complex, colored values
}

const StatRow: React.FC<StatRowProps> = ({ title, children }) => (
  <Box>
    {/* Fixed width for the label creates a clean "gutter" for alignment */}
    <Box width={28}>
      <Text color={theme.text.link}>{title}</Text>
    </Box>
    {children}
  </Box>
);

// A SubStatRow for indented, secondary information
interface SubStatRowProps {
  title: string;
  children: React.ReactNode;
}

const SubStatRow: React.FC<SubStatRowProps> = ({ title, children }) => (
  <Box paddingLeft={2}>
    {/* Adjust width for the "» " prefix */}
    <Box width={26}>
      <Text color={theme.text.secondary}>» {title}</Text>
    </Box>
    {children}
  </Box>
);

// A Section component to group related stats
interface SectionProps {
  title: string;
  children: React.ReactNode;
}

export const StatsSection: React.FC<SectionProps> = ({ title, children }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color={theme.text.primary}>
      {title}
    </Text>
    {children}
  </Box>
);

export interface StatsDisplayProps {
  duration: string;
  title?: string;
  footer?: string;
  selectedAuthType?: string;
  userEmail?: string;
  currentModel?: string;
}

export function StatsIdentityRows({
  selectedAuthType,
  userEmail,
}: Pick<StatsDisplayProps, 'selectedAuthType' | 'userEmail'>) {
  const { stats } = useSessionStats();
  const settings = useSettings();
  const showUserIdentity = settings.merged.ui.showUserIdentity;
  return (
    <>
      <StatRow title="Session ID:">
        <Text color={theme.text.primary}>{stats.sessionId}</Text>
      </StatRow>
      {showUserIdentity && selectedAuthType && (
        <StatRow title="Auth Method:">
          <Text color={theme.text.primary}>
            {userEmail
              ? `${selectedAuthType} (${userEmail})`
              : selectedAuthType}
          </Text>
        </StatRow>
      )}
    </>
  );
}
export function StatsInteractionMetrics() {
  const { stats } = useSessionStats();
  const { metrics } = stats;
  const { tools, files } = metrics;
  const computed = computeSessionStats(metrics);

  const successThresholds = {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM,
  };
  const agreementThresholds = {
    green: USER_AGREEMENT_RATE_HIGH,
    yellow: USER_AGREEMENT_RATE_MEDIUM,
  };
  const successColor = getStatusColor(computed.successRate, successThresholds);
  const agreementColor = getStatusColor(
    computed.agreementRate,
    agreementThresholds,
  );

  return (
    <>
      <StatRow title="Tool Calls:">
        <Text color={theme.text.primary}>
          {tools.totalCalls} ({' '}
          <Text color={theme.status.success}>✓ {tools.totalSuccess}</Text>{' '}
          <Text color={theme.status.error}>x {tools.totalFail}</Text> )
        </Text>
      </StatRow>
      <StatRow title="Success Rate:">
        <Text color={successColor}>{computed.successRate.toFixed(1)}%</Text>
      </StatRow>
      {computed.totalDecisions > 0 && (
        <StatRow title="User Agreement:">
          <Text color={agreementColor}>
            {computed.agreementRate.toFixed(1)}%{' '}
            <Text color={theme.text.secondary}>
              ({computed.totalDecisions} reviewed)
            </Text>
          </Text>
        </StatRow>
      )}
      {files && (files.totalLinesAdded > 0 || files.totalLinesRemoved > 0) && (
        <StatRow title="Code Changes:">
          <Text color={theme.text.primary}>
            <Text color={theme.status.success}>+{files.totalLinesAdded}</Text>{' '}
            <Text color={theme.status.error}>-{files.totalLinesRemoved}</Text>
          </Text>
        </StatRow>
      )}
    </>
  );
}
export function StatsPerformanceSection({
  duration,
}: Pick<StatsDisplayProps, 'duration'>) {
  const { stats } = useSessionStats();
  const computed = computeSessionStats(stats.metrics);
  return (
    <StatsSection title="Performance">
      <StatRow title="Wall Time:">
        <Text color={theme.text.primary}>{duration}</Text>
      </StatRow>
      <StatRow title="Agent Active:">
        <Text color={theme.text.primary}>
          {formatDuration(computed.agentActiveTime)}
        </Text>
      </StatRow>
      <SubStatRow title="API Time:">
        <Text color={theme.text.primary}>
          {formatDuration(computed.totalApiTime)}{' '}
          <Text color={theme.text.secondary}>
            ({computed.apiTimePercent.toFixed(1)}%)
          </Text>
        </Text>
      </SubStatRow>
      <SubStatRow title="Tool Time:">
        <Text color={theme.text.primary}>
          {formatDuration(computed.totalToolTime)}{' '}
          <Text color={theme.text.secondary}>
            ({computed.toolTimePercent.toFixed(1)}%)
          </Text>
        </Text>
      </SubStatRow>
    </StatsSection>
  );
}
export const StatsDisplay: React.FC<StatsDisplayProps> = ({
  duration,
  title,
  footer,
  selectedAuthType,
  userEmail,
}) => (
  <BaseTabDialog
    title={title || 'Stats'}
    tabs={[]}
    activeKey=""
    onTabChange={() => {}}
  >
    <StatsSection title="Interaction Summary">
      <StatsIdentityRows
        selectedAuthType={selectedAuthType}
        userEmail={userEmail}
      />
      <StatsInteractionMetrics />
    </StatsSection>
    <StatsPerformanceSection duration={duration} />
    {footer && <ThemedGradient bold>{footer}</ThemedGradient>}
  </BaseTabDialog>
);
