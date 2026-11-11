/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-platform terminal figures / symbols.
 *
 * Inspired by the `figures` npm package, this module provides Unicode
 * symbols with ASCII fallbacks for terminals that lack Unicode support
 * (e.g. legacy Windows CMD / conhost with CP437 codepage).
 *
 * Usage:
 *   import { figures } from '../../utils/figures.js';
 *   <Text>{figures.pointer} Select an option</Text>
 */

import { isUnicodeSupported } from './terminalUtils.js';

interface Figures {
  /** ❯  — prompt pointer / chevron right */
  readonly pointer: string;
  /** ▶  — play / expand right */
  readonly play: string;
  /** ⏸  — pause (not the emoji variant) */
  readonly pause: string;
  /** ●  — filled circle / bullet */
  readonly bullet: string;
  /** ○  — empty circle */
  readonly circle: string;
  /** ◆  — filled diamond */
  readonly diamond: string;
  /** ✔  — check mark */
  readonly tick: string;
  /** ✖  — cross / x mark */
  readonly cross: string;
  /** …  — ellipsis */
  readonly ellipsis: string;
  /** ★  — star */
  readonly star: string;
  /** ⚠  — warning */
  readonly warning: string;
  /** ℹ  — info */
  readonly info: string;
  /** ↑  — arrow up */
  readonly arrowUp: string;
  /** ↓  — arrow down */
  readonly arrowDown: string;
  /** ←  — arrow left */
  readonly arrowLeft: string;
  /** →  — arrow right */
  readonly arrowRight: string;
  /** ◀  — left-pointing triangle (option switch control) */
  readonly triangleLeft: string;
  /** ▶  — right-pointing triangle (option switch control) */
  readonly triangleRight: string;
  /** 🔒  — lock (read-only indicator) */
  readonly lock: string;
  /** ▦  — context window / token budget */
  readonly contextWindow: string;
  /** ✦  — thinking effort / reasoning depth */
  readonly thinkingEffort: string;
  /** ◉  — vision / multimodal capability */
  readonly vision: string;
  /** ■  — filled cell of the reasoning-effort gauge */
  readonly meterFilled: string;
  /** □  — empty cell of the reasoning-effort gauge */
  readonly meterEmpty: string;
  /** ✎  — a value changed in a dialog but not applied yet */
  readonly modified: string;
}

const UNICODE_FIGURES: Figures = {
  pointer: '❯',
  play: '▶',
  pause: '⏸',
  bullet: '●',
  circle: '○',
  diamond: '◆',
  tick: '✔',
  cross: '✖',
  ellipsis: '…',
  star: '★',
  warning: '⚠',
  info: 'ℹ',
  arrowUp: '↑',
  arrowDown: '↓',
  arrowLeft: '←',
  arrowRight: '→',
  triangleLeft: '◀',
  triangleRight: '▶',
  lock: '🔒',
  contextWindow: '▦',
  thinkingEffort: '✦',
  vision: '◉',
  meterFilled: '■',
  meterEmpty: '□',
  modified: '✎',
};

const ASCII_FIGURES: Figures = {
  pointer: '>',
  play: '>',
  pause: '||',
  bullet: '*',
  circle: 'o',
  diamond: '+',
  tick: 'v',
  cross: 'x',
  ellipsis: '...',
  star: '*',
  warning: '!',
  info: 'i',
  arrowUp: '^',
  arrowDown: 'v',
  arrowLeft: '<',
  arrowRight: '>',
  triangleLeft: '<',
  triangleRight: '>',
  lock: '[x]',
  contextWindow: '#',
  thinkingEffort: '*',
  vision: '(o)',
  meterFilled: '#',
  meterEmpty: '-',
  modified: '~',
} as const;

/**
 * Terminal-safe figures object. Returns Unicode glyphs when supported,
 * ASCII fallbacks otherwise. The value is determined once at import time.
 */
export const figures: Figures = isUnicodeSupported()
  ? UNICODE_FIGURES
  : ASCII_FIGURES;
