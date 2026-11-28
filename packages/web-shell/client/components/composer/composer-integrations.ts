/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComponentProps, ComponentType, RefAttributes } from 'react';
import type { VoiceButton, VoiceButtonHandle } from '../../voice/VoiceButton';
import type { LiveVoiceButton } from '../../live/LiveVoiceButton';
import type { BranchPickerPopover } from '../BranchPickerPopover';

export interface ComposerIntegrations {
  readonly VoiceButton?: ComponentType<
    ComponentProps<typeof VoiceButton> & RefAttributes<VoiceButtonHandle>
  >;
  readonly LiveVoiceButton?: ComponentType<
    ComponentProps<typeof LiveVoiceButton>
  >;
  readonly BranchPickerPopover?: ComponentType<
    ComponentProps<typeof BranchPickerPopover>
  >;
}
