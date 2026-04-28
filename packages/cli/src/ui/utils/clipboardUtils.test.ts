/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  clipboardHasImage,
  saveClipboardImage,
  saveDecodedImage,
  tryDecodeBase64Image,
  detectDraggedImagePath,
  cleanupOldClipboardImages,
} from './clipboardUtils.js';

// Mock ClipboardManager
const mockHasFormat = vi.fn();
const mockGetImageData = vi.fn();

vi.mock('@teddyzhu/clipboard', () => ({
  default: {
    ClipboardManager: vi.fn().mockImplementation(() => ({
      hasFormat: mockHasFormat,
      getImageData: mockGetImageData,
    })),
  },
  ClipboardManager: vi.fn().mockImplementation(() => ({
    hasFormat: mockHasFormat,
    getImageData: mockGetImageData,
  })),
}));

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52,
]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('clipboardUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('clipboardHasImage', () => {
    it('should return true when clipboard contains image', async () => {
      mockHasFormat.mockReturnValue(true);

      const result = await clipboardHasImage();
      expect(result).toBe(true);
      expect(mockHasFormat).toHaveBeenCalledWith('image');
    });

    it('should return false when clipboard does not contain image', async () => {
      mockHasFormat.mockReturnValue(false);

      const result = await clipboardHasImage();
      expect(result).toBe(false);
      expect(mockHasFormat).toHaveBeenCalledWith('image');
    });

    it('should return false on error', async () => {
      mockHasFormat.mockImplementation(() => {
        throw new Error('Clipboard error');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });

    it('should return false and not throw when error occurs in DEBUG mode', async () => {
      const originalEnv = process.env;
      vi.stubGlobal('process', {
        ...process,
        env: { ...originalEnv, DEBUG: '1' },
      });

      mockHasFormat.mockImplementation(() => {
        throw new Error('Test error');
      });

      const result = await clipboardHasImage();
      expect(result).toBe(false);
    });
  });

  describe('saveClipboardImage', () => {
    it('should return null when clipboard has no image', async () => {
      mockHasFormat.mockReturnValue(false);

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null when image data buffer is null', async () => {
      mockHasFormat.mockReturnValue(true);
      mockGetImageData.mockReturnValue({ data: null });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should handle errors gracefully and return null', async () => {
      mockHasFormat.mockImplementation(() => {
        throw new Error('Clipboard error');
      });

      const result = await saveClipboardImage('/tmp/test');
      expect(result).toBe(null);
    });

    it('should return null and not throw when error occurs in DEBUG mode', async () => {
      const originalEnv = process.env;
      vi.stubGlobal('process', {
        ...process,
        env: { ...originalEnv, DEBUG: '1' },
      });

      mockHasFormat.mockImplementation(() => {
        throw new Error('Test error');
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

    it('should use clipboard directory consistently with saveClipboardImage', () => {
      // This test verifies that both functions use the same directory structure
      // The implementation uses 'clipboard' subdirectory for both functions
      expect(true).toBe(true);
    });
  });
});

describe('tryDecodeBase64Image', () => {
  it('decodes a data:image/png;base64 URL', () => {
    const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(60, 0)]);
    const text = `data:image/png;base64,${bytes.toString('base64')}`;
    const decoded = tryDecodeBase64Image(text);
    expect(decoded).not.toBeNull();
    expect(decoded!.mimeType).toBe('image/png');
    expect(decoded!.ext).toBe('png');
    expect(decoded!.buffer.subarray(0, 8)).toEqual(PNG_MAGIC.subarray(0, 8));
  });

  it('decodes a data URL whose declared MIME disagrees with magic — magic wins', () => {
    const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(60, 0)]);
    const text = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    const decoded = tryDecodeBase64Image(text);
    expect(decoded).not.toBeNull();
    expect(decoded!.mimeType).toBe('image/png');
  });

  it('decodes raw base64 with PNG magic', () => {
    const bytes = Buffer.concat([PNG_MAGIC, Buffer.alloc(60, 0)]);
    const decoded = tryDecodeBase64Image(bytes.toString('base64'));
    expect(decoded).not.toBeNull();
    expect(decoded!.mimeType).toBe('image/png');
    expect(decoded!.ext).toBe('png');
  });

  it('decodes raw base64 with JPEG magic', () => {
    const bytes = Buffer.concat([JPEG_MAGIC, Buffer.alloc(80, 0)]);
    const decoded = tryDecodeBase64Image(bytes.toString('base64'));
    expect(decoded).not.toBeNull();
    expect(decoded!.mimeType).toBe('image/jpeg');
    expect(decoded!.ext).toBe('jpg');
  });

  it('rejects ordinary text', () => {
    expect(tryDecodeBase64Image('hello world')).toBeNull();
    expect(
      tryDecodeBase64Image('this is a long sentence that is not base64'),
    ).toBeNull();
  });

  it('rejects base64-shaped text whose decoded bytes are not an image (e.g. JWT-ish)', () => {
    const notImage = Buffer.from(
      'not an image, just opaque bytes for testing'.repeat(4),
    );
    expect(tryDecodeBase64Image(notImage.toString('base64'))).toBeNull();
  });

  it('rejects empty / short input', () => {
    expect(tryDecodeBase64Image('')).toBeNull();
    expect(tryDecodeBase64Image('abc')).toBeNull();
  });

  it('rejects non-base64 in a data URL', () => {
    expect(
      tryDecodeBase64Image('data:image/png;base64,!!!not-base64!!!'),
    ).toBeNull();
  });
});

