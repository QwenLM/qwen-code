/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import * as fs from 'node:fs/promises';
import {
  createWriteStream,
  existsSync,
  statSync,
  type Stats,
  type WriteStream,
} from 'node:fs';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import EventEmitter from 'node:events';
import { Stream } from 'node:stream';
import * as path from 'node:path';

// Mock dependencies BEFORE imports
vi.mock('node:fs/promises');
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    execSync: vi.fn(),
  };
});
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    spawnAsync: vi.fn(),
    runLogger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    Storage: class {
      getProjectTempDir = vi.fn(() => '/tmp/global');
      initialize = vi.fn(() => Promise.resolve(undefined));
    },
  };
});
vi.mock('./macosClipboardImage.js');

import { spawnAsync } from '@qwen-code/core';
import {
  hasNativeMacOSClipboardImage,
  readNativeMacOSClipboardImage,
} from './macosClipboardImage.js';
// Keep static imports for stateless functions
import {
  cleanupOldClipboardImages,
  splitDragAndDropPaths,
  mayContainPastedFilePaths,
  parsePastedPaths,
  extractPastedImagePaths,
} from './clipboardUtils.js';

const mockPlatform = (platform: string) => {
  vi.stubGlobal(
    'process',
    Object.create(process, {
      platform: {
        get: () => platform,
      },
    }),
  );
};

// Define the type for the module to use in tests
type ClipboardUtilsModule = typeof import('./clipboardUtils.js');

