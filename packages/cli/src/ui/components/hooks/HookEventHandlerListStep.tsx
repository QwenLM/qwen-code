/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { HookEventDisplayInfo } from './types.js';
import { HookEventHeader } from './HookEventHeader.js';
import { HandlerListBody } from './HandlerListBody.js';
import { getAllConfigs } from './matcherGrouping.js';
import { t } from '../../../i18n/index.js';

interface HookEventHandlerListStepProps {
  hook: HookEventDisplayInfo;
  selectedIndex: number;
}

export function HookEventHandlerListStep({
  hook,
  selectedIndex,
}: HookEventHandlerListStepProps): React.JSX.Element {
  const flatConfigs = getAllConfigs(hook);
  const hasConfigs = flatConfigs.length > 0;

  return (
    <Box flexDirection="column" paddingX={1}>
      <HookEventHeader
        title={hook.event}
        description={hook.description}
        exitCodes={hook.exitCodes}
      />

      {hasConfigs ? (
        <HandlerListBody configs={flatConfigs} selectedIndex={selectedIndex} />
      ) : (
        <>
          <Box>
            <Text color={theme.text.secondary}>
              {t('No hooks configured for this event.')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('To add hooks, edit settings.json directly or ask Qwen.')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Esc to go back')}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
