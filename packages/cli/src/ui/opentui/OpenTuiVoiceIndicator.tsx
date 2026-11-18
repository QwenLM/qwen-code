/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { RGBA, TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/react';
import wrapAnsi from 'wrap-ansi';
import type { VoiceInputStatus } from '../hooks/use-voice-input.js';
import { escapeAnsiCtrlCodes, truncateToWidth } from '../utils/textUtils.js';
import { t } from '../../i18n/index.js';

// Preserve Ink's ANSI slots, including customized terminal palettes.
const colors = {
  recording: RGBA.fromIndex(9),
  meter: RGBA.fromIndex(6),
  muted: RGBA.fromIndex(8),
  pending: RGBA.fromIndex(3),
};

export function OpenTuiVoiceIndicator({
  status,
  interimText,
  audioLevel = 0,
}: {
  status: VoiceInputStatus;
  interimText?: string;
  audioLevel?: number;
}) {
  const { width } = useTerminalDimensions();
  if (status === 'idle') return null;
  const level = Number.isFinite(audioLevel) ? audioLevel : 0;
  const filled = Math.round(Math.max(0, Math.min(1, level * 12)) * 16);
  return (
    <box flexDirection="column" paddingLeft={1}>
      <text wrapMode={status === 'recording' ? 'word' : 'none'}>
        {status === 'recording' ? (
          <>
            <span fg={colors.recording}>● </span>
            <span fg={colors.meter}>
              {'█'.repeat(filled) + '░'.repeat(16 - filled)}
            </span>
            <span fg={colors.muted}>{'  ' + t('listening…')}</span>
          </>
        ) : (
          <span fg={colors.pending}>
            {wrapAnsi(
              '◆ ' +
                (status === 'refining' ? t('refining…') : t('transcribing…')),
              Math.max(1, width - 1),
              { trim: false, hard: true },
            )}
          </span>
        )}
      </text>
      {interimText ? (
        <text attributes={TextAttributes.DIM} wrapMode="none">
          {truncateToWidth(
            escapeAnsiCtrlCodes(interimText),
            Math.max(0, width - 1),
          )}
        </text>
      ) : null}
    </box>
  );
}
