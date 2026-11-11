/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UIState } from '../contexts/UIStateContext.js';
import type { InputState } from '../contexts/InputContext.js';
import { TransientMessageType } from '../../utils/events.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import type { I18nService } from '@qwen-code/core';

export type ToastTone = 'warning' | 'success' | 'error' | 'secondary';

export interface ToastMessage {
  text: string;
  tone: ToastTone;
}

/**
 * Selects the single transient message that temporarily replaces the normal
 * StatusRow tip or shortcut hint.
 */
export function getToastMessage(
  uiState: UIState,
  inputState: InputState,
  t: I18nService['get'],
): ToastMessage | null {
  if (uiState.ctrlCPressedOnce) {
    return {
      text: t('status.toast.exitAgain', { shortcut: 'Ctrl+C' }),
      tone: 'warning',
    };
  }

  if (
    uiState.transientMessage?.type === TransientMessageType.Warning &&
    uiState.transientMessage.text
  ) {
    return { text: uiState.transientMessage.text, tone: 'warning' };
  }

  if (uiState.ctrlDPressedOnce) {
    return {
      text: t('status.toast.exitAgain', { shortcut: 'Ctrl+D' }),
      tone: 'warning',
    };
  }

  if (inputState.showEscapePrompt) {
    const isPromptEmpty = inputState.buffer.text.length === 0;
    if (!isPromptEmpty || uiState.history.length > 0) {
      return {
        text: t(
          isPromptEmpty
            ? 'status.toast.escapeRewind'
            : 'status.toast.escapeClear',
          { shortcut: 'Esc' },
        ),
        tone: 'secondary',
      };
    }
  }

  if (
    uiState.transientMessage?.type === TransientMessageType.Success &&
    uiState.transientMessage.text
  ) {
    return { text: uiState.transientMessage.text, tone: 'success' };
  }

  if (
    uiState.transientMessage?.type === TransientMessageType.Hint &&
    uiState.transientMessage.text
  ) {
    return { text: uiState.transientMessage.text, tone: 'secondary' };
  }

  if (uiState.queueErrorMessage) {
    return { text: uiState.queueErrorMessage, tone: 'error' };
  }

  if (uiState.showIsExpandableHint) {
    return {
      text: t('status.transcript.view', {
        shortcut: SHORTCUT_HINTS.CTRL_O_KEY,
      }),
      tone: 'secondary',
    };
  }

  return null;
}
