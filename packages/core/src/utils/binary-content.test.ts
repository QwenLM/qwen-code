/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extensionForMimeType,
  formatByteSize,
  isBinaryContentType,
  looksLikeText,
  persistBinaryContent,
  sniffFileKind,
} from './binary-content.js';

describe('isBinaryContentType', () => {
  it.each([
    ['text/html', false],
    ['text/plain; charset=utf-8', false],
    ['text/markdown', false],
    ['application/json', false],
    ['application/vnd.api+json', false],
    ['application/xml', false],
    ['image/svg+xml', false],
    ['application/javascript', false],
    ['application/x-www-form-urlencoded', false],
    ['application/yaml', false],
    ['application/x-yaml', false],
    ['application/x-ndjson', false],
    ['application/toml', false],
    ['application/json', false],
    ['', false],
    ['application/wasm', true],
    ['application/vnd.ms-powerpoint', true],
    ['application/x-tar', true],
    ['application/x-rar-compressed', true],
    ['application/vnd.rar', true],
    ['application/java-archive', true],
    ['font/woff2', true],
    ['application/pdf', true],
    ['application/zip', true],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
    ['application/octet-stream', true],
    ['image/png', true],
    ['audio/mpeg', true],
    ['video/mp4', true],
    ['application/vnd.oasis.opendocument.text', true],
  ])('%s → %s', (contentType, expected) => {
    expect(isBinaryContentType(contentType)).toBe(expected);
  });
});

describe('looksLikeText', () => {
  it('accepts printable UTF-8, rejects NUL bytes and invalid sequences', () => {
    expect(looksLikeText(Buffer.from('plain text\nwith 中文 too\n'))).toBe(
      true,
    );
    expect(looksLikeText(Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(looksLikeText(Buffer.alloc(64, 0x81))).toBe(false);
  });
});

describe('extensionForMimeType', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['application/pdf; charset=binary', 'pdf'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx',
    ],
    ['image/jpeg', 'jpg'],
    ['application/vnd.ms-powerpoint', 'ppt'],
    ['application/x-gzip', 'gz'],
    ['application/x-tar', 'tar'],
    ['application/x-7z-compressed', '7z'],
    ['application/vnd.rar', 'rar'],
    ['application/wasm', 'wasm'],
    ['application/octet-stream', 'bin'],
    ['who/knows', 'bin'],
    [undefined, 'bin'],
  ])('%s → %s', (mimeType, expected) => {
    expect(extensionForMimeType(mimeType)).toBe(expected);
  });
});

describe('persistBinaryContent', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-content-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes raw bytes with a mime-derived extension', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const result = await persistBinaryContent(
      bytes,
      'pdf',
      dir,
      'webfetch-test-1',
    );
    expect(result).toEqual({
      filepath: path.join(dir, 'webfetch-test-1.pdf'),
      size: bytes.length,
      ext: 'pdf',
    });
    expect(fs.readFileSync(path.join(dir, 'webfetch-test-1.pdf'))).toEqual(
      bytes,
    );
    // Owner-only: fetched content can be sensitive.
    expect(
      fs.statSync(path.join(dir, 'webfetch-test-1.pdf')).mode & 0o777,
    ).toBe(0o600);
  });

  it('creates the target directory when missing', async () => {
    const nested = path.join(dir, 'does', 'not', 'exist');
    const result = await persistBinaryContent(
      Buffer.from('x'),
      'bin',
      nested,
      'id',
    );
    expect('filepath' in result && result.filepath).toBe(
      path.join(nested, 'id.bin'),
    );
  });

  it('returns an error instead of throwing on unwritable paths', async () => {
    const filePath = path.join(dir, 'occupied');
    fs.writeFileSync(filePath, 'a plain file, not a directory');
    const result = await persistBinaryContent(
      Buffer.from('x'),
      'bin',
      filePath, // dir path collides with an existing file
      'id',
    );
    expect('error' in result).toBe(true);
  });
});

describe('formatByteSize', () => {
  it.each([
    [0, '0 bytes'],
    [512, '512 bytes'],
    [1024, '1KB'],
    [1536, '1.5KB'],
    [10 * 1024 * 1024, '10MB'],
    [3 * 1024 * 1024 * 1024, '3GB'],
  ])('%d → %s', (bytes, expected) => {
    expect(formatByteSize(bytes)).toBe(expected);
  });
});

