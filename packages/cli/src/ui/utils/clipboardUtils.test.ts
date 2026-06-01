/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
  resetLinuxClipboardTool,
} from './clipboardUtils.js';
import { EventEmitter } from 'node:events';

// Use vi.hoisted to define mock functions before vi.mock is hoisted
const { mockSpawn, mockExecFileSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

// Mock @teddyzhu/clipboard
vi.mock('@teddyzhu/clipboard', () => ({
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
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  default: {
    spawn: mockSpawn,
    execFileSync: mockExecFileSync,
    exec: vi.fn(),
    execFile: vi.fn(),
  },
  spawn: mockSpawn,
  execFileSync: mockExecFileSync,
  exec: vi.fn(),
  execFile: vi.fn(),
}));

/**
 * Create a mock child process that emits stdout data and close event.
 */
function createMockChild(stdoutData: string, exitCode: number = 0) {
  const stdout = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  child.stdout = stdout;
  child.kill = vi.fn();
  child.killed = false;

  // Emit data asynchronously
  process.nextTick(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    child.emit('close', exitCode);
  });

  return child;
}

describe('clipboardUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLinuxClipboardTool();

    // Stub process.platform to 'linux'
    vi.stubGlobal('process', {
      ...process,
      platform: 'linux',
      env: {
        ...process.env,
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_SESSION_TYPE: undefined,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('clipboardHasImage', () => {
    it('should return true when clipboard contains image', async () => {
      // Mock execSync to return successfully (wl-paste found)
      mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      const mockChild = createMockChild('image/png\nimage/bmp\n', 0);
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(true);
    });

    it('should return false when clipboard does not contain image', async () => {
      // Mock execSync to return successfully (wl-paste found)
      mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      const mockChild = createMockChild('text/plain\n', 0);
      mockSpawn.mockReturnValue(mockChild);

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should return false when wl-paste is not found', async () => {
      // Mock execSync to throw (wl-paste not found)
      mockExecFileSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });
  });

  describe('saveClipboardImage', () => {
    it('should return null when no clipboard tool is available', async () => {
      // Mock execSync to throw (wl-paste not found)
      mockExecFileSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null on spawn error', async () => {
      // Mock execSync to return successfully (wl-paste found)
      mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/wl-paste'));

      // Mock spawn to throw an error
      mockSpawn.mockImplementation(() => {
        throw new Error('spawn error');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });
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
    it('should return false on non-linux platform when @teddyzhu/clipboard fails', async () => {
      vi.stubGlobal('process', {
        ...process,
        platform: 'darwin',
      });

      // @teddyzhu/clipboard mock returns false by default
      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should return null on non-linux platform when saving fails', async () => {
      vi.stubGlobal('process', {
        ...process,
        platform: 'win32',
      });

      // @teddyzhu/clipboard mock returns false by default
      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });
  });
});
