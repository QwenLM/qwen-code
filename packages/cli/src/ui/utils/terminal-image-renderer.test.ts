/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getTerminalImageRenderSupport,
  renderTerminalImage,
  supportsKittyImageProtocol,
} from './terminal-image-renderer.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

describe('terminalImageRenderer', () => {
  let tempDir: string;
  let imagePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-image-test-'));
    imagePath = path.join(tempDir, 'pixel.png');
    await fs.writeFile(imagePath, PNG_1X1);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('renders a Kitty virtual image with placeholder rows', async () => {
    const result = await renderTerminalImage({
      display: {
        type: 'terminal_image',
        filePath: imagePath,
        mimeType: 'image/png',
      },
      contentWidth: 24,
      availableTerminalHeight: 12,
      env: { TERM: 'xterm-kitty' },
      stdoutIsTTY: true,
    });

    expect(result.kind).toBe('kitty');
    if (result.kind !== 'kitty') return;
    expect(result.sequence).toContain('\u001b_Ga=T,f=100');
    expect(result.sequence).toContain('q=2,U=1');
    expect(result.placeholder.lines.length).toBeGreaterThan(0);
    expect(result.placeholder.lines[0]).toContain('\u{10EEEE}');
  });

  it('disables native placement in tmux, SSH, and non-TTY output', () => {
    expect(supportsKittyImageProtocol({ TERM: 'xterm-kitty' }, true)).toBe(
      true,
    );
    expect(
      supportsKittyImageProtocol(
        { TERM: 'xterm-kitty', TMUX: '/tmp/tmux' },
        true,
      ),
    ).toBe(false);
    expect(
      supportsKittyImageProtocol(
        { TERM: 'xterm-kitty', SSH_TTY: '/dev/pts/1' },
        true,
      ),
    ).toBe(false);
    expect(supportsKittyImageProtocol({ TERM: 'xterm-kitty' }, false)).toBe(
      false,
    );
  });

  it('recognizes Warp as supporting the Kitty image protocol', () => {
    expect(
      supportsKittyImageProtocol(
        { TERM: 'xterm-256color', TERM_PROGRAM: 'WarpTerminal' },
        true,
      ),
    ).toBe(true);
    expect(
      supportsKittyImageProtocol(
        { TERM: 'xterm-256color', TERM_PROGRAM: 'WarpTerminal' },
        true,
        'win32',
      ),
    ).toBe(false);
    expect(
      getTerminalImageRenderSupport(
        imagePath,
        { TERM: 'xterm-256color', TERM_PROGRAM: 'WarpTerminal' },
        true,
      ),
    ).toEqual({ available: true });
  });

  it.runIf(process.platform !== 'win32')(
    'falls back to chafa symbol output',
    async () => {
      const binDir = path.join(tempDir, 'bin');
      await fs.mkdir(binDir);
      const chafaPath = path.join(binDir, 'chafa');
      await fs.writeFile(
        chafaPath,
        '#!/usr/bin/env node\nprocess.stdout.write(process.env.TEST_RENDERER_SECRET ? "LEAKED\\n" : "\\x1b[31mFAKE_CHAFA\\x1b[0m\\n");\n',
      );
      await fs.chmod(chafaPath, 0o755);

      const result = await renderTerminalImage({
        display: {
          type: 'terminal_image',
          filePath: imagePath,
          mimeType: 'image/png',
        },
        contentWidth: 20,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
          TEST_RENDERER_SECRET: 'must-not-reach-chafa',
        },
        stdoutIsTTY: false,
      });

      expect(result).toEqual({
        kind: 'ansi',
        lines: ['\x1b[31mFAKE_CHAFA\x1b[0m'],
      });
      expect(
        getTerminalImageRenderSupport(
          imagePath,
          {
            PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
          },
          false,
        ),
      ).toEqual({ available: true });
    },
  );

  it('returns a readable fallback when chafa is unavailable', async () => {
    const result = await renderTerminalImage({
      display: {
        type: 'terminal_image',
        filePath: imagePath,
        mimeType: 'image/png',
      },
      contentWidth: 20,
      env: { PATH: tempDir },
      stdoutIsTTY: false,
    });

    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.reason).toContain(
      'chafa is not installed',
    );
    expect(
      getTerminalImageRenderSupport(imagePath, { PATH: tempDir }, true),
    ).toEqual({
      available: false,
      reason:
        'No compatible native image protocol was detected, and chafa is not installed.',
    });
  });

  it('rejects missing and invalid PNG files during restored rendering', async () => {
    const missing = await renderTerminalImage({
      display: {
        type: 'terminal_image',
        filePath: path.join(tempDir, 'missing.png'),
        mimeType: 'image/png',
      },
      contentWidth: 20,
      env: { TERM: 'xterm-kitty' },
      stdoutIsTTY: true,
    });
    expect(missing.kind).toBe('unavailable');

    await fs.writeFile(imagePath, 'not a png');
    const invalid = await renderTerminalImage({
      display: {
        type: 'terminal_image',
        filePath: imagePath,
        mimeType: 'image/png',
      },
      contentWidth: 20,
      env: { TERM: 'xterm-kitty' },
      stdoutIsTTY: true,
    });
    expect(invalid).toEqual({
      kind: 'unavailable',
      reason: 'Image is not a valid PNG.',
    });

    const oversizedPath = path.join(tempDir, 'oversized.png');
    const handle = await fs.open(oversizedPath, 'w');
    await handle.truncate(8 * 1024 * 1024 + 1);
    await handle.close();
    const oversized = await renderTerminalImage({
      display: {
        type: 'terminal_image',
        filePath: oversizedPath,
        mimeType: 'image/png',
      },
      contentWidth: 20,
      env: { TERM: 'xterm-kitty' },
      stdoutIsTTY: true,
    });
    expect(oversized.kind).toBe('unavailable');
    expect(oversized.kind === 'unavailable' && oversized.reason).toContain(
      'display limit',
    );
  });
});