describe('clipboardUtils', () => {
  let originalEnv: NodeJS.ProcessEnv;
  // Dynamic module instance for stateful functions
  let clipboardUtils: ClipboardUtilsModule;

  const MOCK_FILE_STATS = {
    isFile: () => true,
    size: 100,
    mtimeMs: Date.now(),
  } as unknown as Stats;

  beforeEach(async () => {
    vi.resetAllMocks();
    originalEnv = process.env;
    process.env = { ...originalEnv };

    // Reset modules to clear internal state (linuxClipboardTool variable)
    vi.resetModules();
    // Dynamically import the module to get a fresh instance for each test
    clipboardUtils = await import('./clipboardUtils.js');
    vi.mocked(hasNativeMacOSClipboardImage).mockReturnValue(undefined);
    vi.mocked(readNativeMacOSClipboardImage).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('clipboardHasImage (Linux)', () => {
    it('should return true when wl-paste shows image type (Wayland)', async () => {
      mockPlatform('linux');
      process.env['XDG_SESSION_TYPE'] = 'wayland';
      vi.mocked(execSync).mockReturnValue(Buffer.from('')); // command -v succeeds
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'image/png\ntext/plain',
        stderr: '',
      });

      const result = await clipboardUtils.clipboardHasImage();

      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('wl-paste'),
        expect.anything(),
      );
      expect(spawnAsync).toHaveBeenCalledWith('wl-paste', ['--list-types']);
    });

    it('should return true when xclip shows image type (X11)', async () => {
      mockPlatform('linux');
      process.env['XDG_SESSION_TYPE'] = 'x11';
      vi.mocked(execSync).mockReturnValue(Buffer.from('')); // command -v succeeds
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'image/png\nTARGETS',
        stderr: '',
      });

      const result = await clipboardUtils.clipboardHasImage();

      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('xclip'),
        expect.anything(),
      );
      expect(spawnAsync).toHaveBeenCalledWith('xclip', [
        '-selection',
        'clipboard',
        '-t',
        'TARGETS',
        '-o',
      ]);
    });

    it('should return false if tool fails', async () => {
      mockPlatform('linux');
      process.env['XDG_SESSION_TYPE'] = 'wayland';
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(spawnAsync).mockRejectedValueOnce(new Error('wl-paste failed'));

      const result = await clipboardUtils.clipboardHasImage();

      expect(result).toBe(false);
    });

    it('should return false if no image type is found', async () => {
      mockPlatform('linux');
      process.env['XDG_SESSION_TYPE'] = 'wayland';
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'text/plain',
        stderr: '',
      });

      const result = await clipboardUtils.clipboardHasImage();

      expect(result).toBe(false);
    });

    it('should return false if tool not found', async () => {
      mockPlatform('linux');
      process.env['XDG_SESSION_TYPE'] = 'wayland';
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found');
      });

      const result = await clipboardUtils.clipboardHasImage();

      expect(result).toBe(false);
    });
  });

  describe('readClipboardText (Linux)', () => {
    beforeEach(() => {
      mockPlatform('linux');
    });

    it('should read text using wl-paste on Wayland', async () => {
      process.env['XDG_SESSION_TYPE'] = 'wayland';
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'pasted text',
        stderr: '',
      });

      const result = await clipboardUtils.readClipboardText();

      expect(result).toBe('pasted text');
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('wl-paste'),
        expect.anything(),
      );
      expect(spawnAsync).toHaveBeenCalledWith('wl-paste', ['--no-newline']);
    });

    it('should read text using xclip on X11', async () => {
      process.env['XDG_SESSION_TYPE'] = 'x11';
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'xclip text',
        stderr: '',
      });

      const result = await clipboardUtils.readClipboardText();

      expect(result).toBe('xclip text');
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('xclip'),
        expect.anything(),
      );
      expect(spawnAsync).toHaveBeenCalledWith('xclip', [
        '-selection',
        'clipboard',
        '-o',
      ]);
    });

    it('should fall back to xsel for text when xclip is missing', async () => {
      process.env['XDG_SESSION_TYPE'] = 'x11';
      vi.mocked(execSync).mockImplementation((command) => {
        if (String(command).includes('xsel')) {
          return Buffer.from('');
        }
        throw new Error('Command not found');
      });
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'xsel text',
        stderr: '',
      });

      const result = await clipboardUtils.readClipboardText();

      expect(result).toBe('xsel text');
      expect(spawnAsync).toHaveBeenCalledWith('xsel', [
        '--clipboard',
        '--output',
      ]);
    });

    it('should return null if no Linux text clipboard tool is found', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found');
      });

      const result = await clipboardUtils.readClipboardText();

      expect(result).toBe(null);
      expect(spawnAsync).not.toHaveBeenCalled();
    });

    it('should return null when the selected text clipboard tool fails', async () => {
      process.env['XDG_SESSION_TYPE'] = 'wayland';
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(spawnAsync).mockRejectedValueOnce(
        new Error('wl-paste failed'),
      );

      const result = await clipboardUtils.readClipboardText();

      expect(result).toBe(null);
    });
  });

  describe('readClipboardText (Windows)', () => {
    beforeEach(() => {
      mockPlatform('win32');
    });

    it('bounds the PowerShell fallback to two seconds', async () => {
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'pasted text',
        stderr: '',
      });

      const result = await clipboardUtils.readClipboardText();

      expect(result).toBe('pasted text');
      expect(spawnAsync).toHaveBeenCalledWith(
        'powershell',
        expect.arrayContaining([
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
        ]),
        { timeout: 2000 },
      );
    });

    it('returns null when the PowerShell fallback times out', async () => {
      vi.mocked(spawnAsync).mockRejectedValueOnce(new Error('timed out'));

      const result = await clipboardUtils.readClipboardText();

      expect(result).toBe(null);
    });
  });

  describe('saveClipboardImage (Linux)', () => {
    const mockTargetDir = '/tmp/target';
    const mockTempDir = path.join('/tmp/global', 'images');

    beforeEach(() => {
      mockPlatform('linux');
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
    });

    const createMockChildProcess = (
      shouldSucceed: boolean,
      exitCode: number = 0,
    ) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Stream & { pipe: Mock };
      };
      child.stdout = new Stream() as Stream & { pipe: Mock }; // Dummy stream
      child.stdout.pipe = vi.fn();

      // Simulate process execution
      setTimeout(() => {
        if (!shouldSucceed) {
          child.emit('error', new Error('Spawn failed'));
        } else {
          child.emit('close', exitCode);
        }
      }, 10);

      return child;
    };

    // Helper to prime the internal linuxClipboardTool state
    const primeClipboardTool = async (
      type: 'wayland' | 'x11',
      hasImage = true,
    ) => {
      process.env['XDG_SESSION_TYPE'] = type;
      vi.mocked(execSync).mockReturnValue(Buffer.from(''));
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: hasImage ? 'image/png' : 'text/plain',
        stderr: '',
      });
      await clipboardUtils.clipboardHasImage();
      vi.mocked(spawnAsync).mockClear();
      vi.mocked(execSync).mockClear();
    };

    it('should save image using wl-paste if detected', async () => {
      await primeClipboardTool('wayland');

      // Mock fs.stat to return size > 0
      vi.mocked(fs.stat).mockResolvedValue(MOCK_FILE_STATS);

      // Mock spawn to return a successful process for wl-paste
      const mockChild = createMockChildProcess(true, 0);
      vi.mocked(spawn).mockReturnValueOnce(
        mockChild as unknown as ChildProcess,
      );

      // Mock createWriteStream
      const mockStream = new EventEmitter() as EventEmitter & {
        writableFinished: boolean;
      };
      mockStream.writableFinished = false;
      vi.mocked(createWriteStream).mockReturnValue(
        mockStream as unknown as WriteStream,
      );

      // Use dynamic instance
      const promise = clipboardUtils.saveClipboardImage(mockTargetDir);

      // Simulate stream finishing successfully BEFORE process closes
      mockStream.writableFinished = true;
      mockStream.emit('finish');

      const result = await promise;

      expect(result).toContain(mockTempDir);
      expect(result).toMatch(/clipboard-\d+\.png$/);
      expect(spawn).toHaveBeenCalledWith('wl-paste', expect.any(Array));
      expect(fs.mkdir).toHaveBeenCalledWith(mockTempDir, { recursive: true });
    });

    it('should return null if wl-paste fails for all formats', async () => {
      await primeClipboardTool('wayland');

      // Mock fs.stat to return size > 0
      vi.mocked(fs.stat).mockResolvedValue(MOCK_FILE_STATS);

      // wl-paste fails (non-zero exit code) for all formats (png, bmp, jpeg)
      const child1 = createMockChildProcess(true, 1);
      const child2 = createMockChildProcess(true, 1);
      const child3 = createMockChildProcess(true, 1);
      vi.mocked(spawn)
        .mockReturnValueOnce(child1 as unknown as ChildProcess)
        .mockReturnValueOnce(child2 as unknown as ChildProcess)
        .mockReturnValueOnce(child3 as unknown as ChildProcess);

      const mockStream1 = new EventEmitter() as EventEmitter & {
        writableFinished: boolean;
      };
      const mockStream2 = new EventEmitter() as EventEmitter & {
        writableFinished: boolean;
      };
      const mockStream3 = new EventEmitter() as EventEmitter & {
        writableFinished: boolean;
      };
      vi.mocked(createWriteStream)
        .mockReturnValueOnce(mockStream1 as unknown as WriteStream)
        .mockReturnValueOnce(mockStream2 as unknown as WriteStream)
        .mockReturnValueOnce(mockStream3 as unknown as WriteStream);

      const promise = clipboardUtils.saveClipboardImage(mockTargetDir);

      mockStream1.writableFinished = true;
      mockStream1.emit('finish');
      mockStream2.writableFinished = true;
      mockStream2.emit('finish');
      mockStream3.writableFinished = true;
      mockStream3.emit('finish');

      const result = await promise;

      expect(result).toBe(null);
      // Should try all 3 formats (png, bmp, jpeg) before giving up
      expect(spawn).toHaveBeenCalledTimes(3);
    });

    it('should save image using xclip if detected', async () => {
      await primeClipboardTool('x11');

      // Mock fs.stat to return size > 0
      vi.mocked(fs.stat).mockResolvedValue(MOCK_FILE_STATS);

      // Mock spawn to return a successful process for xclip
      const mockChild = createMockChildProcess(true, 0);
      vi.mocked(spawn).mockReturnValueOnce(
        mockChild as unknown as ChildProcess,
      );

      // Mock createWriteStream
      const mockStream = new EventEmitter() as EventEmitter & {
        writableFinished: boolean;
      };
      mockStream.writableFinished = false;
      vi.mocked(createWriteStream).mockReturnValue(
        mockStream as unknown as WriteStream,
      );

      const promise = clipboardUtils.saveClipboardImage(mockTargetDir);

      mockStream.writableFinished = true;
      mockStream.emit('finish');

      const result = await promise;

      expect(result).toMatch(/clipboard-\d+\.png$/);
      expect(spawn).toHaveBeenCalledWith('xclip', expect.any(Array));
    });

    it('should return null if no clipboard tool is found', async () => {
      // Unset session type to ensure no tool is detected by XDG_SESSION_TYPE
      delete process.env['XDG_SESSION_TYPE'];
      // Make both tool detection attempts fail (xclip and wl-paste)
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found');
      });

      const result = await clipboardUtils.saveClipboardImage(mockTargetDir);
      expect(result).toBe(null);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('macOS native clipboard image path', () => {
    const mockTargetDir = '/tmp/target';

    beforeEach(() => {
      mockPlatform('darwin');
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(fs.stat).mockResolvedValue(MOCK_FILE_STATS);
    });

    it('checks for images without spawning osascript', async () => {
      vi.mocked(hasNativeMacOSClipboardImage).mockReturnValue(true);

      await expect(clipboardUtils.clipboardHasImage()).resolves.toBe(true);

      expect(spawnAsync).not.toHaveBeenCalled();
    });

    it('falls back to osascript when the native check is unavailable', async () => {
      vi.mocked(hasNativeMacOSClipboardImage).mockReturnValue(undefined);
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: '«class PNGf»',
        stderr: '',
      });

      await expect(clipboardUtils.clipboardHasImage()).resolves.toBe(true);

      expect(spawnAsync).toHaveBeenCalledWith('osascript', [
        '-e',
        'clipboard info',
      ]);
    });

    it('uses native PNG bytes before the AppleScript save fallback', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      vi.mocked(readNativeMacOSClipboardImage).mockResolvedValue(png);

      const result = await clipboardUtils.saveClipboardImage(mockTargetDir);

      expect(result).toMatch(/clipboard-\d+\.png$/);
      expect(fs.writeFile).toHaveBeenCalledWith(result, png);
      expect(spawnAsync).not.toHaveBeenCalled();
    });

    it('does not invoke AppleScript when native pasteboard has no image', async () => {
      vi.mocked(readNativeMacOSClipboardImage).mockResolvedValue(null);

      await expect(
        clipboardUtils.saveClipboardImage(mockTargetDir),
      ).resolves.toBeNull();

      expect(spawnAsync).not.toHaveBeenCalled();
    });

    it('retains AppleScript as a save fallback', async () => {
      vi.mocked(readNativeMacOSClipboardImage).mockResolvedValue(undefined);
      vi.mocked(spawnAsync).mockResolvedValueOnce({
        stdout: 'success',
        stderr: '',
      });

      const result = await clipboardUtils.saveClipboardImage(mockTargetDir);

      expect(result).toMatch(/clipboard-\d+\.png$/);
      expect(spawnAsync).toHaveBeenCalledWith('osascript', [
        '-e',
        expect.stringContaining('the clipboard as «class PNGf»'),
      ]);
    });
  });

  // Stateless functions continue to use static imports
  describe('cleanupOldClipboardImages', () => {
    const mockTargetDir = '/tmp/target';
    it('should not throw errors', async () => {
      // Should handle missing directories gracefully
      await expect(
        cleanupOldClipboardImages(mockTargetDir),
      ).resolves.not.toThrow();
    });

    it('should complete without errors on valid directory', async () => {
      await expect(
        cleanupOldClipboardImages(mockTargetDir),
      ).resolves.not.toThrow();
    });
  });

  describe('splitDragAndDropPaths', () => {
    describe('in posix', () => {
      beforeEach(() => mockPlatform('linux'));

      it.each([
        ['empty string', '', []],
        ['single path no spaces', '/path/to/image.png', ['/path/to/image.png']],
        [
          'simple space-separated paths',
          '/img1.png /img2.png',
          ['/img1.png', '/img2.png'],
        ],
        [
          'three paths',
          '/a.png /b.jpg /c.heic',
          ['/a.png', '/b.jpg', '/c.heic'],
        ],
        ['escaped spaces', '/my\\ image.png', ['/my image.png']],
        [
          'multiple paths with escaped spaces',
          '/my\\ img1.png /my\\ img2.png',
          ['/my img1.png', '/my img2.png'],
        ],
        [
          'multiple escaped spaces',
          '/path/to/my\\ cool\\ image.png',
          ['/path/to/my cool image.png'],
        ],
        [
          'consecutive spaces',
          '/img1.png   /img2.png',
          ['/img1.png', '/img2.png'],
        ],
        [
          'trailing/leading whitespace',
          '  /img1.png /img2.png  ',
          ['/img1.png', '/img2.png'],
        ],
        ['whitespace only', '   ', []],
        ['quoted path with spaces', '"/my image.png"', ['/my image.png']],
        [
          'mixed quoted and unquoted',
          '"/my img1.png" /my\\ img2.png',
          ['/my img1.png', '/my img2.png'],
        ],
        [
          'quoted with escaped quotes',
          "'/derp/my '\\''cool'\\'' image.png'",
          ["/derp/my 'cool' image.png"],
        ],
      ])('should escape %s', (_, input, expected) => {
        expect([...splitDragAndDropPaths(input)]).toEqual(expected);
      });
    });

    describe('in windows', () => {
      beforeEach(() => mockPlatform('win32'));

      it.each([
        ['double quoted path', '"C:\\my image.png"', ['C:\\my image.png']],
        [
          'multiple double quoted paths',
          '"C:\\img 1.png" "D:\\img 2.png"',
          ['C:\\img 1.png', 'D:\\img 2.png'],
        ],
        ['unquoted path', 'C:\\img.png', ['C:\\img.png']],
        [
          'mixed quoted and unquoted',
          '"C:\\img 1.png" D:\\img2.png',
          ['C:\\img 1.png', 'D:\\img2.png'],
        ],
        ['single quoted path', "'C:\\my image.png'", ['C:\\my image.png']],
        [
          'mixed single and double quoted',
          '"C:\\img 1.png" \'D:\\img 2.png\'',
          ['C:\\img 1.png', 'D:\\img 2.png'],
        ],
      ])('should split %s', (_, input, expected) => {
        expect([...splitDragAndDropPaths(input)]).toEqual(expected);
      });
    });
  });
  describe('parsePastedPaths', () => {
    /** Marks the given paths as existing files; everything else fails to stat. */
    const mockExistingFiles = (paths: Iterable<string>) => {
      const existing = new Set(paths);
      vi.mocked(fs.stat).mockImplementation(async (p) => {
        if (existing.has(p as string)) return MOCK_FILE_STATS;
        throw new Error(`ENOENT: ${String(p)}`);
      });
    };

    it('should return null for empty string', async () => {
      const result = await parsePastedPaths('');
      expect(result).toBe(null);
    });

    it('should add @ prefix to single valid path', async () => {
      mockExistingFiles(['/path/to/file.txt']);
      const result = await parsePastedPaths('/path/to/file.txt');
      expect(result).toBe('@/path/to/file.txt ');
    });

    it('should return null for single invalid path', async () => {
      mockExistingFiles([]);
      const result = await parsePastedPaths('/path/to/file.txt');
      expect(result).toBe(null);
    });

    it('should add @ prefix to all valid paths', async () => {
      mockExistingFiles(['/path/to/file1.txt', '/path/to/file2.txt']);

      const result = await parsePastedPaths(
        '/path/to/file1.txt /path/to/file2.txt',
      );
      expect(result).toBe('@/path/to/file1.txt @/path/to/file2.txt ');
    });

    it('should return null if any path is invalid', async () => {
      vi.mocked(fs.stat).mockImplementation(async (p) => {
        if ((p as string).endsWith('.txt')) return MOCK_FILE_STATS;
        throw new Error(`ENOENT: ${String(p)}`);
      });

      const result = await parsePastedPaths('/valid/file.txt /invalid/file.jpg');
      expect(result).toBe(null);
    });

    it('should return null if no paths are valid', async () => {
      mockExistingFiles([]);
      const result = await parsePastedPaths(
        '/path/to/file1.txt /path/to/file2.txt',
      );
      expect(result).toBe(null);
    });

    it('should never call the synchronous filesystem API', async () => {
      mockExistingFiles(['/path/to/file.txt']);
      await parsePastedPaths('/path/to/file.txt');
      // A dropped path can live on an unresponsive network mount, where a
      // synchronous stat freezes the whole TUI.
      expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
      expect(vi.mocked(statSync)).not.toHaveBeenCalled();
    });

    it('should treat an unresponsive path as invalid instead of hanging', async () => {
      vi.useFakeTimers();
      try {
        // Simulates a stale SMB handle: the stat never settles.
        vi.mocked(fs.stat).mockImplementation(() => new Promise(() => {}));
        const pending = parsePastedPaths('/mnt/z/hung.txt');
        await vi.advanceTimersByTimeAsync(5000);
        await expect(pending).resolves.toBe(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should keep the event loop running while a slow path is probed', async () => {
      // A slow mount does answer eventually; the point is that nothing else
      // stalls while it does. A synchronous stat here froze the whole TUI.
      vi.mocked(fs.stat).mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(MOCK_FILE_STATS), 60);
          }),
      );

      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
      }, 5);
      try {
        await parsePastedPaths('/mnt/z/slow.txt');
      } finally {
        clearInterval(ticker);
      }

      expect(ticks).toBeGreaterThan(0);
    });

    describe('in posix', () => {
      beforeEach(() => {
        mockPlatform('linux');
      });

      it('should handle paths with escaped spaces', async () => {
        mockExistingFiles(['/path/to/my file.txt', '/other/path.txt']);

        const result = await parsePastedPaths(
          '/path/to/my\\ file.txt /other/path.txt',
        );
        expect(result).toBe('@/path/to/my\\ file.txt @/other/path.txt ');
      });

      it('should unescape paths before validation', async () => {
        const validPaths = new Set(['/my file.txt', '/other.txt']);
        const validatedPaths: string[] = [];
        vi.mocked(fs.stat).mockImplementation(async (p) => {
          validatedPaths.push(p as string);
          if (validPaths.has(p as string)) return MOCK_FILE_STATS;
          throw new Error(`ENOENT: ${String(p)}`);
        });

        await parsePastedPaths('/my\\ file.txt /other.txt');
        // First checks entire string, then individual unescaped segments
        expect(validatedPaths).toEqual([
          '/my\\ file.txt /other.txt',
          '/my file.txt',
          '/other.txt',
        ]);
      });

      it('should handle single path with unescaped spaces from copy-paste', async () => {
        mockExistingFiles(['/path/to/my file.txt']);

        const result = await parsePastedPaths('/path/to/my file.txt');
        expect(result).toBe('@/path/to/my\\ file.txt ');
      });

      it('should handle single-quoted with escaped quote', async () => {
        const validPaths = new Set([
          "/usr/test/my file with 'single quotes'.txt",
        ]);
        const validatedPaths: string[] = [];
        vi.mocked(fs.stat).mockImplementation(async (p) => {
          validatedPaths.push(p as string);
          if (validPaths.has(p as string)) return MOCK_FILE_STATS;
          throw new Error(`ENOENT: ${String(p)}`);
        });

        const result = await parsePastedPaths(
          "'/usr/test/my file with '\\''single quotes'\\''.txt'",
        );
        expect(result).toBe(
          "@/usr/test/my\\ file\\ with\\ \\'single\\ quotes\\'.txt ",
        );

        expect(validatedPaths).toEqual([
          "/usr/test/my file with 'single quotes'.txt",
        ]);
      });
    });

    describe('in windows', () => {
      beforeEach(() => mockPlatform('win32'));

      it('should handle Windows path', async () => {
        mockExistingFiles(['C:\\Users\\file.txt']);

        const result = await parsePastedPaths('C:\\Users\\file.txt');
        expect(result).toBe('@C:\\Users\\file.txt ');
      });

      it('should handle Windows path with unescaped spaces', async () => {
        mockExistingFiles(['C:\\My Documents\\file.txt']);

        const result = await parsePastedPaths('C:\\My Documents\\file.txt');
        expect(result).toBe('@"C:\\My Documents\\file.txt" ');
      });
      it('should handle multiple Windows paths', async () => {
        mockExistingFiles(['C:\\file1.txt', 'D:\\file2.txt']);

        const result = await parsePastedPaths('C:\\file1.txt D:\\file2.txt');
        expect(result).toBe('@C:\\file1.txt @D:\\file2.txt ');
      });

      it('should handle Windows UNC path', async () => {
        mockExistingFiles(['\\\\server\\share\\file.txt']);

        const result = await parsePastedPaths('\\\\server\\share\\file.txt');
        expect(result).toBe('@\\\\server\\share\\file.txt ');
      });
    });
  });

  describe('mayContainPastedFilePaths', () => {
    it.each([
      ['empty text', '', false],
      ['plain prose', 'hello world', false],
      ['a posix path', '/pics/shot.png', true],
      ['a home-relative path', '~/pics/shot.png', true],
      ['a Windows drive path', 'C:\\Pics\\shot.png', true],
      ['a mapped network drive', 'Z:\\ComfyUI\\output\\edit\\a.png', true],
      ['a UNC path', '\\\\server\\share\\a.png', true],
      ['a path among other segments', 'note /pics/shot.png', true],
    ])('should return %s -> %s', (_desc, input, expected) => {
      expect(mayContainPastedFilePaths(input)).toBe(expected);
    });

    it('should not touch the filesystem', () => {
      mayContainPastedFilePaths('Z:\\ComfyUI\\output\\edit\\a.png');
      expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
      expect(vi.mocked(statSync)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.stat)).not.toHaveBeenCalled();
    });
  });

  describe('extractPastedImagePaths', () => {
    it('should return null for empty text', () => {
      expect(extractPastedImagePaths('')).toBe(null);
    });

    it('should return null for non-path text', () => {
      expect(extractPastedImagePaths('hello world')).toBe(null);
    });

    it('should extract a single image path', () => {
      const result = extractPastedImagePaths('/pics/shot.png');
      expect(result).toEqual({
        imagePaths: ['/pics/shot.png'],
        otherPaths: [],
      });
    });

    it('should preserve an unescaped space in a single image path', () => {
      expect(extractPastedImagePaths('/pics/my screenshot.png')).toEqual({
        imagePaths: ['/pics/my screenshot.png'],
        otherPaths: [],
      });
    });

    it('should return null when the only path is not an image', () => {
      expect(extractPastedImagePaths('/docs/readme.txt')).toBe(null);
    });

    it('should split mixed image and non-image paths', () => {
      const result = extractPastedImagePaths('/pics/a.png /docs/readme.txt');
      expect(result).toEqual({
        imagePaths: ['/pics/a.png'],
        otherPaths: ['/docs/readme.txt'],
      });
    });

    it('should defer existence checks to the image pipeline', () => {
      expect(extractPastedImagePaths('/pics/a.png /missing/b.jpg')).toEqual({
        imagePaths: ['/pics/a.png', '/missing/b.jpg'],
        otherPaths: [],
      });
    });

    it('should handle multiple image paths', () => {
      const result = extractPastedImagePaths('/pics/a.png /pics/b.jpg');
      expect(result).toEqual({
        imagePaths: ['/pics/a.png', '/pics/b.jpg'],
        otherPaths: [],
      });
    });

    it('should handle Windows image path', () => {
      const result = extractPastedImagePaths('C:\\Pics\\shot.png');
      expect(result).toEqual({
        imagePaths: ['C:\\Pics\\shot.png'],
        otherPaths: [],
      });
    });

    it('should not touch any filesystem API', () => {
      vi.mocked(fs.stat).mockImplementation(() => new Promise(() => {}));
      expect(
        extractPastedImagePaths(
          'Z:\\ComfyUI\\output\\edit\\image_00005_.png',
        ),
      ).toEqual({
        imagePaths: ['Z:\\ComfyUI\\output\\edit\\image_00005_.png'],
        otherPaths: [],
      });
      expect(vi.mocked(existsSync)).not.toHaveBeenCalled();
      expect(vi.mocked(statSync)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.stat)).not.toHaveBeenCalled();
    });
  });
});
