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

  it('keeps one window and drops removed desktop surfaces', () => {
    expect(
      normalizeDesktopState({
        workspace: '/workspace',
        window: { x: 1, y: 2, width: 1000, height: 700, maximized: true },
        browser: { url: 'https://example.com' },
      }),
    ).toEqual({
      workspace: '/workspace',
      window: { x: 1, y: 2, width: 1000, height: 700, maximized: true },
    });
  });

  it('keeps the Electron-owned Computer Use preference', () => {
    expect(
      normalizeDesktopState({
        computerUse: { alwaysHidePictureInPicture: true },
      }),
    ).toEqual({ computerUse: { alwaysHidePictureInPicture: true } });
    expect(
      normalizeDesktopState({
        computerUse: { alwaysHidePictureInPicture: 'yes' },
      }),
    ).toEqual({});
  });

  it('migrates the first legacy chat window into the single window', () => {
    expect(
      normalizeDesktopState({
        chatWindows: [
          {
            x: 3,
            y: 4,
            width: 1100,
            height: 720,
            maximized: false,
            sessionId: 'removed-session-state',
          },
        ],
      }),
    ).toEqual({
      window: { x: 3, y: 4, width: 1100, height: 720, maximized: false },
    });
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
