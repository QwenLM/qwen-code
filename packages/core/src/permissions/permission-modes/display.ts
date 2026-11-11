/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How each permission mode is presented in the TUI: title, short title, symbol,
 * colour.
 *
 * Colours are raw hex rather than theme tokens so the mode indicator renders
 * identically under every theme — the mode is a safety signal, and a theme must
 * not be able to make YOLO look calm.
 */

import { PermissionModes, type PermissionMode } from '../manager/decision/index.js';

export interface PermissionModeDisplay {
  /** Full title, e.g. shown in the mode selector. */
  title: string;
  /** Compact title for the status row. */
  shortTitle: string;
  /** Indicator glyph; empty for modes that need no warning. */
  symbol: string;
  /** Raw hex colour. */
  color: string;
  /** Optional one-liner for the mode selector. */
  description?: string;
}

const DISPLAY: Record<PermissionMode, PermissionModeDisplay> = {
  [PermissionModes.Default]: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: '#A0A0A0', // neutral gray — least prominent
  },
  [PermissionModes.AcceptEdits]: {
    title: 'Accept Edits',
    shortTitle: 'Accept Edits',
    symbol: '',
    color: '#C084FC', // bright purple
  },
  [PermissionModes.Auto]: {
    title: 'Auto Mode',
    shortTitle: 'Auto',
    symbol: '⏵⏵',
    color: '#FBBF24', // amber — model-driven
    description: 'Auto Mode - workspace 内操作自动批准，外部操作需确认',
  },
  [PermissionModes.DontAsk]: {
    title: "Don't Ask",
    shortTitle: "Don't Ask",
    symbol: '⏵⏵',
    color: '#F97316', // orange — serious, below YOLO
  },
  [PermissionModes.Yolo]: {
    title: 'YOLO',
    shortTitle: 'YOLO',
    symbol: '⏵⏵',
    color: '#EF4444', // vivid red — most dangerous
  },
};

/** Colours for the work-state badges, which are orthogonal to permission modes. */
export const WORK_STATE_COLORS = {
  plan: '#2DD4BF',
  goal: '#6366F1',
} as const;

function displayFor(mode: PermissionMode | undefined): PermissionModeDisplay {
  if (mode === undefined) {
    return DISPLAY[PermissionModes.Default];
  }
  return DISPLAY[mode] ?? DISPLAY[PermissionModes.Default];
}

export function permissionModeTitle(mode: PermissionMode | undefined): string {
  return displayFor(mode).title;
}

export function permissionModeShortTitle(
  mode: PermissionMode | undefined,
): string {
  return displayFor(mode).shortTitle;
}

export function permissionModeSymbol(mode: PermissionMode | undefined): string {
  return displayFor(mode).symbol;
}

export function permissionModeColor(mode: PermissionMode | undefined): string {
  return displayFor(mode).color;
}

export function permissionModeDescription(
  mode: PermissionMode | undefined,
): string | undefined {
  return displayFor(mode).description;
}
