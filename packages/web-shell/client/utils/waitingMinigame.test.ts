/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  WAITING_MINIGAME_CLEAR_SCORE,
  WAITING_MINIGAME_COLS,
  WAITING_MINIGAME_ROWS,
  createWaitingMinigame,
  dropWaitingMinigamePiece,
  moveWaitingMinigamePiece,
  restartWaitingMinigame,
  rotateWaitingMinigamePiece,
  setWaitingMinigamePaused,
  tickWaitingMinigame,
  toggleWaitingMinigamePause,
  waitingMinigameRenderGrid,
  waitingMinigameShape,
  waitingMinigameTickMs,
  type WaitingMinigamePiece,
  type WaitingMinigameState,
} from './waitingMinigame';

const firstPiece = (): number => 0;
const piece = (state: WaitingMinigameState) => {
  if (!state.piece) throw new Error('piece missing');
  return state.piece;
};
const advance = (state: WaitingMinigameState, ticks: number) => {
  let current = state;
  for (let index = 0; index < ticks; index++) {
    current = tickWaitingMinigame(current, firstPiece);
  }
  return current;
};

describe('waiting minigame engine', () => {
  it('creates a 7-row wide board with a spawned piece', () => {
    const state = createWaitingMinigame({ random: firstPiece });
    expect(state.rows).toBe(WAITING_MINIGAME_ROWS);
    expect(state.cols).toBe(WAITING_MINIGAME_COLS);
    expect(state.board).toHaveLength(
      WAITING_MINIGAME_ROWS * WAITING_MINIGAME_COLS,
    );
    expect(state.board.every((cell) => cell === 0)).toBe(true);
    expect(state.piece).toEqual({
      type: 'I',
      row: 0,
      col: 0,
      rotation: 0,
    });
    expect(state.score).toBe(0);
    expect(state.cleared).toBe(0);
    expect(state.over).toBe(false);
    expect(state.paused).toBe(false);
  });

  it('moves the piece one column per gravity tick', () => {
    const state = createWaitingMinigame({
      rows: 3,
      cols: 6,
      random: firstPiece,
    });
    const next = tickWaitingMinigame(state, firstPiece);
    expect(piece(next).col).toBe(1);
    const third = tickWaitingMinigame(next, firstPiece);
    expect(piece(third).col).toBe(2);
  });

  it('keeps vertical moves inside the board and keeps blocked moves stable', () => {
    const state = createWaitingMinigame({
      rows: 3,
      cols: 6,
      random: firstPiece,
    });
    const down = moveWaitingMinigamePiece(state, 2);
    expect(piece(down).row).toBe(2);
    expect(moveWaitingMinigamePiece(down, 1)).toBe(down);
    const up = moveWaitingMinigamePiece(down, -2);
    expect(piece(up).row).toBe(0);
    expect(moveWaitingMinigamePiece(up, -1)).toBe(up);
  });

  it('ignores movement and gravity while paused', () => {
    const state = setWaitingMinigamePaused(
      createWaitingMinigame({ rows: 3, cols: 6, random: firstPiece }),
      true,
    );
    expect(moveWaitingMinigamePiece(state, 1)).toBe(state);
    expect(tickWaitingMinigame(state, firstPiece)).toBe(state);
    expect(dropWaitingMinigamePiece(state, firstPiece)).toBe(state);
    expect(rotateWaitingMinigamePiece(state)).toBe(state);
  });

  it('kicks a rotated piece back into the row range', () => {
    let state = createWaitingMinigame({
      rows: 7,
      cols: 10,
      random: firstPiece,
    });
    for (let index = 0; index < 6; index++) {
      state = moveWaitingMinigamePiece(state, 1);
    }
    expect(piece(state).row).toBe(6);
    const rotated = rotateWaitingMinigamePiece(state);
    expect(piece(rotated).rotation).toBe(1);
    expect(piece(rotated).row).toBe(3);
  });

  it('keeps rotation inside the board at the right edge', () => {
    let state = createWaitingMinigame({
      rows: 7,
      cols: 6,
      random: firstPiece,
    });
    for (let index = 0; index < 2; index++) {
      state = tickWaitingMinigame(state, firstPiece);
    }
    expect(piece(state).col).toBe(2);
    const rotated = rotateWaitingMinigamePiece(state);
    expect(piece(rotated).rotation).toBe(1);
    expect(piece(rotated).col).toBe(2);
    expect(piece(rotated).col + 1).toBeLessThanOrEqual(rotated.cols);
  });

  it('locks, clears full columns and scores 50 per column', () => {
    let state = createWaitingMinigame({
      rows: 2,
      cols: 6,
      random: firstPiece,
    });
    state = advance(state, 3);
    expect(state.score).toBe(0);
    expect(Array.from(state.board)).toEqual([
      0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0,
    ]);
    expect(piece(state).row).toBe(1);

    state = advance(state, 3);
    expect(state.score).toBe(4 * WAITING_MINIGAME_CLEAR_SCORE);
    expect(state.cleared).toBe(4);
    expect(Array.from(state.board)).toEqual(new Array(12).fill(0));
    expect(state.piece).not.toBeNull();
    expect(state.over).toBe(false);
  });

  it('shifts remaining blocks left after clearing a column', () => {
    const base = createWaitingMinigame({
      rows: 3,
      cols: 4,
      random: firstPiece,
    });
    const board = new Uint8Array(12);
    board[0 * 4 + 0] = 1;
    board[1 * 4 + 0] = 1;
    const state: WaitingMinigameState = {
      ...base,
      board,
      piece: {
        type: 'I',
        row: 2,
        col: 0,
        rotation: 0,
      } satisfies WaitingMinigamePiece,
    };
    const next = tickWaitingMinigame(state, firstPiece);
    expect(next.cleared).toBe(1);
    expect(next.score).toBe(WAITING_MINIGAME_CLEAR_SCORE);
    expect(Array.from(next.board)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0,
    ]);
  });

  it('ends the game when no spawn position is available', () => {
    const state = createWaitingMinigame({
      rows: 1,
      cols: 3,
      random: firstPiece,
    });
    expect(state.over).toBe(true);
    expect(state.piece).toBeNull();
    expect(tickWaitingMinigame(state, firstPiece)).toBe(state);
    expect(setWaitingMinigamePaused(state, true)).toBe(state);
  });

  it('toggles pause only while running', () => {
    const state = createWaitingMinigame({
      rows: 3,
      cols: 6,
      random: firstPiece,
    });
    const paused = toggleWaitingMinigamePause(state);
    expect(paused.paused).toBe(true);
    expect(toggleWaitingMinigamePause(paused).paused).toBe(false);
    expect(setWaitingMinigamePaused(paused, true)).toBe(paused);
  });

  it('restarts with the same dimensions and a clean board', () => {
    const state = createWaitingMinigame({
      rows: 5,
      cols: 9,
      random: firstPiece,
    });
    const restart = restartWaitingMinigame(
      { ...state, score: 300, cleared: 6 },
      firstPiece,
    );
    expect(restart.rows).toBe(5);
    expect(restart.cols).toBe(9);
    expect(restart.score).toBe(0);
    expect(restart.cleared).toBe(0);
    expect(restart.board.every((cell) => cell === 0)).toBe(true);
    expect(restart.piece).not.toBeNull();
  });

  it('accelerates with cleared columns and stops at the floor', () => {
    expect(waitingMinigameTickMs(0)).toBe(140);
    expect(waitingMinigameTickMs(5)).toBe(110);
    expect(waitingMinigameTickMs(10)).toBe(80);
    expect(waitingMinigameTickMs(1_000)).toBe(60);
    expect(waitingMinigameTickMs(-3)).toBe(140);
  });

  it('separates settled blocks from the active piece in the render grid', () => {
    const state = createWaitingMinigame({
      rows: 2,
      cols: 4,
      random: firstPiece,
    });
    const grid = waitingMinigameRenderGrid(state);
    expect(Array.from(grid.slice(0, 4))).toEqual([2, 2, 2, 2]);
    expect(Array.from(grid.slice(4))).toEqual([0, 0, 0, 0]);
  });

  it('exposes four normalized rotations for every piece', () => {
    for (const type of ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const) {
      for (let rotation = 0; rotation < 4; rotation++) {
        const offsets = waitingMinigameShape(type, rotation);
        expect(offsets).toHaveLength(4);
        expect(Math.min(...offsets.map(([row]) => row))).toBe(0);
        expect(Math.min(...offsets.map(([, col]) => col))).toBe(0);
      }
      expect(waitingMinigameShape(type, 4)).toBe(waitingMinigameShape(type, 0));
    }
  });
});
