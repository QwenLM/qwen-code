/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { HookEventDisplayInfo } from './types.js';
import { t } from '../../../i18n/index.js';

interface HookEventHeaderProps {
  title: string;
  description: string;
  exitCodes: HookEventDisplayInfo['exitCodes'];
}

export function HookEventHeader({
  title,
  description,
  exitCodes,
}: HookEventHeaderProps): React.JSX.Element {
  return (
    <>
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          {title}
        </Text>
      </Box>

      {description && (
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>{description}</Text>
        </Box>
      )}

      <ExitCodesBlock exitCodes={exitCodes} />
    </>
  );
}

function ExitCodesBlock({
  exitCodes,
}: {
  exitCodes: HookEventDisplayInfo['exitCodes'];
}): React.JSX.Element | null {
  if (exitCodes.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {exitCodes.map((ec, index) => {
        const label =
          typeof ec.code === 'number'
            ? `${t('Exit code')} ${ec.code}`
            : `${t('Other exit codes')}`;
        return (
          <Box key={index}>
            <Text color={theme.text.secondary}>
              {label} - {ec.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
