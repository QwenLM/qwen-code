/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  detectTerminalImageProtocol,
  fitTerminalImage,
  formatImageFallback,
  prepareTerminalImage,
  readImageSize,
} from './terminal-image.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);
const JPEG_2X1 = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x02, 0x03, 0x01,
  0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);
const WEBP_VP8X_3X2 = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00,
  0x00, 0x01, 0x00, 0x00,
]);

describe('terminal image protocol detection', () => {
  it.each([
    [{ TERM: 'xterm-kitty' }, 'kitty'],
    [{ TERM_PROGRAM: 'Ghostty' }, 'kitty'],
    [{ TERM_PROGRAM: 'WezTerm' }, 'iterm2'],
    [{ WARP_SESSION_ID: 'session' }, 'iterm2'],
    [{ TERM_PROGRAM: 'iTerm.app' }, 'iterm2'],
  ] as const)('detects supported terminal environments', (env, protocol) => {
    expect(detectTerminalImageProtocol(env, { isTTY: true })).toBe(protocol);
  });

  it('disables images for multiplexed, remote, and non-TTY sessions', () => {
    expect(
      detectTerminalImageProtocol(
        { TERM: 'xterm-kitty', TMUX: 'session' },
        { isTTY: true },
      ),
    ).toBeNull();
    expect(
      detectTerminalImageProtocol(
        { TERM: 'xterm-kitty', SSH_CONNECTION: 'remote' },
        { isTTY: true },
      ),
    ).toBeNull();
    expect(
      detectTerminalImageProtocol({ TERM: 'xterm-kitty' }, { isTTY: false }),
    ).toBeNull();
  });

  it('supports explicit protocol selection and opt-out', () => {
    expect(
      detectTerminalImageProtocol({}, { isTTY: true, forceProtocol: 'kitty' }),
    ).toBe('kitty');
    expect(
      detectTerminalImageProtocol({}, { isTTY: true, forceProtocol: 'off' }),
    ).toBeNull();
    expect(
      detectTerminalImageProtocol(
        { QWEN_CODE_DISABLE_TERMINAL_IMAGES: '1' },
        { isTTY: true, forceProtocol: 'kitty' },
      ),
    ).toBeNull();
  });
});

describe('terminal image preparation', () => {
  it('prepares PNG data for Kitty virtual placement', () => {
    const result = prepareTerminalImage({
      data: PNG_1X1.toString('base64'),
      mimeType: 'image/png',
      contentWidth: 40,
      availableTerminalHeight: 12,
      env: {},
      detection: { isTTY: true, forceProtocol: 'kitty' },
    });

    expect(result).toMatchObject({
      kind: 'terminal-image',
      protocol: 'kitty',
      dimensions: { width: 1, height: 1 },
      fallbackText: '[image: 1x1 png]',
    });
    expect(result.kind === 'terminal-image' && result.sequence).toContain(
      '\u001b_Ga=T,f=100',
    );
    expect(
      result.kind === 'terminal-image' && result.placeholder?.lines,
    ).toHaveLength(12);
  });

  it('prepares JPEG data for iTerm2 and rejects it for Kitty', () => {
    const common = {
      data: JPEG_2X1.toString('base64'),
      mimeType: 'image/jpeg',
      contentWidth: 40,
      env: {},
    };

    const iterm = prepareTerminalImage({
      ...common,
      detection: { isTTY: true, forceProtocol: 'iterm2' },
    });
    expect(iterm).toMatchObject({
      kind: 'terminal-image',
      protocol: 'iterm2',
      dimensions: { width: 2, height: 1 },
    });
    expect(iterm.kind === 'terminal-image' && iterm.sequence).toContain(
      '\u001b]1337;File=inline=1',
    );

    expect(
      prepareTerminalImage({
        ...common,
        detection: { isTTY: true, forceProtocol: 'kitty' },
      }),
    ).toMatchObject({
      kind: 'fallback',
      text: '[image: 2x1 jpeg]',
      reason: 'unsupported-protocol-format',
    });
  });

  it('returns descriptive fallbacks for invalid data and unsupported terminals', () => {
    expect(
      prepareTerminalImage({
        data: 'not base64!',
        mimeType: 'image/png',
        contentWidth: 40,
      }),
    ).toEqual({
      kind: 'fallback',
      text: '[image: png]',
      reason: 'invalid-data',
    });
    expect(
      prepareTerminalImage({
        data: 'A'.repeat(Math.ceil((8 * 1024 * 1024 * 4) / 3) + 5),
        mimeType: 'image/png',
        contentWidth: 40,
      }),
    ).toMatchObject({ kind: 'fallback', reason: 'invalid-data' });

    expect(
      prepareTerminalImage({
        data: PNG_1X1.toString('base64'),
        mimeType: 'image/png',
        contentWidth: 40,
        env: {},
        detection: { isTTY: true },
      }),
    ).toMatchObject({
      kind: 'fallback',
      text: '[image: 1x1 png]',
      reason: 'unsupported-terminal',
    });
  });

  it('reads supported image headers and fits within terminal bounds', () => {
    expect(readImageSize(JPEG_2X1, ' IMAGE/JPEG ')).toEqual({
      width: 2,
      height: 1,
    });
    expect(readImageSize(WEBP_VP8X_3X2, 'image/webp')).toEqual({
      width: 3,
      height: 2,
    });
    const invalidPng = Buffer.from(PNG_1X1);
    invalidPng.write('NOPE', 12, 'ascii');
    expect(readImageSize(invalidPng, 'image/png')).toBeNull();
    expect(fitTerminalImage({ width: 100, height: 200 }, 200, 10)).toEqual({
      widthCells: 10,
      rows: 10,
    });
    expect(
      fitTerminalImage({ width: 100, height: 200 }, Number.NaN, Number.NaN),
    ).toEqual({ widthCells: 1, rows: 1 });
    expect(formatImageFallback('image/webp', { width: 20, height: 10 })).toBe(
      '[image: 20x10 webp]',
    );
  });
});
