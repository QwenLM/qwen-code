/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeAll, describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';

// Polyfill browser APIs for Node test environment
const g = globalThis as typeof globalThis & {
  FileReader?: typeof FileReader;
  atob?: typeof atob;
  File?: typeof File;
};

if (!g.atob) {
  g.atob = (b64: string) => Buffer.from(b64, 'base64').toString('binary');
}

if (!g.FileReader) {
  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;

    readAsDataURL(blob: Blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          const base64 = Buffer.from(buf).toString('base64');
          const mime =
            (blob as { type?: string }).type || 'application/octet-stream';
          this.result = `data:${mime};base64,${base64}`;
          this.onload?.({} as ProgressEvent<FileReader>);
        })
        .catch((err) => {
          this.onerror?.(err);
        });
    }
  }
  g.FileReader = MockFileReader as unknown as typeof FileReader;
}

if (!g.File) {
  class MockFile extends Blob {
    name: string;
    lastModified: number;
    constructor(
      bits: BlobPart[],
      name: string,
      options?: BlobPropertyBag & { lastModified?: number },
    ) {
      super(bits, options);
      this.name = name;
      this.lastModified = options?.lastModified ?? Date.now();
    }
  }
  g.File = MockFile as unknown as typeof File;
}

let fileToBase64: typeof import('./imageUtils.js').fileToBase64;
let isSupportedImage: typeof import('./imageUtils.js').isSupportedImage;
let isWithinSizeLimit: typeof import('./imageUtils.js').isWithinSizeLimit;
let formatFileSize: typeof import('./imageUtils.js').formatFileSize;
let generateImageId: typeof import('./imageUtils.js').generateImageId;
let getExtensionFromMimeType: typeof import('./imageUtils.js').getExtensionFromMimeType;

beforeAll(async () => {
  const mod = await import('./imageUtils.js');
  fileToBase64 = mod.fileToBase64;
  isSupportedImage = mod.isSupportedImage;
  isWithinSizeLimit = mod.isWithinSizeLimit;
  formatFileSize = mod.formatFileSize;
  generateImageId = mod.generateImageId;
  getExtensionFromMimeType = mod.getExtensionFromMimeType;
});

describe('Image Utils', () => {
  describe('isSupportedImage', () => {
    it('should accept supported image types', () => {
      const pngFile = new File([''], 'test.png', { type: 'image/png' });
      const jpegFile = new File([''], 'test.jpg', { type: 'image/jpeg' });
      const gifFile = new File([''], 'test.gif', { type: 'image/gif' });

      expect(isSupportedImage(pngFile)).toBe(true);
      expect(isSupportedImage(jpegFile)).toBe(true);
      expect(isSupportedImage(gifFile)).toBe(true);
    });

    it('should reject unsupported file types', () => {
      const textFile = new File([''], 'test.txt', { type: 'text/plain' });
      const pdfFile = new File([''], 'test.pdf', { type: 'application/pdf' });

      expect(isSupportedImage(textFile)).toBe(false);
      expect(isSupportedImage(pdfFile)).toBe(false);
    });
  });

  describe('isWithinSizeLimit', () => {
    it('should accept files under 10MB', () => {
      const smallFile = new File(['a'.repeat(1024 * 1024)], 'small.png', {
        type: 'image/png',
      });
      expect(isWithinSizeLimit(smallFile)).toBe(true);
    });

    it('should reject files over 10MB', () => {
      // Create a mock file with size property
      const largeFile = {
        size: 11 * 1024 * 1024, // 11MB
      } as File;
      expect(isWithinSizeLimit(largeFile)).toBe(false);
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0 B');
      expect(formatFileSize(512)).toBe('512 B');
      expect(formatFileSize(1024)).toBe('1 KB');
      expect(formatFileSize(1536)).toBe('1.5 KB');
      expect(formatFileSize(1024 * 1024)).toBe('1 MB');
      expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    });
  });

  describe('generateImageId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateImageId();
      const id2 = generateImageId();

      expect(id1).toMatch(/^img_\d+_[a-z0-9]+$/);
      expect(id2).toMatch(/^img_\d+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('getExtensionFromMimeType', () => {
    it('should return correct extensions', () => {
      expect(getExtensionFromMimeType('image/png')).toBe('.png');
      expect(getExtensionFromMimeType('image/jpeg')).toBe('.jpg');
      expect(getExtensionFromMimeType('image/gif')).toBe('.gif');
      expect(getExtensionFromMimeType('image/webp')).toBe('.webp');
      expect(getExtensionFromMimeType('image/tiff')).toBe('.tiff');
      expect(getExtensionFromMimeType('image/heic')).toBe('.heic');
      expect(getExtensionFromMimeType('unknown/type')).toBe('.png'); // default
    });
  });

  describe('createImageAttachment', () => {
    it('should create attachment from valid image file', async () => {
      const content = 'fake-image-data';
      const file = new File([content], 'test.png', { type: 'image/png' });
      const { createImageAttachment } = await import('./imageUtils.js');
      const attachment = await createImageAttachment(file);

      expect(attachment).not.toBeNull();
      expect(attachment?.name).toBe('test.png');
      expect(attachment?.type).toBe('image/png');
      expect(attachment?.data).toMatch(/^data:image\/png;base64,/);
      expect(attachment?.id).toMatch(/^img_\d+_[a-z0-9]+$/);
      expect(attachment?.timestamp).toBeGreaterThan(0);
    });

    it('should return null for unsupported image type', async () => {
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });
      const { createImageAttachment } = await import('./imageUtils.js');
      const attachment = await createImageAttachment(file);
      expect(attachment).toBeNull();
    });

    it('should return null for oversized file', async () => {
      // Create a mock file that exceeds 10MB limit
      const largeContent = 'a'.repeat(11 * 1024 * 1024);
      const file = new File([largeContent], 'large.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });

      const { createImageAttachment } = await import('./imageUtils.js');
      const attachment = await createImageAttachment(file);
      expect(attachment).toBeNull();
    });
  });

  describe('generatePastedImageName', () => {
    let generatePastedImageName: typeof import('./imageUtils.js').generatePastedImageName;

    beforeAll(async () => {
      const mod = await import('./imageUtils.js');
      generatePastedImageName = mod.generatePastedImageName;
    });

    it('should generate valid timestamp-based names', () => {
      const name = generatePastedImageName('image/png');

      expect(name).toMatch(/^pasted_image_\d{6}\.png$/);
    });

    it('should use correct extension for each mime type', () => {
      expect(generatePastedImageName('image/png')).toMatch(/\.png$/);
      expect(generatePastedImageName('image/jpeg')).toMatch(/\.jpg$/);
      expect(generatePastedImageName('image/gif')).toMatch(/\.gif$/);
      expect(generatePastedImageName('image/webp')).toMatch(/\.webp$/);
      expect(generatePastedImageName('image/tiff')).toMatch(/\.tiff$/);
      expect(generatePastedImageName('image/heic')).toMatch(/\.heic$/);
    });
  });

  describe('fileToBase64', () => {
    it('should convert file to base64', async () => {
      const content = 'test content';
      const file = new File([content], 'test.txt', { type: 'text/plain' });

      const base64 = await fileToBase64(file);
      expect(base64).toMatch(/^data:text\/plain;base64,/);

      // Decode and verify content
      const base64Content = base64.split(',')[1];
      const decoded = atob(base64Content);
      expect(decoded).toBe(content);
    });
  });
});
