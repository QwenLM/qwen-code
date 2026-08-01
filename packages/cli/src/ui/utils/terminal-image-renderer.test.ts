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

function pngWithSize(width: number, height: number): Buffer {
  const png = Buffer.from(PNG_1X1);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

const IMAGE_SIZE_CASES: Array<
  [
    name: string,
    imageWidth: number,
    imageHeight: number,
    contentWidth: number,
    availableTerminalHeight: number | undefined,
    expectedWidth: number,
    expectedRows: number,
  ]
> = [
  ['keeps a small landscape at its natural size', 320, 160, 200, 100, 40, 10],
  ['does not round a small image up', 12, 24, 200, 100, 1, 1],
  ['caps a large landscape by width', 1600, 800, 200, 100, 72, 18],
  ['caps a large square by default height', 1600, 1600, 200, undefined, 48, 24],
  ['fits a large portrait without distortion', 800, 1600, 200, 100, 24, 24],
  ['respects a narrower terminal', 1600, 1600, 30, 100, 30, 15],
  ['respects a shorter terminal', 1600, 1600, 200, 10, 20, 10],
];

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
    expect(result.sequence).toContain('c=1,r=1');
    expect(result.placeholder.lines).toHaveLength(1);
    expect(result.placeholder.lines[0]).toContain('\u{10EEEE}');
  });

  it.each(IMAGE_SIZE_CASES)(
    '%s',
    async (
      _name,
      imageWidth,
      imageHeight,
      contentWidth,
      availableTerminalHeight,
      expectedWidth,
      expectedRows,
    ) => {
      await fs.writeFile(imagePath, pngWithSize(imageWidth, imageHeight));

      const result = renderTerminalImage({
        display: {
          type: 'terminal_image',
          filePath: imagePath,
          mimeType: 'image/png',
        },
        contentWidth,
        availableTerminalHeight,
        env: { TERM: 'xterm-kitty' },
        stdoutIsTTY: true,
      });

      expect(result.kind).toBe('kitty');
      if (result.kind !== 'kitty') return;
      expect(result.sequence).toContain(`c=${expectedWidth},r=${expectedRows}`);
      expect(result.placeholder.lines).toHaveLength(expectedRows);
      expect(result.placeholder.lines[0].split('\u{10EEEE}').length - 1).toBe(
        expectedWidth,
      );
    },
  );

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
    expect(
      supportsKittyImageProtocol(
        { TERM: 'xterm-kitty', SSH_CLIENT: '10.0.0.1 51234 22' },
        true,
      ),
    ).toBe(false);
    expect(supportsKittyImageProtocol({ TERM: 'xterm-kitty' }, false)).toBe(
      false,
    );
  });

  it('does not use Kitty Unicode placeholders in Warp', () => {
    expect(
      supportsKittyImageProtocol(
        { TERM: 'xterm-256color', TERM_PROGRAM: 'WarpTerminal' },
        true,
      ),
    ).toBe(false);
    expect(
      supportsKittyImageProtocol(
        { TERM: 'xterm-kitty', TERM_PROGRAM: 'WarpTerminal' },
        true,
      ),
    ).toBe(false);
    expect(
      getTerminalImageRenderSupport(
        {
          PATH: tempDir,
          TERM: 'xterm-256color',
          TERM_PROGRAM: 'WarpTerminal',
        },
        true,
      ),
    ).toEqual({
      available: false,
      reason:
        'No compatible native image protocol was detected, and chafa is not installed.',
    });
  });

  it.runIf(process.platform !== 'win32')(
    'falls back to chafa symbol output',
    async () => {
      const binDir = path.join(tempDir, 'bin');
      await fs.mkdir(binDir);
      const chafaPath = path.join(binDir, 'chafa');
      await fs.writeFile(
        chafaPath,
        '#!/usr/bin/env node\nprocess.stdout.write(process.env.TEST_RENDERER_SECRET ? "LEAKED\\n" : `${process.argv.find((arg) => arg.startsWith("--size="))}\\n`);\n',
      );
      await fs.chmod(chafaPath, 0o755);
      await fs.writeFile(imagePath, pngWithSize(1600, 800));

      const result = await renderTerminalImage({
        display: {
          type: 'terminal_image',
          filePath: imagePath,
          mimeType: 'image/png',
        },
        contentWidth: 20,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
          TERM: 'xterm-256color',
          TERM_PROGRAM: 'WarpTerminal',
          TEST_RENDERER_SECRET: 'must-not-reach-chafa',
        },
        stdoutIsTTY: true,
      });

      expect(result).toEqual({
        kind: 'ansi',
        lines: ['--size=20x5'],
      });
      expect(
        getTerminalImageRenderSupport(
          {
            PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
            TERM: 'xterm-256color',
            TERM_PROGRAM: 'WarpTerminal',
          },
          true,
        ),
      ).toEqual({ available: true });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not trust a project-local node_modules/.bin/chafa',
    async () => {
      const localBin = path.join(tempDir, 'node_modules', '.bin');
      await fs.mkdir(localBin, { recursive: true });
      const chafaPath = path.join(localBin, 'chafa');
      await fs.writeFile(
        chafaPath,
        '#!/usr/bin/env node\nprocess.stdout.write("HACKED\\n");\n',
      );
      await fs.chmod(chafaPath, 0o755);

      expect(
        getTerminalImageRenderSupport(
          {
            PATH: localBin,
            TERM: 'xterm-256color',
            TERM_PROGRAM: 'WarpTerminal',
          },
          true,
        ),
      ).toEqual({
        available: false,
        reason:
          'No compatible native image protocol was detected, and chafa is not installed.',
      });

      const result = renderTerminalImage({
        display: {
          type: 'terminal_image',
          filePath: imagePath,
          mimeType: 'image/png',
        },
        contentWidth: 20,
        env: {
          PATH: localBin,
          TERM: 'xterm-256color',
          TERM_PROGRAM: 'WarpTerminal',
        },
        stdoutIsTTY: true,
      });
      expect(result).toEqual({
        kind: 'unavailable',
        reason:
          'No compatible native image protocol was detected, and chafa is not installed.',
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'surfaces chafa stderr when rendering fails',
    async () => {
      const binDir = path.join(tempDir, 'bin');
      await fs.mkdir(binDir);
      const chafaPath = path.join(binDir, 'chafa');
      await fs.writeFile(
        chafaPath,
        '#!/usr/bin/env node\nprocess.stderr.write("libpng: invalid IHDR data\\n");\nprocess.exit(1);\n',
      );
      await fs.chmod(chafaPath, 0o755);

      const result = renderTerminalImage({
        display: {
          type: 'terminal_image',
          filePath: imagePath,
          mimeType: 'image/png',
        },
        contentWidth: 20,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
          TERM: 'xterm-256color',
          TERM_PROGRAM: 'WarpTerminal',
        },
        stdoutIsTTY: true,
      });

      expect(result.kind).toBe('unavailable');
      expect(result.kind === 'unavailable' && result.reason).toContain(
        'libpng: invalid IHDR data',
      );
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
    expect(getTerminalImageRenderSupport({ PATH: tempDir }, true)).toEqual({
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
