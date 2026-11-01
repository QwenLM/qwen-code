/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Horizontal Tetris for the streaming wait indicator: gravity falls toward
// increasing columns, and a column clears once every row in it is filled.

export const WAITING_MINIGAME_ROWS = 7;
export const WAITING_MINIGAME_COLS = 44;
export const WAITING_MINIGAME_CLEAR_SCORE = 50;

export type WaitingMinigamePieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export interface WaitingMinigamePiece {
  type: WaitingMinigamePieceType;
  row: number;
  col: number;
  rotation: number;
}

export interface WaitingMinigameState {
  rows: number;
  cols: number;
  board: Uint8Array;
  piece: WaitingMinigamePiece | null;
  score: number;
  cleared: number;
  over: boolean;
  paused: boolean;
}

export interface WaitingMinigameOptions {
  rows?: number;
  cols?: number;
  random?: () => number;
}

const PIECE_TYPES: readonly WaitingMinigamePieceType[] = [
  'I',
  'O',
  'T',
  'S',
  'Z',
  'J',
  'L',
];

type Offset = readonly [number, number];

const BASE_OFFSETS: Record<WaitingMinigamePieceType, readonly Offset[]> = {
  I: [
    [1, 0],
    [1, 1],
    [1, 2],
    [1, 3],
  ],
  O: [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ],
  T: [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
  S: [
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
  ],
  Z: [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
  ],
  J: [
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
  L: [
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
};

function normalize(offsets: readonly Offset[]): readonly Offset[] {
  const minRow = Math.min(...offsets.map(([row]) => row));
  const minCol = Math.min(...offsets.map(([, col]) => col));
  return offsets.map(([row, col]) => [row - minRow, col - minCol] as const);
}

function rotate(offsets: readonly Offset[]): readonly Offset[] {
  // Clockwise 90 degrees, then normalized to the top-left. Casual play does
  // not need the standard SRS kick table.
  return normalize(offsets.map(([row, col]) => [col, -row] as const));
}

const ROTATIONS = PIECE_TYPES.reduce(
  (result, type) => {
    const states: (readonly Offset[])[] = [];
    let current = normalize(BASE_OFFSETS[type]);
    for (let index = 0; index < 4; index++) {
      states.push(current);
      current = rotate(current);
    }
    result[type] = states;
    return result;
  },
  {} as Record<WaitingMinigamePieceType, readonly (readonly Offset[])[]>,
);

export function waitingMinigameShape(
  type: WaitingMinigamePieceType,
  rotation: number,
): readonly Offset[] {
  const states = ROTATIONS[type];
  return states[((rotation % states.length) + states.length) % states.length]!;
}

function maxOf(offsets: readonly Offset[], axis: 0 | 1): number {
  return Math.max(...offsets.map((offset) => offset[axis]));
}

function pickRandom(random: () => number, max: number): number {
  const value = Math.floor(random() * max);
  return Math.min(max - 1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function canPlace(
  board: Uint8Array,
  rows: number,
  cols: number,
  offsets: readonly Offset[],
  row: number,
  col: number,
): boolean {
  for (const [offsetRow, offsetCol] of offsets) {
    const targetRow = row + offsetRow;
    const targetCol = col + offsetCol;
    if (
      targetRow < 0 ||
      targetRow >= rows ||
      targetCol < 0 ||
      targetCol >= cols
    )
      return false;
    if (board[targetRow * cols + targetCol]) return false;
  }
  return true;
}

function spawned(
  state: WaitingMinigameState,
  random: () => number,
): WaitingMinigameState {
  const type = PIECE_TYPES[pickRandom(random, PIECE_TYPES.length)]!;
  const offsets = waitingMinigameShape(type, 0);
  const maxRowStart = state.rows - 1 - maxOf(offsets, 0);
  if (maxRowStart < 0) return { ...state, piece: null, over: true };
  const start = pickRandom(random, maxRowStart + 1);
  for (let attempt = 0; attempt <= maxRowStart; attempt++) {
    const row = (start + attempt) % (maxRowStart + 1);
    if (canPlace(state.board, state.rows, state.cols, offsets, row, 0)) {
      return { ...state, piece: { type, row, col: 0, rotation: 0 } };
    }
  }
  return { ...state, piece: null, over: true };
}

export function createWaitingMinigame(
  options: WaitingMinigameOptions = {},
): WaitingMinigameState {
  const rows = Math.max(1, options.rows ?? WAITING_MINIGAME_ROWS);
  const cols = Math.max(1, options.cols ?? WAITING_MINIGAME_COLS);
  const initial: WaitingMinigameState = {
    rows,
    cols,
    board: new Uint8Array(rows * cols),
    piece: null,
    score: 0,
    cleared: 0,
    over: false,
    paused: false,
  };
  return spawned(initial, options.random ?? Math.random);
}

export function waitingMinigameTickMs(cleared: number): number {
  return Math.max(60, 140 - Math.max(0, cleared) * 6);
}

function moved(
  state: WaitingMinigameState,
  row: number,
  col: number,
): WaitingMinigameState {
  const piece = state.piece!;
  const offsets = waitingMinigameShape(piece.type, piece.rotation);
  if (!canPlace(state.board, state.rows, state.cols, offsets, row, col))
    return state;
  return { ...state, piece: { ...piece, row, col } };
}

export function moveWaitingMinigamePiece(
  state: WaitingMinigameState,
  deltaRow: number,
): WaitingMinigameState {
  if (state.over || state.paused || !state.piece || deltaRow === 0)
    return state;
  return moved(state, state.piece.row + deltaRow, state.piece.col);
}

export function rotateWaitingMinigamePiece(
  state: WaitingMinigameState,
): WaitingMinigameState {
  if (state.over || state.paused || !state.piece) return state;
  const piece = state.piece;
  const rotation = (piece.rotation + 1) % 4;
  const offsets = waitingMinigameShape(piece.type, rotation);
  let col = piece.col;
  const maxCol = maxOf(offsets, 1);
  if (col + maxCol >= state.cols) col = state.cols - 1 - maxCol;
  if (col < 0) col = 0;
  for (const deltaRow of [0, -1, 1, -2, 2, -3, 3]) {
    const row = piece.row + deltaRow;
    if (canPlace(state.board, state.rows, state.cols, offsets, row, col)) {
      return { ...state, piece: { ...piece, row, col, rotation } };
    }
  }
  return state;
}

function locked(
  state: WaitingMinigameState,
  random: () => number,
): WaitingMinigameState {
  const piece = state.piece;
  if (!piece) return state;
  const offsets = waitingMinigameShape(piece.type, piece.rotation);
  const board = state.board.slice();
  for (const [offsetRow, offsetCol] of offsets) {
    board[(piece.row + offsetRow) * state.cols + piece.col + offsetCol] = 1;
  }

  const fullColumns: boolean[] = [];
  let clearedColumns = 0;
  for (let col = 0; col < state.cols; col++) {
    let full = true;
    for (let row = 0; row < state.rows; row++) {
      if (!board[row * state.cols + col]) {
        full = false;
        break;
      }
    }
    fullColumns.push(full);
    if (full) clearedColumns++;
  }

  let nextBoard = board;
  if (clearedColumns > 0) {
    // Remaining columns shift left; pad empty columns at the right edge.
    nextBoard = new Uint8Array(state.rows * state.cols);
    let target = 0;
    for (let col = 0; col < state.cols; col++) {
      if (fullColumns[col]) continue;
      for (let row = 0; row < state.rows; row++) {
        nextBoard[row * state.cols + target] = board[row * state.cols + col];
      }
      target++;
    }
  }

  return spawned(
    {
      ...state,
      board: nextBoard,
      piece: null,
      score: state.score + clearedColumns * WAITING_MINIGAME_CLEAR_SCORE,
      cleared: state.cleared + clearedColumns,
    },
    random,
  );
}

/** One gravity step: move right, or lock and clear. */
export function tickWaitingMinigame(
  state: WaitingMinigameState,
  random: () => number = Math.random,
): WaitingMinigameState {
  if (state.over || state.paused || !state.piece) return state;
  const next = moved(state, state.piece.row, state.piece.col + 1);
  if (next !== state) return next;
  return locked(state, random);
}

/** Manual speed-up (ArrowRight); same lock rule as gravity. */
export function dropWaitingMinigamePiece(
  state: WaitingMinigameState,
  random: () => number = Math.random,
): WaitingMinigameState {
  return tickWaitingMinigame(state, random);
}

export function setWaitingMinigamePaused(
  state: WaitingMinigameState,
  paused: boolean,
): WaitingMinigameState {
  if (state.over || state.paused === paused) return state;
  return { ...state, paused };
}

export function toggleWaitingMinigamePause(
  state: WaitingMinigameState,
): WaitingMinigameState {
  return setWaitingMinigamePaused(state, !state.paused);
}

export function restartWaitingMinigame(
  state: WaitingMinigameState,
  random: () => number = Math.random,
): WaitingMinigameState {
  return createWaitingMinigame({
    rows: state.rows,
    cols: state.cols,
    random,
  });
}

/** 0 empty, 1 settled, 2 active piece. */
export function waitingMinigameRenderGrid(
  state: WaitingMinigameState,
): Uint8Array {
  const grid = state.board.slice();
  if (state.piece && !state.over) {
    const offsets = waitingMinigameShape(
      state.piece.type,
      state.piece.rotation,
    );
    for (const [offsetRow, offsetCol] of offsets) {
      const row = state.piece.row + offsetRow;
      const col = state.piece.col + offsetCol;
      if (row < 0 || row >= state.rows || col < 0 || col >= state.cols)
        continue;
      grid[row * state.cols + col] = 2;
    }
  }
  return grid;
}
