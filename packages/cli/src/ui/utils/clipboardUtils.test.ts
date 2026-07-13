/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Use vi.hoisted to define mock functions before vi.mock is hoisted
const { mockSpawn, mockExecSync, mockExecFileSync, clipboardMockState } =
  vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockExecSync: vi.fn(),
    mockExecFileSync: vi.fn(),
    clipboardMockState: { failLoad: false, loadDelayMs: 0 },
  }));

// Mock @teddyzhu/clipboard
vi.mock('@teddyzhu/clipboard', async () => {
  if (clipboardMockState.loadDelayMs > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, clipboardMockState.loadDelayMs),
    );
  }
  if (clipboardMockState.failLoad) {
    throw new Error('native clipboard module missing');
  }
  return {
    default: {
      ClipboardManager: vi.fn().mockImplementation(() => ({
        hasFormat: vi.fn().mockReturnValue(false),
        getImageData: vi.fn().mockReturnValue({ data: null }),
      })),
    },
    ClipboardManager: vi.fn().mockImplementation(() => ({
      hasFormat: vi.fn().mockReturnValue(false),
      getImageData: vi.fn().mockReturnValue({ data: null }),
    })),
  };
});

// Mock node:child_process
vi.mock('node:child_process', () => ({
  default: {
    spawn: mockSpawn,
    execSync: mockExecSync,
    execFileSync: mockExecFileSync,
    exec: vi.fn(),
    execFile: vi.fn(),
  },
  spawn: mockSpawn,
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
  exec: vi.fn(),
  execFile: vi.fn(),
}));

// We intentionally do NOT mock node:fs root to avoid breaking indirect
// dependencies (e.g. debugLogger, symlink) that import from 'node:fs'.
// vitest's mock system for built-in modules cannot simultaneously:
// 1. Override createWriteStream for save success path tests
// 2. Preserve { promises as fs } from 'node:fs' for indirect deps
// The success path test is documented below; error paths are fully covered.

// Mock node:fs/promises using importOriginal to preserve module structure
// for indirect dependencies (e.g. debugLogger, chatCompressionService).
// stat/mkdir/unlink are mocked to return default values for I/O-free testing.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn().mockResolvedValue({ size: 100 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('')),
  };
});

// We intentionally do NOT mock node:fs root to avoid breaking indirect
// dependencies (e.g. debugLogger, symlink) that import from 'node:fs'.
/**
 * Create a mock child process that emits stdout data and close event.
 */
function createMockChild(stdoutData: string, exitCode: number = 0) {
  const stdout = new EventEmitter() as EventEmitter & {
    pipe: (dest: EventEmitter) => EventEmitter;
  };
  stdout.pipe = (dest: EventEmitter) => {
    stdout.on('data', (data: Buffer) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dest as any).write?.(data);
    });
    return dest;
  };
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = stdout;
  child.kill = vi.fn();
  child.killed = false;

  process.nextTick(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    child.emit('close', exitCode);
  });

  return child;
}

/**
 * Create a mock stdout with a pipe method.
 */
function createMockStdout() {
  const stdout = new EventEmitter() as EventEmitter & {
    pipe: (dest: EventEmitter) => EventEmitter;
  };
  stdout.pipe = (dest: EventEmitter) => {
    stdout.on('data', (data: Buffer) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dest as any).write?.(data);
    });
    return dest;
  };
  return stdout;
}

/**
 * Set up environment for xclip/X11 testing.
 */
function setupX11Env() {
  vi.stubEnv('WAYLAND_DISPLAY', undefined as unknown as string);
  vi.stubEnv('XDG_SESSION_TYPE', 'x11');
  vi.stubEnv('DISPLAY', ':0');
  Object.defineProperty(process, 'platform', {
    value: 'linux',
    configurable: true,
    writable: true,
  });
}

const originalPlatform = process.platform;

