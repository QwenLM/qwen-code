/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { VoiceButton } from '../../voice/VoiceButton';
import { LiveVoiceButton } from '../../live/LiveVoiceButton';
import { BranchPickerPopover } from '../BranchPickerPopover';
import type { ComposerIntegrations } from './composer-integrations';

export const DAEMON_COMPOSER_INTEGRATIONS: ComposerIntegrations = {
  VoiceButton,
  LiveVoiceButton,
  BranchPickerPopover,
};
