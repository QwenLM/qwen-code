// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  dedupeAttachmentName,
  extractFileTransfer,
  normalizeImageMediaType,
  normalizeTextMediaType,
  readImageTransfer,
  readTextTransfer,
  sanitizeAttachmentName,
} from './imageIngestion';

function transfer({
  files = [],
  items = [],
  types = [],
}: {
  files?: File[];
  items?: Array<{
    kind: string;
    type: string;
    getAsFile: () => File | null;
  }>;
  types?: string[];
}): DataTransfer {
  return { files, items, types } as unknown as DataTransfer;
}

describe('image ingestion', () => {
  it.each([
    ['image/png', 'photo.bin', 'image/png'],
    ['IMAGE/JPEG', 'photo.bin', 'image/jpeg'],
    ['image/x-bmp', 'photo.bin', 'image/bmp'],
    ['image/x-ms-bmp', 'photo.bin', 'image/bmp'],
    ['', 'photo.BMP', 'image/bmp'],
    ['application/octet-stream', 'photo.webp', 'image/webp'],
    ['text/plain', 'photo.png', undefined],
    ['', 'photo.svg', undefined],
  ])('normalizes %s and %s', (type, name, expected) => {
    expect(normalizeImageMediaType(type, name)).toBe(expected);
  });

  it('uses files as the authoritative source without duplicating item files', () => {
    const file = new File(['png'], 'photo.png', { type: 'image/png' });
    const getAsFile = vi.fn(() => file);
    const result = extractFileTransfer(
      transfer({
        files: [file],
        items: [{ kind: 'file', type: 'image/png', getAsFile }],
        types: ['Files'],
      }),
      'drop',
    );

    expect(result.claimed).toBe(true);
    expect(result.imageCandidates).toHaveLength(1);
    expect(getAsFile).not.toHaveBeenCalled();
  });

  it('claims unsupported file drops but leaves unsupported file pastes native', () => {
    const file = new File(['zip'], 'archive.zip', { type: 'application/zip' });
    const dataTransfer = transfer({ files: [file], types: ['Files'] });

    expect(extractFileTransfer(dataTransfer, 'drop')).toMatchObject({
      claimed: true,
      imageCandidates: [],
      textCandidates: [],
      rejected: [{ name: 'archive.zip', reason: 'unsupported' }],
    });
    expect(extractFileTransfer(dataTransfer, 'paste').claimed).toBe(false);
  });

  it('claims a supported clipboard item that cannot expose its file', () => {
    const result = extractFileTransfer(
      transfer({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
        types: ['Files'],
      }),
      'paste',
    );

    expect(result).toMatchObject({
      claimed: true,
      imageCandidates: [],
      rejected: [{ reason: 'unavailable' }],
    });
  });

  it('reads supported files in selection order and reports lifecycle settlement', async () => {
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.bmp', { type: 'image/x-bmp' });
    const extracted = extractFileTransfer(
      transfer({ files: [first, second], types: ['Files'] }),
      'drop',
    );
    const created: FileReader[] = [];
    const settled: FileReader[] = [];

    const result = await readImageTransfer(extracted.imageCandidates, {
      onReaderCreated: (reader) => created.push(reader),
      onReaderSettled: (reader) => settled.push(reader),
    });

    expect(result.rejected).toEqual([]);
    expect(result.accepted.map((image) => image.media_type)).toEqual([
      'image/png',
      'image/bmp',
    ]);
    expect(result.accepted.map((image) => atob(image.data))).toEqual([
      'first',
      'second',
    ]);
    expect(created).toHaveLength(2);
    expect(new Set(settled)).toEqual(new Set(created));
  });

  it('limits concurrent file readers', async () => {
    const files = Array.from(
      { length: 10 },
      (_, index) =>
        new File([`image-${index}`], `${index}.png`, { type: 'image/png' }),
    );
    const extracted = extractFileTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );
    let activeReaders = 0;
    let maxActiveReaders = 0;

    const result = await readImageTransfer(extracted.imageCandidates, {
      onReaderCreated: () => {
        activeReaders += 1;
        maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
      },
      onReaderSettled: () => {
        activeReaders -= 1;
      },
    });

    expect(result.accepted).toHaveLength(10);
    expect(maxActiveReaders).toBe(4);
  });

  it('rejects files that exceed the remaining encoded-data budget', async () => {
    const files = [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ];
    const extracted = extractFileTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );

    const result = await readImageTransfer(extracted.imageCandidates, {
      maxEncodedBytes: 4,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ name: 'two.png', reason: 'too-large' }]);
  });
});

