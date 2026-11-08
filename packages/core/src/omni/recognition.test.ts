/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extensionForVideoMime,
  hashFileSha256,
  recognizeMediaFile,
  sniffFileModality,
  sniffVideoMimeType,
} from './recognition.js';
import { probeMediaMetadata } from './ffmpeg.js';

vi.mock('./ffmpeg.js', () => ({
  probeMediaMetadata: vi.fn(),
}));

function mp4Header(brand = 'isom'): Buffer {
  // [size:4]["ftyp"][major brand:4][minor version:4]
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand, 'latin1'),
    Buffer.alloc(8),
  ]);
}

// ["RIFF"][size:4][form type:4], optionally padded.
function riff(form: string, padding = 0): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.alloc(4),
    Buffer.from(form, 'latin1'),
    Buffer.alloc(padding),
  ]);
}

async function withTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
    expect(sniffVideoMimeType(riff('AVI ', 8))).toBe('video/x-msvideo');
  });

  it('returns null for non-video content', () => {
    const text = Buffer.from('hello world plain text data');
    expect(sniffVideoMimeType(text)).toBeNull();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(sniffVideoMimeType(png)).toBeNull();
    expect(sniffVideoMimeType(Buffer.alloc(0))).toBeNull();
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
  it('matches crypto sha256 over the same bytes', () =>
    withTempDir('omni-hash-', async (dir) => {
      const data = randomBytes(256 * 1024 + 17);
      const filePath = path.join(dir, 'blob.bin');
      await fs.writeFile(filePath, data);
      const expected = createHash('sha256').update(data).digest('hex');
      await expect(hashFileSha256(filePath)).resolves.toBe(expected);
    }));
});

describe('sniffMediaType (S2 modalities)', async () => {
  const { sniffMediaType } = await import('./recognition.js');
  const expectSniff = (header: Buffer, mimeType: string, modality: string) =>
    expect(sniffMediaType(header)).toMatchObject({ mimeType, modality });

  it('detects images: png/jpeg/webp/gif', () => {
    expectSniff(
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]),
      'image/png',
      'image',
    );
    expectSniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', 'image');
    expectSniff(riff('WEBP'), 'image/webp', 'image');
    expectSniff(Buffer.from('GIF89a....'), 'image/gif', 'image');
  });

  it('detects audio: mp3(id3/framesync)/wav/flac/ogg/m4a', () => {
    expectSniff(Buffer.from('ID3\x04\x00'), 'audio/mpeg', 'audio');
    expectSniff(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg', 'audio');
    expectSniff(riff('WAVE'), 'audio/wav', 'audio');
    expectSniff(Buffer.from('fLaC....'), 'audio/flac', 'audio');
    expectSniff(Buffer.from('OggS....'), 'audio/ogg', 'audio');
    const m4a = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypM4A ', 'latin1'),
      Buffer.alloc(4),
    ]);
    expectSniff(m4a, 'audio/mp4', 'audio');
  });

  it('detects ADTS AAC (layer bits 00) as audio/aac, not audio/mpeg', () => {
    // ADTS header: syncword 0xFFF, MPEG-4, layer 00, no CRC → 0xFF 0xF1.
    // Layer 00 is reserved in MPEG audio, so no valid MP3 is lost.
    expectSniff(Buffer.from([0xff, 0xf1, 0x50, 0x80]), 'audio/aac', 'audio');
    // MPEG-2 ADTS with CRC → 0xFF 0xF8.
    expectSniff(Buffer.from([0xff, 0xf8, 0x50, 0x80]), 'audio/aac', 'audio');
    // A real MP3 frame (layer III = bits 01) still sniffs as audio/mpeg.
    expectSniff(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg', 'audio');
  });

  it('rejects non-media content', () => {
    expect(sniffMediaType(Buffer.from('#!/bin/sh\necho hi'))).toBeNull();
    expect(sniffMediaType(Buffer.from('<html><body>'))).toBeNull();
    expect(sniffMediaType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });

  it('requires the full 6-byte GIF signature, not just the "GIF" prefix', () => {
    // Plain text happening to start with "GIF " must not sniff as an image.
    expect(sniffMediaType(Buffer.from('GIF export notes, take 2'))).toBeNull();
    expect(sniffMediaType(Buffer.from('GIF90a....'))).toBeNull();
    // Both real signatures detect.
    expectSniff(Buffer.from('GIF87a....'), 'image/gif', 'image');
    expectSniff(Buffer.from('GIF89a....'), 'image/gif', 'image');
  });

  it('does not mistake the UTF-16 LE BOM for an MPEG frame sync', () => {
    // 0xFF 0xFE passes the naive sync mask (0xFE & 0xE0 === 0xE0) and is even a
    // valid MPEG-1 Layer I header, but it is also the UTF-16 LE BOM: the sniffer
    // excludes it so UTF-16 LE text does not sniff as audio for callers without
    // a secondary modality gate.
    const utf16le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('h\0e\0l\0l\0o\0', 'latin1'),
    ]);
    expect(sniffMediaType(utf16le)).toBeNull();
    // Genuine frame syncs still detect.
    expectSniff(Buffer.from([0xff, 0xfb, 0x90]), 'audio/mpeg', 'audio');
    expect(sniffMediaType(Buffer.from([0xff, 0xf3, 0x00]))).toMatchObject({
      modality: 'audio',
    });
  });
});

