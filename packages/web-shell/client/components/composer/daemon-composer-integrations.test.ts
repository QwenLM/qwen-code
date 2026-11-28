/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { LiveVoiceButton } from '../../live/LiveVoiceButton';
import { VoiceButton } from '../../voice/VoiceButton';
import { BranchPickerPopover } from '../BranchPickerPopover';
import { DAEMON_COMPOSER_INTEGRATIONS } from './daemon-composer-integrations';

describe('DAEMON_COMPOSER_INTEGRATIONS', () => {
  it('binds the real daemon composer controls', () => {
    expect(DAEMON_COMPOSER_INTEGRATIONS.VoiceButton).toBe(VoiceButton);
    expect(DAEMON_COMPOSER_INTEGRATIONS.LiveVoiceButton).toBe(LiveVoiceButton);
    expect(DAEMON_COMPOSER_INTEGRATIONS.BranchPickerPopover).toBe(
      BranchPickerPopover,
    );
  });
});
