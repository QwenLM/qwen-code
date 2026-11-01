/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Snake for the waiting card. The board is wide and short, matching the
// horizontal activity heatmap and the Tetris board.

export const WAITING_SNAKE_ROWS = 7;
export const WAITING_SNAKE_COLS = 44;
export const WAITING_SNAKE_LENGTH = 3;

export type WaitingSnakeDirection = 'up' | 'down' | 'left' | 'right';

export interface WaitingSnakeCell {
  row: number;
  col: number;
}

export interface WaitingSnakeState {
  rows: number;
  cols: number;
  /** Head first. */
  snake: readonly WaitingSnakeCell[];
  direction: WaitingSnakeDirection;
  /** Directions applied one per tick; at most two are queued. */
  pending: readonly WaitingSnakeDirection[];
  food: WaitingSnakeCell | null;
  score: number;
  over: boolean;
  paused: boolean;
}

export interface WaitingSnakeOptions {
  rows?: number;
  cols?: number;
  random?: () => number;
}

const VECTORS: Record<WaitingSnakeDirection, WaitingSnakeCell> = {
  up: { row: -1, col: 0 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
  right: { row: 0, col: 1 },
};

const OPPOSITE: Record<WaitingSnakeDirection, WaitingSnakeDirection> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

function sameCell(a: WaitingSnakeCell, b: WaitingSnakeCell): boolean {
  return a.row === b.row && a.col === b.col;
}

function spawnFood(
  rows: number,
  cols: number,
  snake: readonly WaitingSnakeCell[],
  random: () => number,
): WaitingSnakeCell | null {
  const occupied = new Set(snake.map((cell) => `${cell.row}:${cell.col}`));
  const free: WaitingSnakeCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!occupied.has(`${row}:${col}`)) free.push({ row, col });
    }
  }
  if (free.length === 0) return null;
  const index = Math.min(
    free.length - 1,
    Math.max(0, Math.floor(random() * free.length)),
  );
  return free[index]!;
}

export function createWaitingSnake(
  options: WaitingSnakeOptions = {},
): WaitingSnakeState {
  const rows = Math.max(2, options.rows ?? WAITING_SNAKE_ROWS);
  const cols = Math.max(4, options.cols ?? WAITING_SNAKE_COLS);
  const length = Math.min(WAITING_SNAKE_LENGTH, cols - 1);
  const row = Math.floor(rows / 2);
  const snake: WaitingSnakeCell[] = Array.from({ length }, (_, index) => ({
    row,
    col: length - 1 - index,
  }));
  return {
    rows,
    cols,
    snake,
    direction: 'right',
    pending: [],
    food: spawnFood(rows, cols, snake, options.random ?? Math.random),
    score: 0,
    over: false,
    paused: false,
  };
}

export function turnWaitingSnake(
  state: WaitingSnakeState,
  direction: WaitingSnakeDirection,
): WaitingSnakeState {
  if (state.over || state.paused) return state;
  const last = state.pending.at(-1) ?? state.direction;
  if (direction === last || direction === OPPOSITE[last]) return state;
  if (state.pending.length >= 2) return state;
  return { ...state, pending: [...state.pending, direction] };
}

export function waitingSnakeTickMs(score: number): number {
  return Math.max(70, 150 - Math.max(0, score) * 4);
}

export function tickWaitingSnake(
  state: WaitingSnakeState,
  random: () => number = Math.random,
): WaitingSnakeState {
  if (state.over || state.paused) return state;
  const direction = state.pending[0] ?? state.direction;
  const pending = state.pending.slice(1);
  const head = state.snake[0]!;
  const vector = VECTORS[direction];
  const next = { row: head.row + vector.row, col: head.col + vector.col };
  if (
    next.row < 0 ||
    next.row >= state.rows ||
    next.col < 0 ||
    next.col >= state.cols
  ) {
    return { ...state, direction, pending, over: true };
  }
  const eating = state.food !== null && sameCell(next, state.food);
  const body = eating ? state.snake : state.snake.slice(0, -1);
  if (body.some((cell) => sameCell(cell, next))) {
    return { ...state, direction, pending, over: true };
  }
  const snake = eating
    ? [next, ...state.snake]
    : [next, ...state.snake.slice(0, -1)];
  const score = state.score + (eating ? 1 : 0);
  if (!eating) {
    return { ...state, snake, direction, pending, score };
  }
  const food = spawnFood(state.rows, state.cols, snake, random);
  return {
    ...state,
    snake,
    direction,
    pending,
    food,
    score,
    over: food === null,
  };
}

export function setWaitingSnakePaused(
  state: WaitingSnakeState,
  paused: boolean,
): WaitingSnakeState {
  if (state.over || state.paused === paused) return state;
  return { ...state, paused };
}

export function toggleWaitingSnakePause(
  state: WaitingSnakeState,
): WaitingSnakeState {
  return setWaitingSnakePaused(state, !state.paused);
}

export function restartWaitingSnake(
  state: WaitingSnakeState,
  random: () => number = Math.random,
): WaitingSnakeState {
  return createWaitingSnake({
    rows: state.rows,
    cols: state.cols,
    random,
  });
}

/** 0 empty, 1 body, 2 head, 3 food. */
export function waitingSnakeRenderGrid(state: WaitingSnakeState): Uint8Array {
  const grid = new Uint8Array(state.rows * state.cols);
  for (const cell of state.snake) {
    if (
      cell.row < 0 ||
      cell.row >= state.rows ||
      cell.col < 0 ||
      cell.col >= state.cols
    ) {
      continue;
    }
    grid[cell.row * state.cols + cell.col] = 1;
  }
  const head = state.snake[0];
  if (head) grid[head.row * state.cols + head.col] = 2;
  if (state.food) {
    grid[state.food.row * state.cols + state.food.col] = 3;
  }
  return grid;
}
