/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command, type KeyBindingConfig } from '../key/keyBindings.js';
import { formatKeyBinding } from '../key/keybindingUtils.js';
import { terminalCapabilityManager } from './terminalCapabilityManager.js';

/**
 * Label for the "<key> to send now" hint under the queued-message list, or ''
 * when the hint should stay hidden.
 *
 * Lives outside constants/shortcuts.ts because keyBindings.ts imports that
 * module; importing the key tables back from there would create a cycle.
 */
export function getSendNowShortcut(
  config: KeyBindingConfig,
  canDistinguishModifiedEnter: boolean = terminalCapabilityManager.canDistinguishModifiedEnter(),
): string {
  const binding = config.get(Command.SEND_NOW)?.[0];
  if (!binding) return '';

  // A modified Enter only reaches the app when the terminal encodes the
  // modifier (Kitty protocol or modifyOtherKeys). Elsewhere it arrives as a
  // bare Enter, so advertising it would promise a key that cannot fire.
  // Any other key the user bound works everywhere and is always shown.
  const isModifiedEnter =
    binding.name === 'enter' &&
    (binding.ctrl || binding.shift || binding.alt || binding.cmd);
  if (isModifiedEnter && !canDistinguishModifiedEnter) return '';

  return formatKeyBinding(binding);
}
