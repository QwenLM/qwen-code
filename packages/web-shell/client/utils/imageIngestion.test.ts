// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  extractImageTransfer,
  normalizeImageMediaType,
  readImageTransfer,
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
    const result = extractImageTransfer(
      transfer({
        files: [file],
        items: [{ kind: 'file', type: 'image/png', getAsFile }],
        types: ['Files'],
      }),
      'drop',
    );

    expect(result.claimed).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(getAsFile).not.toHaveBeenCalled();
  });

  it('claims unsupported file drops but leaves unsupported file pastes native', () => {
    const file = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const dataTransfer = transfer({ files: [file], types: ['Files'] });

    expect(extractImageTransfer(dataTransfer, 'drop')).toMatchObject({
      claimed: true,
      candidates: [],
      rejected: [{ name: 'notes.txt', reason: 'unsupported' }],
    });
    expect(extractImageTransfer(dataTransfer, 'paste').claimed).toBe(false);
  });

  it('claims a supported clipboard item that cannot expose its file', () => {
    const result = extractImageTransfer(
      transfer({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
        types: ['Files'],
      }),
      'paste',
    );

    expect(result).toMatchObject({
      claimed: true,
      candidates: [],
      rejected: [{ reason: 'unavailable' }],
    });
  });

  it('reads supported files in selection order and reports lifecycle settlement', async () => {
    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.bmp', { type: 'image/x-bmp' });
    const extracted = extractImageTransfer(
      transfer({ files: [first, second], types: ['Files'] }),
      'drop',
    );
    const created: FileReader[] = [];
    const settled: FileReader[] = [];

    const result = await readImageTransfer(extracted, {
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
    const extracted = extractImageTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );
    let activeReaders = 0;
    let maxActiveReaders = 0;

    const result = await readImageTransfer(extracted, {
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
    const extracted = extractImageTransfer(
      transfer({ files, types: ['Files'] }),
      'drop',
    );

    const result = await readImageTransfer(extracted, { maxEncodedBytes: 4 });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ name: 'two.png', reason: 'too-large' }]);
  });
});
