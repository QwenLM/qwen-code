/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type { VoiceInputStatus } from '../hooks/useVoiceInput.js';
import { t } from '../../i18n/index.js';
import { escapeAnsiCtrlCodes } from '../utils/textUtils.js';

interface VoiceIndicatorProps {
  status: VoiceInputStatus;
  /** Live partial transcript (streaming only). */
  interimText?: string;
  /** Recent input level 0..1. */
  audioLevel?: number;
}

const METER_WIDTH = 16;
// Speech mean-abs level is small (~0.03–0.1 of full scale); amplify for display.
const LEVEL_GAIN = 12;

function meter(level: number): string {
  if (!Number.isFinite(level)) level = 0;
  const norm = Math.max(0, Math.min(1, level * LEVEL_GAIN));
  const filled = Math.round(norm * METER_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(METER_WIDTH - filled);
}

/** Live voice dictation indicator: state, input-level meter, and partial text. */
export function VoiceIndicator({
  status,
  interimText,
  audioLevel = 0,
}: VoiceIndicatorProps): React.JSX.Element | null {
  if (status === 'idle') {
    return null;
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        {status === 'recording' ? (
          <>
            <Text color="redBright">{'● '}</Text>
            <Text color="cyan">{meter(audioLevel)}</Text>
            <Text color="gray">{'  ' + t('listening…')}</Text>
          </>
        ) : (
          <Text color="yellow">{'✦ ' + t('transcribing…')}</Text>
        )}
      </Box>
      {interimText ? (
        <Text dimColor wrap="truncate-end">
          {escapeAnsiCtrlCodes(interimText)}
        </Text>
      ) : null}
    </Box>
  );
}
