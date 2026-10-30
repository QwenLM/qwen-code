/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { QwenSubscriptionProgress } from '../components/QwenSubscriptionProgress.js';
import { QwenSubscriptionStatus } from '../components/QwenSubscriptionStatus.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { useSubscription } from './use-subscription.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';

export function SubscriptionDialog({
  onBack,
  onModelSelectionRequired,
  onModelStudio,
  suppressBrowserLaunch,
  onConnect,
}: {
  onBack: () => void;
  onModelSelectionRequired?: () => void;
  onModelStudio: () => void;
  suppressBrowserLaunch?: boolean;
  onConnect?: (signal: AbortSignal) => Promise<void>;
}) {
  const flow = useSubscription({
    suppressBrowserLaunch,
    onActivate: onConnect,
  });
  const { state } = flow;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const back = () => {
    flow.cancel();
    if (flow.modelSelectionRequired && onModelSelectionRequired)
      onModelSelectionRequired();
    else onBack();
  };
  const signOut = async () => {
    if ((await flow.signOut()) && mounted.current) onBack();
  };
  useKeypress(
    (key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) back();
    },
    { isActive: state.status === 'ready' },
  );
  if (
    state.status === 'waiting' ||
    state.status === 'error' ||
    state.status === 'timeout'
  ) {
    return (
      <QwenSubscriptionProgress
        status={state.status}
        message={state.status === 'waiting' ? undefined : state.message}
        deviceAuth={flow.deviceAuth}
        onCancel={back}
      />
    );
  }
  if (state.status === 'ready') {
    return flow.connectionError ? (
      <Box flexDirection="column" marginY={1}>
        <Text color={theme.status.error}>{flow.connectionError}</Text>
        {flow.modelSelectionRequired ? (
          <Text>{t('Esc to go back')}</Text>
        ) : (
          <RadioButtonSelect
            items={[
              {
                key: 'retry',
                value: 'retry',
                label: t('Retry'),
                disabled: flow.connecting,
              },
            ]}
            onSelect={() => void flow.connect()}
            showNumbers={false}
          />
        )}
      </Box>
    ) : (
      <Box marginY={1}>
        <Text color={theme.text.secondary}>
          {t('Loading models from provider…')}
        </Text>
      </Box>
    );
  }
  if (state.status === 'query-error') {
    return (
      <QwenSubscriptionStatus
        status="error"
        message={state.message}
        checking={flow.checking}
        onRetry={flow.checkAgain}
        onCancel={back}
      />
    );
  }
  if (state.status !== 'purchase-required') return null;
  return (
    <QwenSubscriptionStatus
      status="purchase-required"
      email={flow.email}
      plan={state.plan}
      message={state.message}
      checking={flow.checking}
      canCheckAgain={flow.canCheckAgain}
      onOpenPlans={flow.openPlans}
      onCheckAgain={flow.checkAgain}
      onSwitchProvider={() => {
        flow.cancel();
        onModelStudio();
      }}
      onSignOut={() => void signOut()}
      onCancel={back}
    />
  );
}
