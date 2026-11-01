/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  WAITING_SNAKE_COLS,
  WAITING_SNAKE_LENGTH,
  WAITING_SNAKE_ROWS,
  createWaitingSnake,
  restartWaitingSnake,
  setWaitingSnakePaused,
  tickWaitingSnake,
  toggleWaitingSnakePause,
  turnWaitingSnake,
  waitingSnakeRenderGrid,
  waitingSnakeTickMs,
  type WaitingSnakeState,
} from './waitingSnake';

const firstFood = (): number => 0;
const head = (state: WaitingSnakeState) => state.snake[0]!;

describe('waiting snake engine', () => {
  it('creates a short snake moving right with food off the body', () => {
    const state = createWaitingSnake({ random: firstFood });
    expect(state.rows).toBe(WAITING_SNAKE_ROWS);
    expect(state.cols).toBe(WAITING_SNAKE_COLS);
    expect(state.snake).toHaveLength(WAITING_SNAKE_LENGTH);
    expect(state.direction).toBe('right');
    expect(state.food).not.toBeNull();
    expect(
      state.snake.some(
        (cell) => cell.row === state.food!.row && cell.col === state.food!.col,
      ),
    ).toBe(false);
  });

  it('moves one cell per tick and keeps the length', () => {
    const state = createWaitingSnake({ random: firstFood });
    const next = tickWaitingSnake(state, firstFood);
    expect(head(next).col).toBe(head(state).col + 1);
    expect(next.snake).toHaveLength(WAITING_SNAKE_LENGTH);
  });

  it('queues turns and ignores reversals', () => {
    const state = createWaitingSnake({ random: firstFood });
    const reversed = turnWaitingSnake(state, 'left');
    expect(reversed).toBe(state);
    const turned = turnWaitingSnake(state, 'up');
    expect(turned.pending).toEqual(['up']);
    const second = turnWaitingSnake(turned, 'left');
    expect(second.pending).toEqual(['up', 'left']);
    expect(turnWaitingSnake(second, 'down').pending).toEqual(['up', 'left']);
    const afterUp = tickWaitingSnake(second, firstFood);
    expect(afterUp.direction).toBe('up');
    expect(afterUp.pending).toEqual(['left']);
    const afterLeft = tickWaitingSnake(afterUp, firstFood);
    expect(afterLeft.direction).toBe('left');
  });

  it('eats food, grows and scores', () => {
    const state = createWaitingSnake({ random: firstFood });
    const ahead = {
      row: head(state).row,
      col: head(state).col + 1,
    };
    const next = tickWaitingSnake({ ...state, food: ahead }, firstFood);
    expect(next.score).toBe(1);
    expect(next.snake).toHaveLength(WAITING_SNAKE_LENGTH + 1);
    expect(next.over).toBe(false);
    expect(next.food).not.toEqual(ahead);
  });

  it('ends the game at a wall', () => {
    let state = createWaitingSnake({ rows: 3, cols: 6, random: firstFood });
    state = { ...state, food: null };
    for (let index = 0; index < 10 && !state.over; index++) {
      state = tickWaitingSnake(state, firstFood);
    }
    expect(state.over).toBe(true);
  });

  it('ends the game when the head enters the body', () => {
    const base = createWaitingSnake({ rows: 5, cols: 8, random: firstFood });
    const state: WaitingSnakeState = {
      ...base,
      snake: [
        { row: 2, col: 3 },
        { row: 2, col: 2 },
        { row: 1, col: 2 },
        { row: 1, col: 3 },
        { row: 1, col: 4 },
      ],
      direction: 'up',
      pending: [],
      food: { row: 4, col: 0 },
    };
    const next = tickWaitingSnake(state, firstFood);
    expect(next.over).toBe(true);
  });

  it('pauses and restarts without changing dimensions', () => {
    const state = createWaitingSnake({ rows: 4, cols: 9, random: firstFood });
    const paused = toggleWaitingSnakePause(state);
    expect(paused.paused).toBe(true);
    expect(tickWaitingSnake(paused, firstFood)).toBe(paused);
    expect(setWaitingSnakePaused(paused, false).paused).toBe(false);
    const restart = restartWaitingSnake(
      { ...state, score: 5, over: true },
      firstFood,
    );
    expect(restart.rows).toBe(4);
    expect(restart.cols).toBe(9);
    expect(restart.score).toBe(0);
    expect(restart.over).toBe(false);
  });

  it('renders body, head and food distinctly', () => {
    const state = createWaitingSnake({ rows: 3, cols: 6, random: firstFood });
    const grid = waitingSnakeRenderGrid(state);
    const headIndex = head(state).row * state.cols + head(state).col;
    expect(grid[headIndex]).toBe(2);
    expect(grid.filter((cell) => cell === 1)).toHaveLength(
      WAITING_SNAKE_LENGTH - 1,
    );
    const foodIndex = state.food!.row * state.cols + state.food!.col;
    expect(grid[foodIndex]).toBe(3);
  });

  it('accelerates with score and has a floor', () => {
    expect(waitingSnakeTickMs(0)).toBe(240);
    expect(waitingSnakeTickMs(5)).toBe(215);
    expect(waitingSnakeTickMs(100)).toBe(100);
    expect(waitingSnakeTickMs(-1)).toBe(240);
  });
});
