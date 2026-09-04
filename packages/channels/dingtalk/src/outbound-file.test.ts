import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FILES_PER_RESPONSE,
  OutboundFileProjector,
  projectFileText,
  readValidatedFile,
  safeFileName,
  uploadDingTalkFile,
} from './outbound-file.js';

describe('OutboundFileProjector', () => {
  it('keeps every split of the reserved opening path-free', () => {
    const input = 'before\n[FILE: /workspace/report.txt]\nafter';
    for (let split = 0; split <= '[FILE:'.length; split++) {
      const projector = new OutboundFileProjector();
      const opening = input.indexOf('[FILE:');
      const chunks = [
        input.slice(0, opening + split),
        input.slice(opening + split),
      ];
      const safeChunks = chunks.map((chunk) => projector.append(chunk));
      const safe = safeChunks.join('') + projector.complete();
      expect(safeChunks[0]).not.toContain('/workspace/report.txt');
      expect(safeChunks[1]).not.toContain('/workspace/report.txt');
      expect(projector.result(safe)).toMatchObject({
        text: 'before\n\nafter',
        paths: ['/workspace/report.txt'],
      });
    }
  });

  it.each([
    {
      input: '[FILE: /tmp/a.txt]',
      text: '',
      paths: ['/tmp/a.txt'],
      invalidMarkers: 0,
    },
    {
      input: 'prefix [FILE: /tmp/a.txt] suffix\nnext',
      text: 'prefix \nnext',
      paths: [],
      invalidMarkers: 1,
    },
    {
      input: '[FILE:/tmp/a.txt]\nnext',
      text: '\nnext',
      paths: [],
      invalidMarkers: 1,
    },
    {
      input: '[FILE: /tmp/a.txt',
      text: '',
      paths: [],
      invalidMarkers: 1,
    },
  ])('projects $input without repairing it', ({ input, ...expected }) => {
    expect(projectFileText(input)).toMatchObject(expected);
  });

  it('does not rescan text joined by a redaction', () => {
    expect(projectFileText('[FI[FILE: /tmp/inner]\nLE: /tmp/outer]\n')).toEqual(
      {
        text: '[FI\nLE: /tmp/outer]\n',
        paths: [],
        invalidMarkers: 1,
        excessMarkers: 0,
        markerCount: 1,
      },
    );
  });

  it('bounds accepted paths and rejects oversized reserved lines', () => {
    const markers = Array.from(
      { length: MAX_FILES_PER_RESPONSE + 2 },
      (_, index) => `[FILE: /tmp/${index}.txt]`,
    ).join('\n');
    const projected = projectFileText(
      `${markers}\n[FILE: /${'x'.repeat(5000)}]`,
    );
    expect(projected.paths).toHaveLength(MAX_FILES_PER_RESPONSE);
    expect(projected.excessMarkers).toBe(2);
    expect(projected.invalidMarkers).toBe(1);
    expect(projected.text).not.toContain('/tmp/');
    expect(projected.text).not.toContain('x'.repeat(100));
  });
});

describe('outbound file validation and upload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a non-empty regular file under the workspace', () => {
    const workspace = process.cwd();
    const file = readValidatedFile(join(workspace, 'package.json'), workspace);
    expect(file).toMatchObject({
      fileName: 'package.json',
      fileType: 'json',
    });
    expect(file.data.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')(
    'reads a file from the POSIX /tmp directory',
    () => {
      const dir = mkdtempSync('/tmp/dingtalk-outbound-file-');
      const path = join(dir, '0902test.md');
      writeFileSync(path, 'caosini');
      try {
        expect(readValidatedFile(path, process.cwd())).toMatchObject({
          fileName: '0902test.md',
          fileType: 'md',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['relative path', 'report.txt', 'File path must be absolute'],
    ['outside root', process.execPath, 'outside allowed directories'],
  ])('rejects a %s', (_name, path, message) => {
    expect(() => readValidatedFile(path, tmpdir())).toThrow(message);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink that escapes an allowed directory',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dingtalk-file-symlink-'));
      const link = join(dir, 'outside');
      symlinkSync(process.execPath, link);
      try {
        expect(() => readValidatedFile(link, dir)).toThrow(
          'outside allowed directories',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('rejects empty, directory, and oversized files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-file-bounds-'));
    const empty = join(dir, 'empty.txt');
    const large = join(dir, 'large.bin');
    writeFileSync(empty, '');
    writeFileSync(large, 'x');
    truncateSync(large, 20 * 1024 * 1024 + 1);
    try {
      expect(() => readValidatedFile(empty, dir)).toThrow('File is empty');
      expect(() => readValidatedFile(dir, dir)).toThrow('Not a regular file');
      expect(() => readValidatedFile(large, dir)).toThrow('File is too large');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes file names used in receipts and payloads', () => {
    expect(safeFileName('/tmp/repor\nt].txt')).toBe('repor_t_.txt');
  });

  it('uploads as file media and returns the media id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ errcode: 0, media_id: '@file-id' })),
      );

    await expect(
      uploadDingTalkFile(
        { data: Buffer.from('x'), fileName: 'a.txt', fileType: 'txt' },
        'secret',
      ),
    ).resolves.toBe('@file-id');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('type=file');
  });

  it('redacts the access token from upload errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ errcode: 40014, errmsg: 'bad secret-token' }),
      ),
    );

    await expect(
      uploadDingTalkFile(
        { data: Buffer.from('x'), fileName: 'a.txt', fileType: 'txt' },
        'secret-token',
      ),
    ).rejects.toMatchObject({
      authFailure: true,
      message: expect.not.stringContaining('secret-token'),
    });
  });
});
