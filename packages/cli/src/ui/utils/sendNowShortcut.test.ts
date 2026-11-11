/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  Command,
  defaultKeyBindingConfig,
  KeyBinding,
  type KeyBindingConfig,
} from '../key/keyBindings.js';
import { formatKeyBinding } from '../key/keybindingUtils.js';
import { getSendNowShortcut } from './sendNowShortcut.js';

function withSendNow(bindings: KeyBinding[]): KeyBindingConfig {
  const config = new Map(defaultKeyBindingConfig);
  config.set(Command.SEND_NOW, bindings);
  return config;
}

describe('getSendNowShortcut', () => {
  it('shows Ctrl+Enter when the terminal reports modified Enter', () => {
    expect(getSendNowShortcut(defaultKeyBindingConfig, true)).toBe(
      formatKeyBinding(new KeyBinding('ctrl+enter')),
    );
  });

  it('hides Ctrl+Enter when the terminal cannot tell it from Enter', () => {
    expect(getSendNowShortcut(defaultKeyBindingConfig, false)).toBe('');
  });

  it('hides the hint when the user unbound send-now', () => {
    expect(getSendNowShortcut(withSendNow([]), true)).toBe('');
  });

  it('shows a non-Enter key regardless of terminal support', () => {
    const ctrlG = new KeyBinding('ctrl+g');
    expect(getSendNowShortcut(withSendNow([ctrlG]), false)).toBe(
      formatKeyBinding(ctrlG),
    );
  });

  it('uses the first binding, which is the one a user added', () => {
    const config = withSendNow([
      new KeyBinding('ctrl+g'),
      new KeyBinding('ctrl+enter'),
    ]);
    expect(getSendNowShortcut(config, false)).toBe(
      formatKeyBinding(new KeyBinding('ctrl+g')),
    );
  });
});
