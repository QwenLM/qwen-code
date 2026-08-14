/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PetState } from '../shared/desktop-api';

export const PET_COLUMNS = 8;
export const PET_ROWS = 9;
export const PET_CELL_WIDTH = 192;
export const PET_CELL_HEIGHT = 208;
export const PET_BACKGROUND_SIZE = `${PET_COLUMNS * 100}% ${PET_ROWS * 100}%`;

export interface PetFrame {
  rowIndex: number;
  columnIndex: number;
  durationMs: number;
}

export interface PetSequence {
  frames: PetFrame[];
  loopStartIndex: number;
}

function buildRow(
  rowIndex: number,
  count: number,
  normalMs: number,
  lastMs: number,
): PetFrame[] {
  return Array.from({ length: count }, (_, columnIndex) => ({
    rowIndex,
    columnIndex,
    durationMs: columnIndex === count - 1 ? lastMs : normalMs,
  }));
}

const IDLE_FRAMES: PetFrame[] = [
  { rowIndex: 0, columnIndex: 0, durationMs: 280 },
  { rowIndex: 0, columnIndex: 1, durationMs: 110 },
  { rowIndex: 0, columnIndex: 2, durationMs: 110 },
  { rowIndex: 0, columnIndex: 3, durationMs: 140 },
  { rowIndex: 0, columnIndex: 4, durationMs: 140 },
  { rowIndex: 0, columnIndex: 5, durationMs: 320 },
];

const IDLE_SETTLED = IDLE_FRAMES.map((frame) => ({
  ...frame,
  durationMs: frame.durationMs * 6,
}));

const STATE_FRAMES: Record<PetState, PetFrame[]> = {
  idle: IDLE_FRAMES,
  running: buildRow(7, 6, 120, 220),
  waiting: buildRow(6, 6, 150, 260),
  jumping: buildRow(4, 5, 140, 280),
  failed: buildRow(5, 8, 140, 240),
};

export function buildPetSequence(state: PetState): PetSequence {
  if (state === 'idle') {
    return { frames: IDLE_SETTLED, loopStartIndex: 0 };
  }
  const action = Array.from({ length: 3 }, () => STATE_FRAMES[state]).flat();
  return {
    frames: [...action, ...IDLE_SETTLED],
    loopStartIndex: action.length,
  };
}

export function petBackgroundPosition(frame: PetFrame): string {
  const x = (frame.columnIndex / (PET_COLUMNS - 1)) * 100;
  const y = (frame.rowIndex / (PET_ROWS - 1)) * 100;
  return `${x}% ${y}%`;
}
