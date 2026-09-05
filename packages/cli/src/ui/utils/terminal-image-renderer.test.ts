/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  containsCmdShellMetacharacters,
  getTerminalImageRenderSupport,
  INLINE_DECODE_NEGATIVE_CACHE_BYTE_LIMIT,
  INLINE_DECODE_NEGATIVE_CACHE_LIMIT,
  MAX_INLINE_IMAGE_PIXELS,
  markKittyImageWritten,
  prepareInlineTerminalImage,
  renderTerminalImage,
  supportsKittyImageProtocol,
  TRANSMITTED_KEY_LIMIT,
  wasKittyImageWritten,
} from './terminal-image-renderer.js';
import { MAX_INLINE_IMAGE_ENCODED_LENGTH } from './inline-image-parts.js';

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

  it('renders a Kitty virtual image with placeholder rows', () => {
    const result = renderTerminalImage({
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

  it('renders bounded inline PNG data through the Kitty path', () => {
    const prepared = prepareInlineTerminalImage({
      data: PNG_1X1.toString('base64'),
      mimeType: 'image/png',
      contentWidth: 24,
      availableTerminalHeight: 12,
      env: { TERM: 'xterm-kitty' },
      stdoutIsTTY: true,
    });

    expect(prepared.fallbackText).toBe('[image: 1x1 png]');
    expect(prepared.result?.kind).toBe('kitty');
    if (prepared.result?.kind !== 'kitty') return;
    expect(prepared.result.sequence).toContain('\u001b_Ga=T,f=100');
    expect(prepared.result.placeholder.lines).toHaveLength(1);
  });

  it('validates inline PNG payloads before rendering', () => {
    for (const testCase of [
      { data: 'AB==', mimeType: 'image/png', fallback: '[image: png]' },
      {
        data: Buffer.from('not a png').toString('base64'),
        mimeType: 'image/png',
        fallback: '[image: png]',
      },
      {
        data: PNG_1X1.toString('base64'),
        mimeType: 'image/jpeg',
        fallback: '[image: jpeg]',
      },
    ]) {
      expect(
        prepareInlineTerminalImage({
          data: testCase.data,
          mimeType: testCase.mimeType,
          contentWidth: 24,
          env: { TERM: 'xterm-kitty' },
          stdoutIsTTY: true,
        }),
      ).toEqual({ fallbackText: testCase.fallback, result: null });
    }
  });

  it('caches invalid inline payloads with bounded LRU eviction', () => {
    const sharedPrefix = 'A'.repeat(64);
    const invalidPayloads = Array.from(
      { length: INLINE_DECODE_NEGATIVE_CACHE_LIMIT + 1 },
      (_, index) => Buffer.from(`${sharedPrefix}${index}`).toString('base64'),
    );
    const bufferFrom = vi.spyOn(Buffer, 'from');
    const createHash = vi.spyOn(crypto, 'createHash');
    const prepare = (data: string) =>
      prepareInlineTerminalImage({
        data,
        mimeType: 'image/png',
        contentWidth: 24,
        env: { TERM: 'xterm-kitty' },
        stdoutIsTTY: true,
      });

    try {
      for (const data of invalidPayloads.slice(
        0,
        INLINE_DECODE_NEGATIVE_CACHE_LIMIT,
      )) {
        prepare(data);
      }
      expect(bufferFrom).toHaveBeenCalledTimes(
        INLINE_DECODE_NEGATIVE_CACHE_LIMIT,
      );

      prepare('A'.repeat(MAX_INLINE_IMAGE_ENCODED_LENGTH + 1));
      expect(bufferFrom).toHaveBeenCalledTimes(
        INLINE_DECODE_NEGATIVE_CACHE_LIMIT,
      );

      prepare(invalidPayloads[0]);
      expect(bufferFrom).toHaveBeenCalledTimes(
        INLINE_DECODE_NEGATIVE_CACHE_LIMIT,
      );

      prepare(invalidPayloads[INLINE_DECODE_NEGATIVE_CACHE_LIMIT]);
      expect(bufferFrom).toHaveBeenCalledTimes(
        INLINE_DECODE_NEGATIVE_CACHE_LIMIT + 1,
      );

      prepare(invalidPayloads[0]);
      expect(bufferFrom).toHaveBeenCalledTimes(
        INLINE_DECODE_NEGATIVE_CACHE_LIMIT + 1,
      );

      prepare(invalidPayloads[1]);
      expect(bufferFrom).toHaveBeenCalledTimes(
        INLINE_DECODE_NEGATIVE_CACHE_LIMIT + 2,
      );
      expect(createHash).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
      createHash.mockRestore();
    }
  });

  it('bounds invalid inline payload cache entries by total bytes', () => {
    const invalidPayloads = Array.from({ length: 3 }, (_, index) =>
      Buffer.from(`invalid byte budget payload ${index}`).toString('base64'),
    );
    const bufferFrom = vi.spyOn(Buffer, 'from');
    const byteLength = vi
      .spyOn(Buffer, 'byteLength')
      .mockReturnValue(INLINE_DECODE_NEGATIVE_CACHE_BYTE_LIMIT / 2);
    const prepare = (data: string) =>
      prepareInlineTerminalImage({
        data,
        mimeType: 'image/png',
        contentWidth: 24,
        env: { TERM: 'xterm-kitty' },
        stdoutIsTTY: true,
      });

    try {
      prepare(invalidPayloads[0]);
      prepare(invalidPayloads[1]);
      prepare(invalidPayloads[0]);
      prepare(invalidPayloads[2]);
      prepare(invalidPayloads[0]);
      expect(bufferFrom).toHaveBeenCalledTimes(3);

      prepare(invalidPayloads[1]);
      expect(bufferFrom).toHaveBeenCalledTimes(4);
      expect(byteLength).toHaveBeenCalledTimes(4);
    } finally {
      bufferFrom.mockRestore();
      byteLength.mockRestore();
    }
  });

  it('rejects inline payloads above the shared image limit before decoding', () => {
    const oversizedBase64 = 'A'.repeat(MAX_INLINE_IMAGE_ENCODED_LENGTH + 1);
    const bufferFrom = vi.spyOn(Buffer, 'from');
    const createHash = vi.spyOn(crypto, 'createHash');

    try {
      expect(
        prepareInlineTerminalImage({
          data: oversizedBase64,
          mimeType: 'image/png',
          contentWidth: 24,
          env: { TERM: 'xterm-kitty' },
          stdoutIsTTY: true,
        }),
      ).toEqual({ fallbackText: '[image: png]', result: null });
      expect(bufferFrom).not.toHaveBeenCalled();
      expect(createHash).not.toHaveBeenCalled();
    } finally {
      bufferFrom.mockRestore();
      createHash.mockRestore();
    }
  });

  it('rejects inline PNG dimensions above the shared image limit', () => {
    expect(
      prepareInlineTerminalImage({
        data: pngWithSize(1_000_001, 1).toString('base64'),
        mimeType: 'image/png',
        contentWidth: 24,
        env: { TERM: 'xterm-kitty' },
        stdoutIsTTY: true,
      }),
    ).toEqual({ fallbackText: '[image: png]', result: null });
  });

  it('rejects inline PNGs above the total pixel limit', () => {
    const width = 8_001;
    const height = Math.floor(MAX_INLINE_IMAGE_PIXELS / width) + 1;
    expect(
      prepareInlineTerminalImage({
        data: pngWithSize(width, height).toString('base64'),
        mimeType: 'image/png',
        contentWidth: 24,
        env: { TERM: 'xterm-kitty' },
        stdoutIsTTY: true,
      }),
    ).toEqual({ fallbackText: '[image: png]', result: null });
  });

  it('does not render inline image data when output is disabled', () => {
    expect(
      prepareInlineTerminalImage({
        data: PNG_1X1.toString('base64'),
        mimeType: 'image/png',
        contentWidth: 24,
        env: { TERM: 'xterm-kitty' },
        stdoutIsTTY: true,
        disabled: true,
      }),
    ).toEqual({ fallbackText: '[image: 1x1 png]', result: null });
  });

  it('exposes a stable render key on Kitty results so remounts can skip re-transmission', async () => {
    await fs.writeFile(imagePath, pngWithSize(1600, 800));
    const options = {
      display: {
        type: 'terminal_image' as const,
        filePath: imagePath,
        mimeType: 'image/png' as const,
      },
      contentWidth: 200,
      availableTerminalHeight: 100,
      env: { TERM: 'xterm-kitty' },
      stdoutIsTTY: true,
    };

    const first = renderTerminalImage(options);
    const second = renderTerminalImage(options);
    expect(first.kind).toBe('kitty');
    expect(second.kind).toBe('kitty');
    if (first.kind !== 'kitty' || second.kind !== 'kitty') return;
    expect(first.key).toBeTruthy();
    expect(second.key).toBe(first.key);

    // A different placement shape is a different image on the terminal grid and
    // therefore gets its own transmission key.
    const resized = renderTerminalImage({ ...options, contentWidth: 30 });
    expect(resized.kind).toBe('kitty');
    if (resized.kind === 'kitty') {
      expect(resized.key).not.toBe(first.key);
    }
  });

  it('tracks transmitted Kitty images for the session and bounds the set', () => {
    const unique = `transmit-${Date.now()}-`;
    expect(wasKittyImageWritten(`${unique}0`)).toBe(false);
    markKittyImageWritten(`${unique}0`);
    expect(wasKittyImageWritten(`${unique}0`)).toBe(true);

    // Exceeding the limit evicts the oldest key, so the set stays bounded.
    for (let i = 1; i <= TRANSMITTED_KEY_LIMIT; i++) {
      markKittyImageWritten(`${unique}${i}`);
    }
    expect(wasKittyImageWritten(`${unique}0`)).toBe(false);
    expect(wasKittyImageWritten(`${unique}${TRANSMITTED_KEY_LIMIT}`)).toBe(
      true,
    );
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

  it('detects Kitty and Ghostty native placement', () => {
    expect(
      supportsKittyImageProtocol(
        { KITTY_WINDOW_ID: '1', TERM: 'xterm-256color' },
        true,
      ),
    ).toBe(true);
    expect(supportsKittyImageProtocol({ TERM_PROGRAM: 'ghostty' }, true)).toBe(
      true,
    );
    expect(
      supportsKittyImageProtocol(
        { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux' },
        true,
      ),
    ).toBe(false);
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
        '#!/usr/bin/env node\nprocess.stdout.write(process.env.TEST_RENDERER_SECRET ? "LEAKED\\n" : `${process.argv.find((arg) => arg.startsWith("--colors="))} ${process.argv.find((arg) => arg.startsWith("--size="))}\\n`);\n',
      );
      await fs.chmod(chafaPath, 0o755);
      await fs.writeFile(imagePath, pngWithSize(1600, 800));

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
          TEST_RENDERER_SECRET: 'must-not-reach-chafa',
        },
        stdoutIsTTY: true,
      });

      expect(result).toEqual({
        kind: 'ansi',
        lines: ['--colors=256 --size=20x5'],
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
    'passes inline PNG bytes to chafa over stdin',
    async () => {
      const binDir = path.join(tempDir, 'inline-bin');
      await fs.mkdir(binDir);
      const chafaPath = path.join(binDir, 'chafa');
      await fs.writeFile(
        chafaPath,
        '#!/usr/bin/env node\nconst chunks=[];process.stdin.on("data",(chunk)=>chunks.push(chunk));process.stdin.on("end",()=>{const data=Buffer.concat(chunks);process.stdout.write(`${process.argv.at(-1)}:${data.subarray(0,8).toString("hex")}:${process.env.TEST_RENDERER_SECRET ? "LEAKED" : "safe"}\\n`);});\n',
      );
      await fs.chmod(chafaPath, 0o755);

      const prepared = prepareInlineTerminalImage({
        data: PNG_1X1.toString('base64'),
        mimeType: 'image/png',
        contentWidth: 20,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
          TERM_PROGRAM: 'WarpTerminal',
          TEST_RENDERER_SECRET: 'must-not-reach-chafa',
        },
        stdoutIsTTY: true,
      });

      expect(prepared.result).toEqual({
        kind: 'ansi',
        lines: ['-:89504e470d0a1a0a:safe'],
      });
      expect(prepared.fallbackText).toBe('[image: 1x1 png]');
    },
  );

  it('rejects cmd.exe metacharacters before invoking a shell shim', async () => {
    const dangerousImagePath = path.join(tempDir, 'chart & whoami.png');
    await fs.writeFile(dangerousImagePath, PNG_1X1);
    const chafaPath = path.join(tempDir, 'chafa.CMD');
    await fs.writeFile(chafaPath, '@echo off\r\n');
    await fs.chmod(chafaPath, 0o755);

    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      ...platformDescriptor,
      value: 'win32',
    });
    try {
      const result = renderTerminalImage({
        display: {
          type: 'terminal_image',
          filePath: dangerousImagePath,
          mimeType: 'image/png',
        },
        contentWidth: 20,
        env: {
          PATH: tempDir,
          PATHEXT: '.CMD',
          TERM_PROGRAM: 'WarpTerminal',
        },
        stdoutIsTTY: true,
      });

      expect(result).toEqual({
        kind: 'unavailable',
        reason:
          'Image path contains characters that cannot be safely passed to the renderer on this platform.',
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });

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

  it.runIf(process.platform !== 'win32')(
    'bounds a verbose chafa failure to a capped first line',
    async () => {
      const binDir = path.join(tempDir, 'bin');
      await fs.mkdir(binDir);
      const chafaPath = path.join(binDir, 'chafa');
      await fs.writeFile(
        chafaPath,
        '#!/usr/bin/env node\nprocess.stderr.write("E".repeat(300) + "\\nsecond line\\n");\nprocess.exit(1);\n',
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
      if (result.kind !== 'unavailable') return;
      expect(result.reason).toBe(`${'E'.repeat(200)}…`);
      expect(result.reason).not.toContain('\n');
      expect(result.reason).not.toContain('second line');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'caches a render so resize and restore do not re-spawn chafa',
    async () => {
      const binDir = path.join(tempDir, 'bin');
      await fs.mkdir(binDir);
      const chafaPath = path.join(binDir, 'chafa');
      await fs.writeFile(
        chafaPath,
        '#!/usr/bin/env node\nconst fs = require("fs");\nconst path = require("path");\nfs.appendFileSync(path.join(__dirname, "count.txt"), "x\\n");\nprocess.stdout.write(`${process.argv.find((arg) => arg.startsWith("--size="))}\\n`);\n',
      );
      await fs.chmod(chafaPath, 0o755);
      await fs.writeFile(imagePath, pngWithSize(1600, 800));

      const options = {
        display: {
          type: 'terminal_image' as const,
          filePath: imagePath,
          mimeType: 'image/png' as const,
        },
        contentWidth: 20,
        env: {
          PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
          TERM: 'xterm-256color',
          TERM_PROGRAM: 'WarpTerminal',
        },
        stdoutIsTTY: true,
      };
      const spawnCount = async () => {
        try {
          const raw = await fs.readFile(path.join(binDir, 'count.txt'), 'utf8');
          return raw.split('x').length - 1;
        } catch {
          return 0;
        }
      };

      const first = renderTerminalImage(options);
      expect(first.kind).toBe('ansi');
      const second = renderTerminalImage(options);
      expect(second).toEqual(first);
      expect(await spawnCount()).toBe(1);

      // A different shape misses the cache and re-spawns the renderer.
      await fs.writeFile(imagePath, pngWithSize(800, 1600));
      const third = renderTerminalImage(options);
      expect(third.kind).toBe('ansi');
      expect(await spawnCount()).toBe(2);

      // The same shape with a newer mtime invalidates the cached entry.
      const future = new Date(Date.now() + 10_000);
      await fs.utimes(imagePath, future, future);
      const fourth = renderTerminalImage(options);
      expect(fourth.kind).toBe('ansi');
      expect(await spawnCount()).toBe(3);
    },
  );

  it('returns a readable fallback when chafa is unavailable', () => {
    const result = renderTerminalImage({
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
    const missing = renderTerminalImage({
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
    const invalid = renderTerminalImage({
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
    const oversized = renderTerminalImage({
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

describe('containsCmdShellMetacharacters', () => {
  it('flags cmd.exe metacharacters in a model-supplied path', () => {
    for (const dangerous of [
      'chart & whoami.png',
      'a|b.png',
      'a<b.png',
      'a>b.png',
      'a^b.png',
      'a%PATH%.png',
      'a"b.png',
      'a!b.png',
      'a(b).png',
      'a\nb.png',
      'a\rb.png',
    ]) {
      expect(containsCmdShellMetacharacters(dangerous)).toBe(true);
    }
  });

  it('accepts ordinary image paths', () => {
    for (const safe of [
      '/workspace/chart.png',
      '/workspace/reports/q3-summary.png',
      '/workspace/img_2026-08-01.png',
      '/workspace/my image.png',
      'C:\\Users\\me\\Pictures\\vacation.png',
    ]) {
      expect(containsCmdShellMetacharacters(safe)).toBe(false);
    }
  });
});