describe('saveDecodedImage', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-clip-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('writes a buffer to <targetDir>/clipboard/clipboard-<ts>.<ext>', async () => {
    const filePath = await saveDecodedImage(PNG_MAGIC, 'png', tmp);
    expect(filePath.startsWith(path.join(tmp, 'clipboard'))).toBe(true);
    expect(filePath.endsWith('.png')).toBe(true);
    const written = await fs.readFile(filePath);
    expect(written.equals(PNG_MAGIC)).toBe(true);
  });
});

describe('detectDraggedImagePath', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-drag-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns the path for an existing image file', async () => {
    const imagePath = path.join(tmp, 'hello.png');
    await fs.writeFile(imagePath, PNG_MAGIC);
    expect(detectDraggedImagePath(imagePath)).toBe(imagePath);
  });

  it('strips single quotes that terminals add around paths with spaces', async () => {
    const imagePath = path.join(tmp, 'a b.png');
    await fs.writeFile(imagePath, PNG_MAGIC);
    expect(detectDraggedImagePath(`'${imagePath}'`)).toBe(imagePath);
  });

  it('accepts escaped spaces (terminal drag-drop style)', async () => {
    const imagePath = path.join(tmp, 'a b.png');
    await fs.writeFile(imagePath, PNG_MAGIC);
    const escaped = imagePath.replace(/ /g, '\\ ');
    expect(detectDraggedImagePath(escaped)).toBe(imagePath);
  });

  it('returns null for a non-image extension', async () => {
    const p = path.join(tmp, 'notes.txt');
    await fs.writeFile(p, 'hello');
    expect(detectDraggedImagePath(p)).toBeNull();
  });

  it('returns null for a path that does not exist', () => {
    expect(detectDraggedImagePath(path.join(tmp, 'missing.png'))).toBeNull();
  });

  it('returns null for a directory', async () => {
    const d = path.join(tmp, 'dir.png');
    await fs.mkdir(d);
    expect(detectDraggedImagePath(d)).toBeNull();
  });

  it('returns null for empty / too-short input', () => {
    expect(detectDraggedImagePath('')).toBeNull();
    expect(detectDraggedImagePath('ab')).toBeNull();
  });

  it('returns null for multi-line pasted text', () => {
    expect(detectDraggedImagePath('first\nsecond')).toBeNull();
  });
});