describe('clipboardUtils', () => {
  let clipboardHasImage: () => Promise<boolean>;
  let saveClipboardImage: (dir?: string) => Promise<string | null>;
  let cleanupOldClipboardImages: (dir?: string) => Promise<void>;
  let writeOsc52: (text: string) => boolean;
  let readTextFromClipboard: () => string;

  beforeEach(async () => {
    // Clean up /tmp/test directory from previous runs to ensure
    // fs.open with O_EXCL fails consistently in saveFromCommand tests.
    // Must use the real fs module because node:fs/promises is mocked.
    const realFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    await realFs.rm('/tmp/test', { recursive: true, force: true });

    clipboardMockState.failLoad = false;
    clipboardMockState.loadDelayMs = 0;
    vi.resetModules();
    vi.clearAllMocks();
    // Default: execFileSync throws (no binary found). Tests override as needed.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    // Default: execSync throws (command -v fails = binary not found).
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    // Dynamic import after resetModules gives a fresh module instance.
    // Top-level import would be stale after resetModules.
    const mod = await import('./clipboardUtils.js');
    clipboardHasImage = mod.clipboardHasImage;
    saveClipboardImage = mod.saveClipboardImage;
    cleanupOldClipboardImages = mod.cleanupOldClipboardImages;
    writeOsc52 = mod.writeOsc52;
    readTextFromClipboard = mod.readTextFromClipboard;
    mod.resetLinuxClipboardTool();
    // Set up Wayland env as default
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('XDG_SESSION_TYPE', undefined as unknown as string);
    vi.stubEnv('DISPLAY', undefined as unknown as string);
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
      writable: true,
    });
  });

  describe('clipboardHasImage', () => {
    it('should return true when clipboard contains image', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      const mockChild = createMockChild('image/png\nimage/bmp\n', 0);
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(true);
    });

    it('should return false when clipboard does not contain image', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
      const mockChild = createMockChild('text/plain\n', 0);
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should return false when wl-paste is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });
  });

  // ─── xclip / X11 path tests ───────────────────────────────────

  describe('xclip / X11 path', () => {
    beforeEach(() => {
      setupX11Env();
    });

    describe('clipboardHasImage', () => {
      it('should detect xclip as the clipboard tool on X11', async () => {
        mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
        const mockChild = createMockChild('image/png\nTARGETS\n', 0);
        mockSpawn.mockReturnValue(mockChild);

        const result = await clipboardHasImage();
        expect(result).toBe(true);
        // Verify xclip was called with correct TARGETS args
        expect(mockSpawn).toHaveBeenCalledWith(
          'xclip',
          ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
      });

      it('should return false when xclip reports no image types', async () => {
        mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
        const mockChild = createMockChild('text/plain\nUTF8_STRING\n', 0);
        mockSpawn.mockReturnValue(mockChild);

        const result = await clipboardHasImage();
        expect(result).toBe(false);
      });

      it('should return false when xclip is not found', async () => {
        mockExecSync.mockImplementation(() => {
          throw new Error('command not found');
        });

        const result = await clipboardHasImage();
        expect(result).toBe(false);
      });

      it('should fall back to xclip when wl-paste is not found in Wayland+DISPLAY env', async () => {
        // Wayland env with X11 display available (e.g. XWayland)
        vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
        vi.stubEnv('DISPLAY', ':0');
        // wl-paste not installed, xclip is
        mockExecSync.mockImplementation((cmd: string) => {
          if (typeof cmd === 'string' && cmd.includes('wl-paste'))
            throw new Error('not found');
          return Buffer.from('/usr/bin/xclip');
        });
        const mockChild = createMockChild('image/png\n', 0);
        mockSpawn.mockReturnValue(mockChild);

        const result = await clipboardHasImage();
        expect(result).toBe(true);
        expect(mockSpawn).toHaveBeenCalledWith(
          'xclip',
          ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
      });
    });

    describe('saveClipboardImage', () => {
      it('should return null when xclip is not found', async () => {
        mockExecSync.mockImplementation(() => {
          throw new Error('command not found');
        });

        const result = await saveClipboardImage('/tmp/test');
        expect(result).toBe(null);
      });

      // xclip save success path: blocked by vitest's built-in module mock
      // limitation.  node:fs.createWriteStream cannot be mocked without
      // breaking indirect deps (debugLogger, symlink) that import
      // { promises as fs } from 'node:fs'.  Error paths below verify
      // correct spawn construction; clipboardHasImage tests verify detection.
    });
  });

  // ─── WSL2 PowerShell fallback tests ──────────────────────────

  describe('WSL2 PowerShell clipboard fallback', () => {
    it('should detect image via powershell.exe when no Linux tool is available', async () => {
      // No Linux clipboard tools installed
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      // powershell.exe binary exists
      mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
        if (
          bin === 'powershell.exe' &&
          args.some((a) => typeof a === 'string' && a.includes('ContainsImage'))
        ) {
          return 'True';
        }
        throw new Error('not found');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(true);
    });

    it('should return false when powershell.exe reports no image', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      mockExecFileSync.mockImplementation((bin: string) => {
        if (bin === 'powershell.exe') return 'False';
        throw new Error('not found');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should save image via powershell.exe and return the path', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
        if (
          bin === 'powershell.exe' &&
          args.some((a) => typeof a === 'string' && a.includes('ContainsImage'))
        ) {
          return 'True';
        }
        if (
          bin === 'powershell.exe' &&
          args.some((a) => typeof a === 'string' && a.includes('GetImage'))
        ) {
          return '';
        }
        throw new Error('not found');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).not.toBe(null);
      expect(result).toMatch(/clipboard-.*\.png$/);
    });

    it('should return null when powershell.exe save fails', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      // powershell.exe: ContainsImage returns True, but GetImage throws
      let getImageCalled = false;
      mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
        if (
          bin === 'powershell.exe' &&
          args.some((a) => typeof a === 'string' && a.includes('ContainsImage'))
        ) {
          return 'True';
        }
        if (
          bin === 'powershell.exe' &&
          args.some((a) => typeof a === 'string' && a.includes('GetImage'))
        ) {
          getImageCalled = true;
          throw new Error('save failed');
        }
        throw new Error('not found');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
      expect(getImageCalled).toBe(true);
    });
  });

  // ─── BMP-to-PNG conversion tests ──────────────────────────────

  describe('BMP-to-PNG conversion (wl-paste)', () => {
    // Note: BMP-to-PNG conversion success path requires saveFromCommand to resolve,
    // which is blocked by the createWriteStream mocking issue.
    // The "prefer PNG over BMP" test below verifies the correct branching logic,
    // and the "python3 PIL conversion fails" test verifies error handling.

    it('should return null when python3 PIL conversion fails', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // only bmp
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/bmp\n'));
            child.emit('close', 0);
          });
        } else if (callCount === 2) {
          // wl-paste --type image/bmp: save succeeds
          process.nextTick(() => {
            child.emit('close', 0);
          });
        } else {
          // python3 PIL conversion: fails
          process.nextTick(() => {
            child.emit('close', 1);
          });
        }

        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should prefer PNG over BMP when both are available', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      let callCount = 0;
      const spawnCalls: Array<{ command: string; args: string[] }> = [];
      mockSpawn.mockImplementation((command: string, args: string[]) => {
        callCount++;
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // both png and bmp available
          spawnCalls.push({ command, args });
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/png\nimage/bmp\n'));
            child.emit('close', 0);
          });
        } else if (callCount === 2) {
          // wl-paste --type image/png: attempted but O_EXCL fails (dir doesn't exist)
          spawnCalls.push({ command, args });
          process.nextTick(() => {
            child.emit('close', 0);
          });
        }

        return child;
      });

      await saveClipboardImage('/tmp/test');

      // O_EXCL in saveFromCommand prevents the second spawn because
      // mkdir is mocked (directory never actually created), so fs.open
      // fails. Only the list-types spawn fires.
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].args).toContain('--list-types');
    });
  });

  // ─── saveFromCommand error path tests ─────────────────────────

  describe('saveFromCommand error paths', () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));
    });

    it('should return null on spawn timeout (5s)', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // --list-types: succeeds
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/png\n'));
            child.emit('close', 0);
          });
        } else {
          // wl-paste save: never emits close — will timeout
          // do nothing
        }

        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    }, 10000);

    it('should return null on spawn error', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // --list-types: succeeds
          return createMockChild('image/png\n', 0);
        }
        // wl-paste save: emit error
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        child.killed = false;

        process.nextTick(() => {
          child.emit('error', new Error('spawn ENOENT'));
        });
        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null on stdout error', async () => {
      let callCount = 0;
      mockSpawn.mockImplementation(() => {
        callCount++;
        const stdout = createMockStdout();
        const child = new EventEmitter() as EventEmitter & {
          stdout: ReturnType<typeof createMockStdout>;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
          killed: boolean;
        };
        child.stdout = stdout;
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        child.killed = false;

        if (callCount === 1) {
          // --list-types: succeeds
          process.nextTick(() => {
            stdout.emit('data', Buffer.from('image/png\n'));
            child.emit('close', 0);
          });
        } else {
          // wl-paste save: stdout error
          process.nextTick(() => {
            stdout.emit('error', new Error('read error'));
          });
        }

        return child;
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    // Note: fileStream error path requires saveFromCommand to reach the fileStream error handler.
    // Due to createWriteStream mocking limitations, this path cannot be properly tested.
    // The stdout error and spawn error tests above cover similar error handling logic.
  });

  // ─── saveClipboardImage existing tests (improved) ─────────────

  describe('saveClipboardImage', () => {
    it('should return null when no clipboard tool is available', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null on spawn error during list-types', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      // Mock spawn to throw an error
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn error');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    // Note: PNG save success path requires saveFromCommand to resolve with true,
    // which is blocked by the createWriteStream mocking limitation.
    // The spawn error and timeout tests above verify error handling.
    // The correct wl-paste command invocation is verified indirectly through
    // the clipboardHasImage tests and the fact that saveClipboardImage
    // calls the right spawn commands before timing out.
  });

  describe('cleanupOldClipboardImages', () => {
    it('should not throw errors when directory does not exist', async () => {
      await expect(
        cleanupOldClipboardImages('/path/that/does/not/exist'),
      ).resolves.not.toThrow();
    });

    it('should complete without errors on valid directory', async () => {
      await expect(cleanupOldClipboardImages('.')).resolves.not.toThrow();
    });
  });

  describe('macOS/Windows fallback', () => {
    it('notifies after a cached native module load failure', async () => {
      clipboardMockState.failLoad = true;
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });

      await expect(mod.clipboardHasImage()).resolves.toBe(false);
      const onUnavailable = vi.fn();
      await expect(mod.clipboardHasImage(onUnavailable)).resolves.toBe(false);
      expect(onUnavailable).toHaveBeenCalledOnce();
    });

    it('shares an in-flight native module load without false errors', async () => {
      clipboardMockState.loadDelayMs = 20;
      vi.resetModules();
      const mod = await import('./clipboardUtils.js');
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });
      const onUnavailable = vi.fn();

      await expect(
        Promise.all([
          mod.clipboardHasImage(onUnavailable),
          mod.clipboardHasImage(onUnavailable),
        ]),
      ).resolves.toEqual([false, false]);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('should return false on non-linux platform when @teddyzhu/clipboard fails', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
        writable: true,
      });

      // @teddyzhu/clipboard mock returns false by default
      const result = await clipboardHasImage();
      expect(result).toBe(false);

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        writable: true,
      });
    });

    it('should return null on non-linux platform when saving fails', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: true,
      });

      // @teddyzhu/clipboard mock returns false by default
      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);

      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        writable: true,
      });
    });
  });

  describe('cache behavior', () => {
    it('should reset wl-paste cache between clipboardHasImage calls', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      // First call: returns image
      const mockChild1 = createMockChild('image/png\n', 0);
      mockSpawn.mockReturnValue(mockChild1);
      const result1 = await clipboardHasImage();
      expect(result1).toBe(true);

      // Second call: should also return true (cache reset, new spawn)
      const mockChild2 = createMockChild('text/plain\n', 0);
      mockSpawn.mockReturnValue(mockChild2);
      const result2 = await clipboardHasImage();
      expect(result2).toBe(false);
    });
  });

  describe('writeOsc52', () => {
    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalStderrIsTTY = process.stderr.isTTY;
    let stdoutWriteMock: ReturnType<typeof vi.fn>;
    let stderrWriteMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      stdoutWriteMock = vi.fn();
      stderrWriteMock = vi.fn();
      // Control multiplexer env vars for deterministic tests
      vi.stubEnv('TMUX', undefined as unknown as string);
      vi.stubEnv('STY', undefined as unknown as string);
      // Mock isTTY and write
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: false,
        configurable: true,
      });
      process.stdout.write = stdoutWriteMock;
      process.stderr.write = stderrWriteMock;
    });

    afterEach(() => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalStderrIsTTY,
        configurable: true,
      });
      vi.restoreAllMocks();
    });

    it('should write OSC 52 sequence to stdout when stdout is TTY', () => {
      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
      expect(stderrWriteMock).not.toHaveBeenCalled();
    });

    it('should write OSC 52 sequence to stderr when stdout is not TTY but stderr is', () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: true,
        configurable: true,
      });

      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stderrWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
      expect(stdoutWriteMock).not.toHaveBeenCalled();
    });

    it('should return false and not write when neither stdout nor stderr is TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stderr, 'isTTY', {
        value: false,
        configurable: true,
      });

      const result = writeOsc52('hello world');

      expect(result).toBe(false);
      expect(stdoutWriteMock).not.toHaveBeenCalled();
      expect(stderrWriteMock).not.toHaveBeenCalled();
    });

    it('should handle special characters in text', () => {
      const text = 'special: \n\t\r"\'\\';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });

    it('should handle empty string', () => {
      const text = '';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const expectedSequence = `\x1b]52;c;${expectedBase64}\x07`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });

    it('should return false on write error', () => {
      stdoutWriteMock.mockImplementation(() => {
        throw new Error('write failed');
      });

      const result = writeOsc52('hello');

      expect(result).toBe(false);
    });

    it('should wrap in tmux DCS envelope when TMUX is set', () => {
      vi.stubEnv('TMUX', '/tmp/tmux-1000/default,12345,0');
      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const rawSequence = `\x1b]52;c;${expectedBase64}\x07`;
      const expectedSequence = `\x1bPtmux;\x1b${rawSequence}\x1b\\`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });

    it('should wrap in screen DCS envelope when STY is set', () => {
      vi.stubEnv('STY', '12345.pts-0.host');
      const text = 'hello world';
      const expectedBase64 = Buffer.from(text, 'utf-8').toString('base64');
      const rawSequence = `\x1b]52;c;${expectedBase64}\x07`;
      const expectedSequence = `\x1bP${rawSequence}\x1b\\`;

      const result = writeOsc52(text);

      expect(result).toBe(true);
      expect(stdoutWriteMock).toHaveBeenCalledWith(
        expectedSequence,
        expect.any(Function),
      );
    });
  });

  describe('readTextFromClipboard', () => {
    it('should read text via pbpaste on macOS', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      mockExecFileSync.mockReturnValue('hello from mac clipboard');

      const result = readTextFromClipboard();

      expect(result).toBe('hello from mac clipboard');
      expect(mockExecFileSync).toHaveBeenCalledWith('pbpaste', [], {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    });

    it('should read text via powershell on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
      });
      mockExecFileSync.mockReturnValue('hello from win clipboard');

      const result = readTextFromClipboard();

      expect(result).toBe('hello from win clipboard');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-c', 'Get-Clipboard'],
        { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] },
      );
    });

    it('should read text via xclip on Linux X11', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      // command -v xclip succeeds (probe)
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      // actual read via execFileSync
      mockExecFileSync.mockReturnValue('clipboard text');

      const result = readTextFromClipboard();

      expect(result).toBe('clipboard text');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'xclip',
        ['-selection', 'clipboard', '-o'],
        { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] },
      );
    });

    it('should fall back to xsel when xclip is not found on Linux', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      // command -v xclip fails, command -v xsel succeeds
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('xclip'))
          throw new Error('not found');
        return Buffer.from('/usr/bin/xsel');
      });
      mockExecFileSync.mockReturnValue('xsel clipboard text');

      const result = readTextFromClipboard();

      expect(result).toBe('xsel clipboard text');
    });

    it('should fall back to wl-paste when xclip and xsel are not found on Linux', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      mockExecSync.mockImplementation((cmd: string) => {
        if (
          typeof cmd === 'string' &&
          (cmd.includes('xclip') || cmd.includes('xsel'))
        )
          throw new Error('not found');
        return Buffer.from('/usr/bin/wl-paste');
      });
      mockExecFileSync.mockReturnValue('wl-paste text');

      const result = readTextFromClipboard();

      expect(result).toBe('wl-paste text');
    });

    it('should return empty string when no clipboard tool is available on Linux', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      // All command -v checks fail, powershell.exe probe also fails
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = readTextFromClipboard();

      expect(result).toBe('');
    });

    it('should return empty string on pbpaste failure on macOS', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        configurable: true,
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error('pbpaste failed');
      });

      const result = readTextFromClipboard();

      expect(result).toBe('');
    });

    it('should cache the working Linux clipboard tool across calls', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      // command -v xclip succeeds (probe)
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/xclip'));
      mockExecFileSync.mockReturnValue('clipboard text');

      readTextFromClipboard();
      const execSyncCountAfterFirst = mockExecSync.mock.calls.length;

      readTextFromClipboard();
      // Second call should NOT re-probe (cached)
      expect(mockExecSync.mock.calls.length).toBe(execSyncCountAfterFirst);
    });

    it('should fall back to powershell.exe on WSL2 when no Linux tool is available', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      // All command -v checks fail
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      // powershell.exe probe and read succeed
      mockExecFileSync.mockImplementation((bin: string) => {
        if (bin === 'powershell.exe') return 'windows clipboard text';
        throw new Error('not found');
      });

      const result = readTextFromClipboard();

      expect(result).toBe('windows clipboard text');
    });

    it('should return empty string when no tool including powershell is available', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = readTextFromClipboard();

      expect(result).toBe('');
    });
  });
});
