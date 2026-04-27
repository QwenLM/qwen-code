/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useContext } from 'react';
import { Box, Text } from 'ink';
import { StatsDisplay } from './StatsDisplay.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { theme } from '../semantic-colors.js';
import type { SessionBillingTotal } from '../utils/sessionBilling.js';
import { getCurrentSessionBillingTotal } from '../utils/sessionBilling.js';
import { formatModelCost } from '../utils/modelBilling.js';
import { t } from '../../i18n/index.js';

const BILLING_LABEL_WIDTH = 28;

interface SessionSummaryDisplayProps {
  duration: string;
  width?: number;
}

const BillingSummary: React.FC<{ total: SessionBillingTotal }> = ({
  total,
}) => (
  <Box flexDirection="column" marginTop={1}>
    <Text bold color={theme.text.primary}>
      {t('Billing')}
    </Text>
    <Box>
      <Box width={BILLING_LABEL_WIDTH}>
        <Text color={theme.text.link}>{t('Current Session Total')}</Text>
      </Box>
      <Text color={theme.status.warning}>
        {formatModelCost(total.totalCost, total.currency)}
      </Text>
    </Box>
  </Box>
);

export const SessionSummaryDisplay: React.FC<SessionSummaryDisplayProps> = ({
  duration,
  width,
}) => {
  const config = useConfig();
  const settings = useContext(SettingsContext);
  const { stats } = useSessionStats();
  const currentSessionBillingTotal = getCurrentSessionBillingTotal(
    settings?.merged.billing,
    stats.metrics,
  );

  // Only show the resume message if there were messages in the session AND
  // chat recording is enabled (otherwise there is nothing to resume).
  const hasMessages = stats.promptCount > 0;
  const canResume = !!config.getChatRecordingService();

  return (
    <>
      <StatsDisplay
        title={t('Agent powering down. Goodbye!')}
        duration={duration}
        width={width}
      >
        {currentSessionBillingTotal && (
          <BillingSummary total={currentSessionBillingTotal} />
        )}
      </StatsDisplay>
      {hasMessages && canResume && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('To continue this session, run')}{' '}
            <Text color={theme.text.accent}>
              qwen --resume {stats.sessionId}
            </Text>
          </Text>
        </Box>
      )}
    </>
  );
};
