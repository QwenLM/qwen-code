/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { initialWindowBounds, normalizeDesktopState } from './state';

describe('Electron desktop state', () => {
  it('drops malformed persisted fields', () => {
    expect(normalizeDesktopState({ workspace: 42, window: 'bad' })).toEqual({});
  });

  it('migrates the single Phase 1 window and normalizes browser state', () => {
    expect(
      normalizeDesktopState({
        window: { x: 1, y: 2, width: 1000, height: 700, maximized: true },
        browser: {
          url: 'https://example.com',
          window: {
            x: 3,
            y: 4,
            width: 1100,
            height: 720,
            maximized: false,
          },
        },
      }),
    ).toEqual({
      window: { x: 1, y: 2, width: 1000, height: 700, maximized: true },
      browser: {
        url: 'https://example.com/',
        window: {
          x: 3,
          y: 4,
          width: 1100,
          height: 720,
          maximized: false,
        },
      },
    });
  });

  it('caps restored chat windows', () => {
    const windows = Array.from({ length: 12 }, (_, index) => ({
      x: index,
      y: index,
      width: 1000,
      height: 700,
      maximized: false,
    }));
    expect(
      normalizeDesktopState({ chatWindows: windows }).chatWindows,
    ).toHaveLength(8);
  });

  it('restores the session owned by each chat window', () => {
    expect(
      normalizeDesktopState({
        chatWindows: [
          {
            x: 1,
            y: 2,
            width: 1000,
            height: 700,
            maximized: false,
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
          },
        ],
      }).chatWindows,
    ).toEqual([
      {
        x: 1,
        y: 2,
        width: 1000,
        height: 700,
        maximized: false,
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
      },
    ]);
  });

  it('restores visible bounds and clamps the minimum size', () => {
    expect(
      initialWindowBounds(
        { x: 20, y: 30, width: 100, height: 100, maximized: false },
        [{ x: 0, y: 0, width: 1920, height: 1080 }],
      ),
    ).toEqual({ x: 20, y: 30, width: 900, height: 600, maximized: false });
  });

  it('centers defaults when saved bounds are off-screen', () => {
    const bounds = initialWindowBounds(
      { x: 5000, y: 5000, width: 900, height: 600, maximized: false },
      [{ x: 0, y: 0, width: 1920, height: 1080 }],
    );
    expect(bounds).toEqual({
      x: 320,
      y: 130,
      width: 1280,
      height: 820,
      maximized: false,
    });
  });
});
