/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TransientMessageType } from '../../utils/events.js';
import type { InputState } from '../contexts/InputContext.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { HistoryItem } from '../types.js';
import type { TextBuffer } from './shared/text-buffer.js';
import { getToastMessage } from './toast.js';
import { formatMessage } from '../i18n/formatMessage.js';
import { DefaultI18nService } from '@qwen-code/core';
import { registerCliUiMessages } from '../i18n/register.js';
const service = new DefaultI18nService();
registerCliUiMessages(service);
function getMessageTemplate(locale: UiLocale, key: string): string {
  service.configureUi({
    locale,
    preference: locale,
    dynamicContentEnabled: false,
  });
  return service.getTemplate(key);
}
import type { MessageParams, UiMessageKey } from '../i18n/types.js';
import type { UiLocale } from '@qwen-code/core';

const baseUIState = {
  ctrlCPressedOnce: false,
  transientMessage: null,
  ctrlDPressedOnce: false,
  history: [] as HistoryItem[],
  queueErrorMessage: null,
  showIsExpandableHint: false,
} as UIState;

const baseInputState = {
  showEscapePrompt: false,
  buffer: { text: '' } as TextBuffer,
} as InputState;

function select(
  uiState: Partial<UIState> = {},
  inputState: Partial<InputState> = {},
  locale: UiLocale = 'en',
) {
  return getToastMessage(
    { ...baseUIState, ...uiState },
    { ...baseInputState, ...inputState },
    (key: string, params?: MessageParams) =>
      formatMessage(getMessageTemplate(locale, key as UiMessageKey), params),
  );
}

describe('getToastMessage', () => {
  it('returns no message for the default state', () => {
    expect(select()).toBeNull();
  });

  it('selects Ctrl+C ahead of every other message', () => {
    expect(
      select({
        ctrlCPressedOnce: true,
        ctrlDPressedOnce: true,
        queueErrorMessage: 'Queue failed',
      }),
    ).toEqual({ text: 'Ctrl+C exit again to exit.', tone: 'warning' });
  });

  it('selects warning, success, and hint transient messages', () => {
    expect(
      select({
        transientMessage: {
          text: 'Check the configuration',
          type: TransientMessageType.Warning,
        },
      }),
    ).toEqual({ text: 'Check the configuration', tone: 'warning' });

    expect(
      select({
        transientMessage: {
          text: 'Configuration saved',
          type: TransientMessageType.Success,
        },
      }),
    ).toEqual({ text: 'Configuration saved', tone: 'success' });

    expect(
      select({
        transientMessage: {
          text: 'Try /help',
          type: TransientMessageType.Hint,
        },
      }),
    ).toEqual({ text: 'Try /help', tone: 'secondary' });
  });

  it('selects Ctrl+D and both Escape prompt variants', () => {
    expect(select({ ctrlDPressedOnce: true })).toEqual({
      text: 'Ctrl+D exit again to exit.',
      tone: 'warning',
    });
    expect(
      select(
        { history: [{ id: 1, type: 'user', text: 'test' }] },
        { showEscapePrompt: true },
      ),
    ).toEqual({ text: 'Esc again to rewind.', tone: 'secondary' });
    expect(
      select(
        {},
        {
          showEscapePrompt: true,
          buffer: { text: 'draft' } as TextBuffer,
        },
      ),
    ).toEqual({ text: 'Esc again to clear prompt.', tone: 'secondary' });
  });

  it('does not select an Escape message without prompt text or history', () => {
    expect(select({}, { showEscapePrompt: true })).toBeNull();
  });

  it('selects queue errors and the transcript expansion hint', () => {
    expect(select({ queueErrorMessage: 'Queue Error' })).toEqual({
      text: 'Queue Error',
      tone: 'error',
    });
    expect(select({ showIsExpandableHint: true })).toEqual({
      text: 'Press Ctrl+O to view detailed transcript',
      tone: 'secondary',
    });
  });

  it('localizes fixed actions while preserving raw messages', () => {
    expect(select({ ctrlCPressedOnce: true }, {}, 'zh-CN')).toEqual({
      text: '再按一次 Ctrl+C 退出。',
      tone: 'warning',
    });
    expect(
      select(
        {
          transientMessage: {
            text: 'Server detail: do not translate',
            type: TransientMessageType.Warning,
          },
        },
        {},
        'zh-CN',
      ),
    ).toEqual({
      text: 'Server detail: do not translate',
      tone: 'warning',
    });
  });
});
