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
  screenReader = false,
}: {
  status: VoiceInputStatus;
  interimText?: string;
  audioLevel?: number;
  screenReader?: boolean;
}) {
  const { width } = useTerminalDimensions();
  if (status === 'idle') return null;
  // The meter is a 100 ms animation and the interim transcript grows per
  // recognised word, so speech takes a stable label plus the live value on
  // the replacing lane instead of a scrollback line per audio frame.
  if (screenReader)
    return (
      <text id="screen-reader-live-voice">
        {status === 'recording'
          ? t('listening…')
          : status === 'refining'
            ? t('refining…')
            : t('transcribing…')}
        {interimText ? `\n${interimText}` : ''}
      </text>
    );
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