describe('sniffFileModality', () => {
  async function sniffWritten(
    dir: string,
    name: string,
    content: Buffer | string,
  ) {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, content);
    return sniffFileModality(filePath);
  }

  it('reports the modality of a recognized media header', () =>
    withTempDir('omni-sniff-', async (dir) => {
      await expect(
        sniffWritten(dir, 'clip.mp4', mp4Header('isom')),
      ).resolves.toBe('video');
      await expect(
        sniffWritten(dir, 'song.mp3', Buffer.from('ID3\0\0\0', 'latin1')),
      ).resolves.toBe('audio');
      await expect(
        sniffWritten(dir, 'pic.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
      ).resolves.toBe('image');
    }));

  it('returns null for non-media content (legacy path keeps it)', () =>
    withTempDir('omni-sniff-', async (dir) => {
      await expect(
        sniffWritten(dir, 'notes.txt', 'just some text, definitely not media'),
      ).resolves.toBeNull();
      // Empty file: stat.size 0 → zero-length read, must not throw.
      await expect(sniffWritten(dir, 'empty.bin', '')).resolves.toBeNull();
    }));

  it('returns null (never throws) for an unreadable path', async () => {
    // The pre-gate must degrade to "not omni", not break the read.
    await expect(
      sniffFileModality(path.join(os.tmpdir(), 'omni-absent-xyz.mp4')),
    ).resolves.toBeNull();
  });

  it('returns the sniffed modality even when close() rejects (never throws)', async () => {
    // Network mounts can fail the final close() (EIO/ESTALE); the pre-gate's
    // never-throws contract must not turn a successful sniff into a crash.
    const header = mp4Header('isom');
    const openSpy = vi.spyOn(fs, 'open').mockResolvedValue({
      stat: async () => ({ size: header.length }),
      read: async (buf: Buffer) => {
        header.copy(buf);
        return { bytesRead: header.length, buffer: buf };
      },
      close: async () => {
        throw Object.assign(new Error('EIO: i/o error, close'), {
          code: 'EIO',
        });
      },
    } as unknown as fs.FileHandle);
    try {
      await expect(sniffFileModality('/mnt/nfs/clip.mp4')).resolves.toBe(
        'video',
      );
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe('recognizeMediaFile', () => {
  const probeMock = vi.mocked(probeMediaMetadata);
  const tmpDirs: string[] = [];

  async function tempFile(name: string, content: Buffer): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-recognize-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  afterEach(async () => {
    probeMock.mockReset();
    await Promise.all(
      tmpDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('fails closed on content that does not sniff as supported media', async () => {
    const filePath = await tempFile(
      'notes.txt',
      Buffer.from('just some plain text, definitely not media'),
    );
    await expect(recognizeMediaFile(filePath)).rejects.toThrow(
      /does not match a supported media container.*notes\.txt/s,
    );
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('rejects a sniffed modality that contradicts expectedModality', async () => {
    // A real MP3 frame sync referenced as video: the sniff succeeds (audio)
    // but the modality gate must reject the mismatch.
    const filePath = await tempFile(
      'clip.mp4',
      Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]),
    );
    await expect(
      recognizeMediaFile(filePath, { expectedModality: 'video' }),
    ).rejects.toThrow(
      /sniffs as audio \(audio\/mpeg\) but was referenced as video.*clip\.mp4/s,
    );
    expect(probeMock).not.toHaveBeenCalled();
  });

  it('resolves with the sniffed modality, MIME type, size, and probe metadata', async () => {
    probeMock.mockResolvedValue({ durationMs: 5000, codec: 'mp3' });
    const content = Buffer.concat([
      Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      Buffer.alloc(60),
    ]);
    const filePath = await tempFile('song.mp3', content);
    await expect(
      recognizeMediaFile(filePath, { expectedModality: 'audio' }),
    ).resolves.toEqual({
      modality: 'audio',
      detectedMimeType: 'audio/mpeg',
      sizeBytes: content.length,
      metadata: { durationMs: 5000, codec: 'mp3' },
    });
    expect(probeMock).toHaveBeenCalledWith(filePath, 'audio', undefined);
  });
});
