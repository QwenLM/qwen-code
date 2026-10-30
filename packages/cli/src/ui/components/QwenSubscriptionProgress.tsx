/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import Link from 'ink-link';
import type { SubscriptionDeviceAuthorization } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { t } from '../../i18n/index.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { Spinner } from './RespondingSpinner.js';

export function QwenSubscriptionProgress({
  onCancel,
  deviceAuth,
  status,
  message,
}: {
  onCancel: () => void;
  deviceAuth?: SubscriptionDeviceAuthorization;
  status: 'waiting' | 'error' | 'timeout';
  message?: string;
}) {
  const authorizationUrl = deviceAuth?.verification_uri_complete;
  const waiting = status === 'waiting';
  useKeypress(
    (key) => {
      if (!waiting || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        onCancel();
      } else if (
        key.name === 'c' &&
        !key.ctrl &&
        !key.meta &&
        !key.paste &&
        deviceAuth &&
        deviceAuth.expiresAt > Date.now() &&
        authorizationUrl
      ) {
        void copyToClipboard(authorizationUrl).catch(() => undefined);
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="single"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      {waiting ? (
        <>
          <Text bold>{t('Qwen Subscription')}</Text>
          <Box marginTop={1}>
            <Text>
              {t(
                'Opening chat.qwen.ai in your browser… Sign in there to connect Qwen Code.',
              )}
            </Text>
          </Box>
          {authorizationUrl ? (
            <Box flexDirection="column">
              <Text color={theme.text.secondary}>
                {t("If the browser didn't open, visit:")}
              </Text>
              <Link url={authorizationUrl} fallback={false}>
                <Text color={theme.text.link} underline>
                  {authorizationUrl}
                </Text>
              </Link>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text>
              <Spinner /> {t('Waiting for sign-in…')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('c to copy link · Esc to cancel')}
            </Text>
          </Box>
        </>
      ) : (
        <>
          <Text bold color={theme.status.error}>
            {t(
              status === 'timeout'
                ? 'Qwen OAuth Authentication Timeout'
                : 'Qwen OAuth Authentication Error',
            )}
          </Text>
          <Box marginTop={1}>
            <Text>
              {message ||
                t(
                  status === 'timeout'
                    ? 'Authentication timed out. Please try again or select a different authentication method.'
                    : 'An error occurred during authentication. Please try again.',
                )}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Press any key to return to authentication type selection.')}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
