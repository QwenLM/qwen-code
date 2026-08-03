/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extensionForVideoMime,
  hashFileSha256,
  sniffVideoMimeType,
} from './recognition.js';

function mp4Header(brand = 'isom'): Buffer {
  // [size:4]["ftyp"][major brand:4][minor version:4]
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand, 'latin1'),
    Buffer.alloc(8),
  ]);
}

describe('sniffVideoMimeType', () => {
  it('detects the MP4 family via ftyp', () => {
    expect(sniffVideoMimeType(mp4Header('isom'))).toBe('video/mp4');
    expect(sniffVideoMimeType(mp4Header('mp42'))).toBe('video/mp4');
  });

  it('detects QuickTime via the qt brand', () => {
    expect(sniffVideoMimeType(mp4Header('qt  '))).toBe('video/quicktime');
  });

  it('detects WebM/Matroska via the EBML magic', () => {
    const header = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(16),
    ]);
    expect(sniffVideoMimeType(header)).toBe('video/webm');
  });

  it('detects AVI via RIFF/AVI', () => {
    const header = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('AVI ', 'latin1'),
      Buffer.alloc(8),
    ]);
    expect(sniffVideoMimeType(header)).toBe('video/x-msvideo');
  });

  it('returns null for non-video content', () => {
    expect(sniffVideoMimeType(Buffer.from('hello world plain text data'))).toBe(
      null,
    );
    expect(sniffVideoMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(
      null,
    ); // PNG
    expect(sniffVideoMimeType(Buffer.alloc(0))).toBe(null);
  });
});

describe('extensionForVideoMime', () => {
  it('maps known video MIME types', () => {
    expect(extensionForVideoMime('video/mp4')).toBe('.mp4');
    expect(extensionForVideoMime('video/quicktime')).toBe('.mov');
    expect(extensionForVideoMime('video/webm')).toBe('.webm');
    expect(extensionForVideoMime('video/x-msvideo')).toBe('.avi');
  });

  it('falls back to .bin for unknown types', () => {
    expect(extensionForVideoMime('video/unknown')).toBe('.bin');
  });
});

describe('hashFileSha256', () => {
  it('matches crypto sha256 over the same bytes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-hash-'));
    try {
      const data = randomBytes(256 * 1024 + 17);
      const filePath = path.join(dir, 'blob.bin');
      await fs.writeFile(filePath, data);
      const expected = createHash('sha256').update(data).digest('hex');
      await expect(hashFileSha256(filePath)).resolves.toBe(expected);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
