/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import {
  type Command,
  type KeyBinding,
  type KeyBindingConfig,
  defaultKeyBindingConfig,
} from './keyBindings.js';

/**
 * Maps internal key names to user-friendly display names.
 */
const KEY_NAME_MAP: Record<string, string> = {
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  home: 'Home',
  end: 'End',
  tab: 'Tab',
  space: 'Space',
};

interface ModifierMap {
  ctrl: string;
  alt: string;
  shift: string;
  cmd: string;
}

const MODIFIER_MAPS: Record<string, ModifierMap> = {
  darwin: {
    ctrl: 'Ctrl',
    alt: 'Option',
    shift: 'Shift',
    cmd: 'Cmd',
  },
  win32: {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    cmd: 'Win',
  },
  linux: {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    cmd: 'Super',
  },
  default: {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    cmd: 'Cmd/Win',
  },
};

/**
 * Formats a single KeyBinding into a human-readable string (e.g., "Ctrl+C").
 */
export function formatKeyBinding(
  binding: KeyBinding,
  platform?: string,
): string {
  const activePlatform =
    platform ??
    (process.env['FORCE_GENERIC_KEYBINDING_HINTS']
      ? 'default'
      : process.platform);
  const modMap = MODIFIER_MAPS[activePlatform] || MODIFIER_MAPS['default'];
  const parts: string[] = [];

  if (binding.ctrl) parts.push(modMap.ctrl);
  if (binding.alt) parts.push(modMap.alt);
  if (binding.shift) parts.push(modMap.shift);
  if (binding.cmd) parts.push(modMap.cmd);

  const keyName = KEY_NAME_MAP[binding.name] || binding.name.toUpperCase();
  parts.push(keyName);

  return parts.join('+');
}

/**
 * Formats the primary keybinding for a command.
 */
export function formatCommand(
  command: Command,
  config: KeyBindingConfig = defaultKeyBindingConfig,
  platform?: string,
): string {
  const bindings = config.get(command);
  if (!bindings || bindings.length === 0) {
    return '';
  }

  // Use the first binding as the primary one for display
  return formatKeyBinding(bindings[0], platform);
}

/**
 * Formats all keybindings for a command, joined by separator.
 * Filters out platform-irrelevant bindings (e.g. cmd bindings on Windows).
 * Useful when showing alternative bindings (e.g. "Ctrl+V / Alt+V").
 */
export function formatCommandAll(
  command: Command,
  config: KeyBindingConfig = defaultKeyBindingConfig,
  platform?: string,
  separator: string = ' / ',
): string {
  const bindings = config.get(command);
  if (!bindings || bindings.length === 0) {
    return '';
  }

  const activePlatform =
    platform ??
    (process.env['FORCE_GENERIC_KEYBINDING_HINTS']
      ? 'default'
      : process.platform);

  const filtered = bindings.filter((b) => {
    // Skip cmd/super bindings on ALL platforms for display purposes.
    // In terminal environments, Cmd (macOS) and Super/Win (Linux/Windows)
    // are intercepted by the OS or terminal emulator and never reach the
    // application as keypress events. Only Kitty keyboard protocol can
    // encode the Super modifier, and even then it's unreliable.
    // Showing "Cmd+V" misleads users into thinking it works for
    // application-level paste (e.g. image paste), when in reality
    // the terminal handles Cmd+V as its own text paste.
    if (b.cmd) return false;
    // On macOS, skip alt-only bindings when a ctrl sibling exists
    // (prefer showing Ctrl+V over Option+V)
    if (
      activePlatform === 'darwin' &&
      b.alt &&
      !b.ctrl &&
      bindings.some((other) => other.ctrl && other.name === b.name)
    ) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return formatKeyBinding(bindings[0], platform);
  }

  return [...new Set(filtered.map((b) => formatKeyBinding(b, platform)))].join(
    separator,
  );
}
