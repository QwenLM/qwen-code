import { describe, expect, it, vi } from 'vitest';
import { encodeManagedInput, isManagedInput } from './managed-input';

describe('Managed composer input snapshots', () => {
  it('freezes UTF-8 Blob contents with text and images before a request can be persisted', async () => {
    const arrayBuffer = vi.fn(
      async () => new TextEncoder().encode('你好\ncontents').buffer,
    );
    const png = btoa('\x89PNG\r\n\x1a\n');
    const input = await encodeManagedInput(
      'Review',
      [{ data: png, media_type: 'image/png' }],
      [
        {
          name: 'notes.md',
          media_type: 'text/markdown',
          data: { size: 16, arrayBuffer } as Blob,
        },
      ],
    );
    expect(input).toEqual([
      { type: 'input_text', text: 'Review' },
      {
        type: 'input_file',
        name: 'notes.md',
        mime_type: 'text/markdown',
        text: '你好\ncontents',
      },
      { type: 'input_image', mime_type: 'image/png', data: png },
    ]);
    const replay: unknown = JSON.parse(JSON.stringify(input));
    expect(isManagedInput(replay)).toBe(true);
    expect(replay).toEqual(input);
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it('accepts a file-only draft and validates restored snapshots as strictly as fresh input', async () => {
    expect(
      await encodeManagedInput(
        '',
        [],
        [{ name: 'script.ts', media_type: '', text: 'const x = 1;' }],
      ),
    ).toEqual([
      {
        type: 'input_file',
        name: 'script.ts',
        mime_type: 'application/octet-stream',
        text: 'const x = 1;',
      },
    ]);
    expect(
      isManagedInput([
        {
          type: 'input_file',
          name: 'secret.pdf',
          mime_type: 'application/pdf',
          text: '%PDF',
        },
      ]),
    ).toBe(false);
    expect(
      isManagedInput([
        { type: 'input_text', text: 'hello', data: 'discarded' },
      ]),
    ).toBe(false);
    expect(
      isManagedInput([
        { type: 'input_image', mime_type: 'image/png', data: 'not-base64' },
      ]),
    ).toBe(false);
  });

  it('refuses binary, malformed UTF-8, empty and oversized files without a partial request', async () => {
    await expect(
      encodeManagedInput(
        '',
        [],
        [{ name: 'a.pdf', media_type: 'application/pdf', text: 'file' }],
      ),
    ).rejects.toThrow('UTF-8');
    await expect(
      encodeManagedInput(
        '',
        [],
        [{ name: 'a.txt', media_type: 'text/plain', text: '' }],
      ),
    ).rejects.toThrow();
    await expect(
      encodeManagedInput(
        '',
        [],
        [{ name: '../a.txt', media_type: 'text/plain', text: 'x' }],
      ),
    ).rejects.toThrow();
    await expect(
      encodeManagedInput(
        '',
        [],
        [
          {
            name: 'a.txt',
            media_type: 'text/plain',
            data: {
              size: 2,
              arrayBuffer: async () => new Uint8Array([255, 255]).buffer,
            } as Blob,
          },
        ],
      ),
    ).rejects.toThrow('not valid UTF-8');
    await expect(
      encodeManagedInput(
        'x'.repeat(49000),
        [],
        [{ name: 'a.txt', media_type: 'text/plain', text: 'x'.repeat(1000) }],
      ),
    ).rejects.toThrow('48 KiB');
  });
});
