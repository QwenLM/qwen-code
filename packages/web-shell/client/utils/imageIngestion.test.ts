// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  dedupeAttachmentName,
  extractFileTransfer,
  normalizeImageMediaType,
  normalizeTextMediaType,
  readImageTransfer,
  readFileTransfer,
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

  it('accepts arbitrary files for both drops and pastes', () => {
    const file = new File(['zip'], 'archive.zip', { type: 'application/zip' });
    const dataTransfer = transfer({ files: [file], types: ['Files'] });

    expect(extractFileTransfer(dataTransfer, 'drop')).toMatchObject({
      claimed: true,
      imageCandidates: [],
      fileCandidates: [{ file, mediaType: 'application/zip' }],
      rejected: [],
    });
    expect(extractFileTransfer(dataTransfer, 'paste').claimed).toBe(true);
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

  it('applies the size limit to each image independently', async () => {
    const files = [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['toolarge'], 'two.png', { type: 'image/png' }),
    ];
    const extracted = extractFileTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );

    const result = await readImageTransfer(extracted.imageCandidates, {
      maxBytes: 4,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ name: 'two.png', reason: 'too-large' }]);
  });

  it('does not share one image size budget across a batch', async () => {
    const files = [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ];
    const extracted = extractFileTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );

    const result = await readImageTransfer(extracted.imageCandidates, {
      maxBytes: 4,
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
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

  it('classifies images separately and accepts every other file', () => {
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
    expect(result.fileCandidates.map((c) => c.file.name)).toEqual([
      'app.log',
      'archive.zip',
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('claims a text file paste', () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const result = extractFileTransfer(
      transfer({ files: [file], types: ['Files'] }),
      'paste',
    );

    expect(result.claimed).toBe(true);
    expect(result.fileCandidates).toHaveLength(1);
  });

  it('keeps original file bytes and size', async () => {
    const file = new File(['line1\nline2'], 'app.log', { type: 'text/plain' });
    const extracted = extractFileTransfer(
      transfer({ files: [file], types: ['Files'] }),
      'drop',
    );

    const result = await readFileTransfer(extracted.fileCandidates);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([
      {
        name: 'app.log',
        media_type: 'text/plain',
        data: file,
        size: file.size,
      },
    ]);
  });

  it('keeps binary files without decoding them as text', async () => {
    const binary = new File([new Uint8Array([0x89, 0x00, 0x50])], 'fake.log', {
      type: 'text/plain',
    });
    const extracted = extractFileTransfer(
      transfer({ files: [binary], types: ['Files'] }),
      'drop',
    );

    const result = await readFileTransfer(extracted.fileCandidates);

    expect(result.accepted).toEqual([
      {
        name: 'fake.log',
        media_type: 'text/plain',
        data: binary,
        size: binary.size,
      },
    ]);
    expect(result.rejected).toEqual([]);
  });

  it('avoids image extensions for files with non-image content types', async () => {
    const file = new File(['not an image'], 'notes.png', {
      type: 'text/plain',
    });
    const extracted = extractFileTransfer(
      transfer({ files: [file], types: ['Files'] }),
      'drop',
    );

    const result = await readFileTransfer(extracted.fileCandidates);

    expect(result.accepted[0]?.name).toBe('notes.png.file');
  });

  it.each([
    ['notes.png.', 'application/pdf'],
    [`${'a'.repeat(250)}.png`, 'application/pdf'],
    ['anim.png', 'image/apng'],
  ])('shields misleading image name %s with MIME %s', async (name, type) => {
    const file = new File(['data'], name, { type });
    const extracted = extractFileTransfer(
      transfer({ files: [file], types: ['Files'] }),
      'drop',
    );

    const result = await readFileTransfer(extracted.fileCandidates);

    expect(result.accepted[0]?.name.endsWith('.file')).toBe(true);
    expect(
      new TextEncoder().encode(result.accepted[0]?.name).byteLength,
    ).toBeLessThanOrEqual(255);
    expect(result.accepted[0]?.media_type).toBe(type);
  });

  it('normalizes image/jpg before reading an image', async () => {
    const file = new File(['jpeg'], 'photo.jpg', { type: 'image/jpg' });
    const extracted = extractFileTransfer(
      transfer({ files: [file], types: ['Files'] }),
      'drop',
    );

    const result = await readImageTransfer(extracted.imageCandidates);

    expect(result.accepted).toEqual([
      { data: 'anBlZw==', media_type: 'image/jpeg' },
    ]);
  });

  it('applies the size limit to each text file independently', async () => {
    const files = [
      new File(['one'], 'one.log', { type: 'text/plain' }),
      new File(['four'], 'two.log', { type: 'text/plain' }),
    ];
    const extracted = extractFileTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );

    const result = await readFileTransfer(extracted.fileCandidates, {
      maxBytes: 3,
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
      maxBytes: 4,
    });
    const fileResult = await readFileTransfer(extracted.fileCandidates, {
      maxBytes: 3,
    });

    expect(imageResult.accepted).toHaveLength(1);
    expect(fileResult.accepted).toHaveLength(1);
  });
});

describe('attachment naming', () => {
  it('keeps display characters and strips paths and controls', () => {
    expect(sanitizeAttachmentName('my log(1).log')).toBe('my log(1).log');
    expect(sanitizeAttachmentName('a,b;c.txt')).toBe('a,b;c.txt');
    expect(sanitizeAttachmentName('../weird\nname.log')).toBe('weirdname.log');
    expect(sanitizeAttachmentName('budget 🚀 report.png')).toBe(
      'budget 🚀 report.png',
    );
    expect(sanitizeAttachmentName('bad\ud800name.txt')).toBe('badname.txt');
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

  it('normalizes names rejected by the daemon', () => {
    expect(sanitizeAttachmentName('report?.txt. ')).toBe('report_.txt');
    expect(sanitizeAttachmentName('CON.txt')).toBe('_CON.txt');
    expect(
      new TextEncoder().encode(sanitizeAttachmentName('一'.repeat(100)))
        .byteLength,
    ).toBeLessThanOrEqual(255);
  });

  it('dedupes against taken names with a numeric suffix', () => {
    const taken = new Set(['app.log', 'app (1).log']);
    expect(dedupeAttachmentName('app.log', taken)).toBe('app (2).log');
    expect(dedupeAttachmentName('other.log', taken)).toBe('other.log');
  });

  it('keeps deduplicated names within the daemon byte limit', () => {
    const name = `${'一'.repeat(83)}.txt`;
    const candidate = dedupeAttachmentName(name, new Set([name]));

    expect(candidate).toMatch(/ \(1\)\.txt$/);
    expect(new TextEncoder().encode(candidate).byteLength).toBeLessThanOrEqual(
      255,
    );
  });
});
