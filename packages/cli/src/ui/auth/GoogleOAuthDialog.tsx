/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { TextInput } from '../components/shared/TextInput.js';
import {
  useGoogleOAuth,
  type GoogleOAuthActivate,
} from './use-google-oauth.js';

export function GoogleOAuthDialog({
  suppressBrowserLaunch,
  onBack,
  onConnect,
}: {
  suppressBrowserLaunch: boolean;
  onBack: () => void;
  onConnect: GoogleOAuthActivate;
}): React.JSX.Element {
  const flow = useGoogleOAuth({ suppressBrowserLaunch, onActivate: onConnect });
  const [code, setCode] = useState('');
  const back = () => {
    flow.cancel();
    onBack();
  };
  useKeypress(
    (key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) back();
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
      <Text bold>{t('Sign in with Google')}</Text>
      {flow.status !== 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {flow.status === 'awaiting-code'
              ? t('Open the authorization URL and enter the returned code.')
              : t(
                  'Complete Google authorization and wait for Code Assist setup…',
                )}
          </Text>
          {flow.authorizationUrl && (
            <Text color={theme.text.accent} underline>
              {flow.authorizationUrl}
            </Text>
          )}
          {flow.status === 'awaiting-code' && (
            <Box marginTop={1}>
              <TextInput
                value={code}
                onChange={setCode}
                onSubmit={flow.submitCode}
                placeholder={t('Authorization code')}
              />
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Esc to cancel and return to provider selection')}
            </Text>
          </Box>
        </Box>
      )}
      {flow.status === 'error' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.status.error}>{flow.error}</Text>
          <RadioButtonSelect
            items={[
              { key: 'retry', label: t('Retry'), value: 'retry' },
              { key: 'back', label: t('Back'), value: 'back' },
            ]}
            onSelect={(value) => {
              if (value === 'retry') {
                setCode('');
                flow.retry();
              } else back();
            }}
            showNumbers={false}
          />
        </Box>
      )}
    </Box>
  );
}
