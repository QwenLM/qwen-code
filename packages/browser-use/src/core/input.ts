/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Keyboard and mouse descriptors for CDP Input.* commands. These are pure
// data helpers: the trusted backend turns model-facing key names and button
// numbers into the fields Chrome expects, so the page receives real (isTrusted)
// input events instead of synthetic DOM events.
import { BrowserRuntimeError } from './errors.js';

export type CdpMouseButton = 'left' | 'middle' | 'right' | 'back' | 'forward';
export type CdpModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export const MODIFIER_BITS: Readonly<Record<CdpModifier, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export interface KeyDescription {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

export interface KeyCombination {
  modifiers: CdpModifier[];
  key: KeyDescription | undefined;
}

export function modifierName(
  value: string,
  platform: NodeJS.Platform = process.platform,
): CdpModifier | undefined {
  switch (value.replace(/[\s_-]/g, '').toLowerCase()) {
    case 'alt':
    case 'option':
      return 'Alt';
    case 'control':
    case 'ctrl':
      return 'Control';
    case 'controlormeta':
    case 'ctrlormeta':
      return platform === 'darwin' ? 'Meta' : 'Control';
    case 'meta':
    case 'command':
    case 'cmd':
      return 'Meta';
    case 'shift':
      return 'Shift';
    default:
      return undefined;
  }
}

export function modifierMask(values: readonly unknown[] | undefined): number {
  if (values === undefined) return 0;
  return values.reduce<number>((mask, item) => {
    if (typeof item !== 'string')
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        'Modifier keys must be strings',
      );
    const modifier = modifierName(item);
    if (modifier === undefined)
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `Unsupported modifier key: ${item}`,
      );
    return mask | MODIFIER_BITS[modifier];
  }, 0);
}

const NAMED_KEYS: Readonly<Record<string, KeyDescription>> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  return: {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
  },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  del: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowright: {
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  capslock: { key: 'CapsLock', code: 'CapsLock', windowsVirtualKeyCode: 20 },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `f${index + 1}`,
      {
        key: `F${index + 1}`,
        code: `F${index + 1}`,
        windowsVirtualKeyCode: 112 + index,
      },
    ]),
  ),
};

/** Describe one key: a modifier, a named key such as Enter, or a single character. */
export function keyDescription(value: string): KeyDescription {
  const modifier = modifierName(value);
  if (modifier !== undefined) {
    const virtualKey = { Alt: 18, Control: 17, Meta: 91, Shift: 16 }[modifier];
    return {
      key: modifier,
      code: `${modifier}Left`,
      windowsVirtualKeyCode: virtualKey,
    };
  }
  const named = NAMED_KEYS[value.replace(/[\s_-]/g, '').toLowerCase()];
  if (named !== undefined && [...value].length > 1) return { ...named };

  const characters = [...value];
  if (characters.length !== 1)
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `Unsupported key name: ${value}`,
    );
  const character = characters[0] as string;
  if (character === '\n' || character === '\r')
    return { ...(NAMED_KEYS.enter as KeyDescription) };
  if (character === '\t') return { ...(NAMED_KEYS.tab as KeyDescription) };
  const upper = character.toUpperCase();
  const isLetter = /^[A-Z]$/.test(upper);
  const isDigit = /^[0-9]$/.test(character);
  return {
    key: character,
    code: isLetter
      ? `Key${upper}`
      : isDigit
        ? `Digit${character}`
        : character === ' '
          ? 'Space'
          : '',
    windowsVirtualKeyCode:
      isLetter || isDigit
        ? (upper.codePointAt(0) as number)
        : character === ' '
          ? 32
          : 0,
    text: character,
  };
}

/** Parse Playwright-style combinations such as "Control+Shift+a", "Enter" or "Shift". */
export function parseKeyCombination(value: string): KeyCombination {
  const trimmed = value.trim();
  if (trimmed === '')
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      'Key name must not be empty',
    );
  const tokens =
    trimmed === '+'
      ? ['+']
      : trimmed.split('+').map((token) => (token === '' ? '+' : token));
  const modifiers: CdpModifier[] = [];
  let key: KeyDescription | undefined;
  tokens.forEach((token, index) => {
    const modifier = modifierName(token);
    if (
      modifier !== undefined &&
      (index < tokens.length - 1 || key === undefined)
    ) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      return;
    }
    if (index !== tokens.length - 1) {
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        `Only the last key in "${value}" may be a non-modifier key`,
      );
    }
    key = keyDescription(token);
  });
  return { modifiers, key };
}

/** True for characters that can be typed as one keyDown/keyUp pair with text. */
export function isDirectlyTypable(character: string): boolean {
  return /^[\x20-\x7e]$/.test(character);
}

export function mouseButton(value: unknown): CdpMouseButton {
  switch (value) {
    case undefined:
    case 1:
    case 'left':
      return 'left';
    case 2:
    case 'middle':
      return 'middle';
    case 3:
    case 'right':
      return 'right';
    case 4:
    case 'back':
      return 'back';
    case 5:
    case 'forward':
      return 'forward';
    default:
      throw new BrowserRuntimeError(
        'INVALID_ARGUMENT',
        'Unsupported mouse button',
      );
  }
}

export function mouseButtonMask(button: CdpMouseButton): number {
  return { left: 1, right: 2, middle: 4, back: 8, forward: 16 }[button];
}