describe('sniffFileKind', () => {
  const PDF = Buffer.from('%PDF-1.4 junk');
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const GZ = Buffer.from([0x1f, 0x8b, 0x08]);
  const TEXT = Buffer.from('plain old text');
  const URL = 'https://example.com/files/download';

  it('identifies PDFs by magic bytes regardless of content type', () => {
    const kind = sniffFileKind(PDF, 'application/octet-stream', '', URL);
    expect(kind).toEqual({
      extension: 'pdf',
      mimeType: 'application/pdf',
      magicMatched: true,
      extensionSource: 'magic',
    });
  });

  it('refines ZIP magic to office extensions via Content-Disposition', () => {
    const kind = sniffFileKind(
      ZIP,
      'application/octet-stream',
      'attachment; filename="report.xlsx"',
      URL,
    );
    expect(kind.extension).toBe('xlsx');
    expect(kind.magicMatched).toBe(true);
  });

  it('refines ZIP magic to office extensions via URL path', () => {
    const kind = sniffFileKind(
      ZIP,
      'application/octet-stream',
      '',
      'https://example.com/deck.pptx',
    );
    expect(kind.extension).toBe('pptx');
  });

  it('falls back to zip for unrefined ZIP containers', () => {
    expect(sniffFileKind(ZIP, '', '', URL).extension).toBe('zip');
  });

  it('refines ZIP magic via the declared Content-Type when names are generic', () => {
    const kind = sniffFileKind(
      ZIP,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '',
      URL, // generic /files/download — no useful extension
    );
    expect(kind.extension).toBe('xlsx');
  });

  it('reports how the extension was determined', () => {
    expect(
      sniffFileKind(TEXT, '', 'attachment; filename="fw.bin"', URL)
        .extensionSource,
    ).toBe('name');
    expect(
      sniffFileKind(TEXT, 'application/pdf', '', URL).extensionSource,
    ).toBe('mime');
    expect(sniffFileKind(TEXT, '', '', URL).extensionSource).toBe('fallback');
  });

  it('identifies gzip by magic bytes', () => {
    expect(sniffFileKind(GZ, '', '', URL).extension).toBe('gz');
  });

  it.each([
    // RAR4: Rar!\x1A\x07\x00
    [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x33])],
    // RAR5: Rar!\x1A\x07\x01\x00
    [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])],
  ])('identifies RAR archives by magic bytes', (bytes) => {
    const kind = sniffFileKind(bytes, 'application/octet-stream', '', URL);
    expect(kind).toEqual({
      extension: 'rar',
      mimeType: 'application/vnd.rar',
      magicMatched: true,
      extensionSource: 'magic',
    });
  });

  it('refines ZIP magic to jar via filename or Content-Type', () => {
    const byName = sniffFileKind(
      ZIP,
      'application/octet-stream',
      'attachment; filename="library.jar"',
      URL,
    );
    expect(byName.extension).toBe('jar');
    expect(byName.magicMatched).toBe(true);
    // Every real JAR carries ZIP magic, so the java-archive mime mapping
    // must survive the ZIP refinement rather than degrade to .zip.
    const byMime = sniffFileKind(ZIP, 'application/java-archive', '', URL);
    expect(byMime.extension).toBe('jar');
  });

  it.each([
    [
      Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from('PNG\r\n'),
        Buffer.from([0x1a, 0x0a]),
      ]),
      'png',
      'image/png',
    ],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'jpg', 'image/jpeg'],
    [Buffer.from('GIF89a....'), 'gif', 'image/gif'],
    [
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from('WEBPVP8 '),
      ]),
      'webp',
      'image/webp',
    ],
  ])('identifies image magic bytes → %s', (bytes, ext, mime) => {
    const kind = sniffFileKind(bytes as Buffer, '', '', URL);
    expect(kind.extension).toBe(ext);
    expect(kind.mimeType).toBe(mime);
    expect(kind.magicMatched).toBe(true);
  });

  it('uses RFC 5987 filename* when present', () => {
    const kind = sniffFileKind(
      TEXT,
      'application/octet-stream',
      "attachment; filename*=UTF-8''r13031cp.pdf",
      URL,
    );
    expect(kind.extension).toBe('pdf');
    expect(kind.magicMatched).toBe(false);
    // RFC 5987 allows a non-empty language tag between the quotes.
    expect(
      sniffFileKind(TEXT, '', "attachment; filename*=UTF-8'en'report.xlsx", URL)
        .extension,
    ).toBe('xlsx');
  });

  it('recognizes archive extensions from headerless URLs', () => {
    const kind = sniffFileKind(
      TEXT,
      '',
      '',
      'https://example.com/backup/archive.tar',
    );
    expect(kind.extension).toBe('tar');
    expect(kind.extensionSource).toBe('name');
  });

  it('uses the URL extension when headers say nothing', () => {
    const kind = sniffFileKind(
      TEXT,
      'application/octet-stream',
      '',
      'https://example.com/audio/track.mp3?sig=abc',
    );
    expect(kind.extension).toBe('mp3');
  });

  it('falls back to the content-type map, then bin', () => {
    expect(sniffFileKind(TEXT, 'application/pdf', '', URL).extension).toBe(
      'pdf',
    );
    expect(sniffFileKind(TEXT, 'who/knows', '', URL).extension).toBe('bin');
  });

  it('ignores unknown extensions in filenames', () => {
    const kind = sniffFileKind(
      TEXT,
      '',
      'attachment; filename="script.exe"',
      URL,
    );
    expect(kind.extension).toBe('bin');
  });
});
