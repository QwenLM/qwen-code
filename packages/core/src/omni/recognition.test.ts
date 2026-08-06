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

describe('sniffMediaType (S2 modalities)', async () => {
  const { sniffMediaType } = await import('./recognition.js');

  it('detects images: png/jpeg/webp/gif', () => {
    expect(
      sniffMediaType(
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]),
      ),
    ).toMatchObject({ mimeType: 'image/png', modality: 'image' });
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject(
      { mimeType: 'image/jpeg', modality: 'image' },
    );
    expect(
      sniffMediaType(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.alloc(4),
          Buffer.from('WEBP', 'latin1'),
        ]),
      ),
    ).toMatchObject({ mimeType: 'image/webp', modality: 'image' });
    expect(sniffMediaType(Buffer.from('GIF89a....'))).toMatchObject({
      mimeType: 'image/gif',
      modality: 'image',
    });
  });

  it('detects audio: mp3(id3/framesync)/wav/flac/ogg/m4a', () => {
    expect(sniffMediaType(Buffer.from('ID3\x04\x00'))).toMatchObject({
      mimeType: 'audio/mpeg',
      modality: 'audio',
    });
    expect(sniffMediaType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toMatchObject(
      { mimeType: 'audio/mpeg', modality: 'audio' },
    );
    expect(
      sniffMediaType(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.alloc(4),
          Buffer.from('WAVE', 'latin1'),
        ]),
      ),
    ).toMatchObject({ mimeType: 'audio/wav', modality: 'audio' });
    expect(sniffMediaType(Buffer.from('fLaC....'))).toMatchObject({
      mimeType: 'audio/flac',
      modality: 'audio',
    });
    expect(sniffMediaType(Buffer.from('OggS....'))).toMatchObject({
      mimeType: 'audio/ogg',
      modality: 'audio',
    });
    const m4a = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypM4A ', 'latin1'),
      Buffer.alloc(4),
    ]);
    expect(sniffMediaType(m4a)).toMatchObject({
      mimeType: 'audio/mp4',
      modality: 'audio',
    });
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
    expect(sniffMediaType(Buffer.from('GIF87a....'))).toMatchObject({
      mimeType: 'image/gif',
      modality: 'image',
    });
    expect(sniffMediaType(Buffer.from('GIF89a....'))).toMatchObject({
      mimeType: 'image/gif',
      modality: 'image',
    });
  });

  it('does not mistake the UTF-16 LE BOM for an MPEG frame sync', () => {
    // 0xFF 0xFE passes the naive sync mask (0xFE & 0xE0 === 0xE0) and is even
    // a technically valid MPEG-1 Layer I header, but it is also the UTF-16 LE
    // BOM; the sniffer deliberately excludes it so UTF-16 LE text does not
    // sniff as audio. Callers without a secondary modality gate must not see
    // audio/mpeg here.
    const utf16le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('h\0e\0l\0l\0o\0', 'latin1'),
    ]);
    expect(sniffMediaType(utf16le)).toBeNull();
    // Genuine frame syncs still detect.
    expect(sniffMediaType(Buffer.from([0xff, 0xfb, 0x90]))).toMatchObject({
      mimeType: 'audio/mpeg',
      modality: 'audio',
    });
    expect(sniffMediaType(Buffer.from([0xff, 0xf3, 0x00]))).toMatchObject({
      modality: 'audio',
    });
  });
});

describe('sniffFileModality', () => {
  it('reports the modality of a recognized media header', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-sniff-'));
    try {
      const video = path.join(dir, 'clip.mp4');
      await fs.writeFile(video, mp4Header('isom'));
      await expect(sniffFileModality(video)).resolves.toBe('video');

      const audio = path.join(dir, 'song.mp3');
      await fs.writeFile(audio, Buffer.from('ID3\0\0\0', 'latin1'));
      await expect(sniffFileModality(audio)).resolves.toBe('audio');

      const image = path.join(dir, 'pic.jpg');
      await fs.writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      await expect(sniffFileModality(image)).resolves.toBe('image');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for non-media content (legacy path keeps it)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-sniff-'));
    try {
      const text = path.join(dir, 'notes.txt');
      await fs.writeFile(text, 'just some text, definitely not media');
      await expect(sniffFileModality(text)).resolves.toBeNull();
      // Empty file: stat.size 0 → zero-length read, must not throw.
      const empty = path.join(dir, 'empty.bin');
      await fs.writeFile(empty, '');
      await expect(sniffFileModality(empty)).resolves.toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null (never throws) for an unreadable path', async () => {
    // The pre-gate must degrade to "not omni", not break the read.
    await expect(
      sniffFileModality(path.join(os.tmpdir(), 'omni-absent-xyz.mp4')),
    ).resolves.toBeNull();
  });

  it('returns the sniffed modality even when close() rejects (never throws)', async () => {
    // Network mounts can fail the final close() (EIO/ESTALE); the pre-gate's
    // never-throws contract must survive a rejecting close, not turn a
    // successful sniff into a crash.
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