describe('text file ingestion', () => {
  it.each([
    ['text/plain', 'app.bin', 'text/plain'],
    ['text/markdown', 'README.md', 'text/markdown'],
    ['application/json', 'data.bin', 'application/json'],
    ['application/yaml', 'cfg.bin', 'application/yaml'],
    ['', 'app.LOG', 'text/plain'],
    ['application/octet-stream', 'notes.md', 'text/plain'],
    ['application/octet-stream', 'script.sh', 'text/plain'],
    ['application/pdf', 'doc.pdf', undefined],
    ['', 'archive.zip', undefined],
    ['image/png', 'photo.png', undefined],
  ])('normalizes %s and %s to %s', (type, name, expected) => {
    expect(normalizeTextMediaType(type, name)).toBe(expected);
  });

  it.each([
    ['video/mp2t', 'foo.ts'],
    ['video/mp2t', 'clip.mts'],
    ['application/vnd.ms-excel', 'data.csv'],
    ['application/vnd.ms-excel', 'data.tsv'],
    ['application/octet-stream', 'notes.json'],
  ])(
    'extension allowlist wins over conflicting MIME %s for %s',
    (type, name) => {
      expect(normalizeTextMediaType(type, name)).toBe('text/plain');
    },
  );

  it.each(['Dockerfile', 'Makefile', 'LICENSE', 'Gemfile', 'Procfile'])(
    'accepts extensionless plain-text name %s',
    (name) => {
      expect(normalizeTextMediaType('', name)).toBe('text/plain');
      expect(normalizeTextMediaType('application/octet-stream', name)).toBe(
        'text/plain',
      );
    },
  );

  it('still rejects conflicting MIME for unlisted extensions', () => {
    expect(
      normalizeTextMediaType('application/pdf', 'doc.pdf'),
    ).toBeUndefined();
    expect(normalizeTextMediaType('image/gif', 'anim.gif')).toBeUndefined();
  });

  it('classifies mixed drops into image and text candidates', () => {
    const image = new File(['png'], 'photo.png', { type: 'image/png' });
    const log = new File(['log'], 'app.log', { type: '' });
    const zip = new File(['zip'], 'archive.zip', { type: 'application/zip' });
    const result = extractFileTransfer(
      transfer({ files: [image, log, zip], types: ['Files'] }),
      'drop',
    );

    expect(result.claimed).toBe(true);
    expect(result.imageCandidates.map((c) => c.file.name)).toEqual([
      'photo.png',
    ]);
    expect(result.textCandidates.map((c) => c.file.name)).toEqual(['app.log']);
    expect(result.rejected).toEqual([
      { name: 'archive.zip', reason: 'unsupported' },
    ]);
  });

  it('claims a text file paste', () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const result = extractFileTransfer(
      transfer({ files: [file], types: ['Files'] }),
      'paste',
    );

    expect(result.claimed).toBe(true);
    expect(result.textCandidates).toHaveLength(1);
  });

  it('reads text files with their content and size', async () => {
    const file = new File(['line1\nline2'], 'app.log', { type: 'text/plain' });
    const extracted = extractFileTransfer(
      transfer({ files: [file], types: ['Files'] }),
      'drop',
    );

    const result = await readTextTransfer(extracted.textCandidates);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      {
        name: 'app.log',
        media_type: 'text/plain',
        text: 'line1\nline2',
        size: file.size,
      },
    ]);
  });

  it('rejects files whose decoded content contains NUL bytes', async () => {
    const binary = new File([new Uint8Array([0x89, 0x00, 0x50])], 'fake.log', {
      type: 'text/plain',
    });
    const extracted = extractFileTransfer(
      transfer({ files: [binary], types: ['Files'] }),
      'drop',
    );

    const result = await readTextTransfer(extracted.textCandidates);

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { name: 'fake.log', reason: 'unsupported' },
    ]);
  });

  it('rejects text files that exceed the remaining size budget', async () => {
    const files = [
      new File(['one'], 'one.log', { type: 'text/plain' }),
      new File(['two'], 'two.log', { type: 'text/plain' }),
    ];
    const extracted = extractFileTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );

    const result = await readTextTransfer(extracted.textCandidates, {
      maxEncodedBytes: 3,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ name: 'two.log', reason: 'too-large' }]);
  });

  it('keeps image and text budgets independent', async () => {
    const image = new File(['png'], 'photo.png', { type: 'image/png' });
    const log = new File(['log'], 'app.log', { type: 'text/plain' });
    const extracted = extractFileTransfer(
      transfer({ files: [image, log], types: ['Files'] }),
      'drop',
    );

    const imageResult = await readImageTransfer(extracted.imageCandidates, {
      maxEncodedBytes: 4,
    });
    const textResult = await readTextTransfer(extracted.textCandidates, {
      maxEncodedBytes: 3,
    });

    expect(imageResult.accepted).toHaveLength(1);
    expect(textResult.accepted).toHaveLength(1);
  });
});

describe('attachment naming', () => {
  it('replaces token-unsafe characters and strips control characters', () => {
    expect(sanitizeAttachmentName('my log(1).log')).toBe('my_log_1_.log');
    expect(sanitizeAttachmentName('a,b;c.txt')).toBe('a_b_c.txt');
    expect(sanitizeAttachmentName('weird\nname.log')).toBe('weird_name.log');
  });

  it('falls back for names that sanitize to nothing', () => {
    expect(sanitizeAttachmentName('')).toBe('attachment');
    expect(sanitizeAttachmentName('   ')).toBe('attachment');
  });

  it('strips invisible bidi and zero-width format characters', () => {
    expect(sanitizeAttachmentName('app\u202e.log')).toBe('app.log');
    expect(sanitizeAttachmentName('sec\u200bret.log')).toBe('secret.log');
    expect(sanitizeAttachmentName('a\u2066b\u2069.log')).toBe('ab.log');
  });

  it('dedupes against taken names with a numeric suffix', () => {
    const taken = new Set(['app.log', 'app.log-2']);
    expect(dedupeAttachmentName('app.log', taken)).toBe('app.log-3');
    expect(dedupeAttachmentName('other.log', taken)).toBe('other.log');
  });
});
