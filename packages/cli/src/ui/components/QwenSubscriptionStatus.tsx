/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';

type QwenSubscriptionStatusProps = { onCancel?: () => void } & (
  | {
      status: 'purchase-required';
      email: string;
      plan: string;
      checking?: boolean;
      canCheckAgain?: boolean;
      message?: string;
      onOpenPlans: () => void;
      onCheckAgain: () => void;
      onSwitchProvider: () => void;
      onSignOut: () => void;
    }
  | {
      status: 'error';
      message: string;
      checking?: boolean;
      onRetry: () => void;
    }
);

export function QwenSubscriptionStatus(
  props: QwenSubscriptionStatusProps,
): React.JSX.Element | null {
  useKeypress(
    (key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        props.onCancel?.();
      }
    },
    { isActive: true },
  );

  if (props.status === 'error') {
    return (
      <Box flexDirection="column">
        <Text color={theme.status.error}>
          {props.checking ? t('Checking your subscription…') : props.message}
        </Text>
        <DescriptiveRadioButtonSelect
          items={[
            {
              key: 'check',
              value: 'check',
              title: t('Check again'),
              description: '',
              disabled: props.checking,
            },
          ]}
          onSelect={props.onRetry}
        />
      </Box>
    );
  }

  const actions = [
    ...(props.canCheckAgain
      ? [
          {
            key: 'check',
            value: props.onCheckAgain,
            title: t('Check again'),
            description: '',
            disabled: props.checking,
          },
        ]
      : []),
    {
      key: 'plans',
      value: props.onOpenPlans,
      title: t('Open plans again'),
      description: t('Opens the Qwen Code plans page in your browser'),
    },
    {
      key: 'provider',
      value: props.onSwitchProvider,
      title: t('Use Alibaba ModelStudio instead'),
      description: t('Coding Plan, Token Plan, or Standard API Key'),
    },
    {
      key: 'signout',
      value: props.onSignOut,
      title: t('Sign out'),
      description: t('Disconnect this device from your Qwen account'),
    },
  ];
  return (
    <Box flexDirection="column">
      <Text color={theme.status.success}>
        ✓{' '}
        {t('Signed in as {{email}} (Qwen {{plan}})', {
          email: props.email,
          plan: props.plan,
        })}
      </Text>
      <Box
        borderStyle="single"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold>{t('Qwen Code is included with Qwen Plus and Pro')}</Text>
        <Box marginTop={1}>
          <Text>
            {t(
              "You're signed in with a {{plan}} account, which doesn't include Qwen Code. Choose Plus or Pro in your browser; this terminal continues automatically after you subscribe.",
              { plan: props.plan },
            )}
          </Text>
        </Box>
        <Box marginY={1}>
          <Text>
            {props.checking
              ? t('Checking your subscription…')
              : (props.message ??
                t('Waiting for your subscription to become active…'))}
          </Text>
        </Box>
        <DescriptiveRadioButtonSelect
          items={actions}
          onSelect={(action) => action()}
          itemGap={1}
        />
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to select, ↑↓ to navigate · Esc to close')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
