import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  QQ_IMAGE_MAX_BYTES,
  QQ_VIDEO_MAX_BYTES,
  classifyQQAttachment,
  downloadQQAttachment,
} from './media.js';

const ALLOWED_URL = 'https://multimedia.nt.qq.com.cn/download?fileid=abc';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_BYTES = Buffer.from([0x47, 0x49, 0x46, 0x38]);
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);

function stubFetch(impl: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifyQQAttachment', () => {
  it.each([
    ['image/jpeg', 'image'],
    ['image/png', 'image'],
    ['image/gif', 'image'],
    ['video/mp4', 'video'],
  ])('classifies %s as %s', (contentType, expected) => {
    expect(classifyQQAttachment(contentType)).toBe(expected);
  });

  it.each(['voice', 'file', undefined])('ignores %s', (contentType) => {
    expect(classifyQQAttachment(contentType)).toBeUndefined();
  });
});

describe('downloadQQAttachment', () => {
  it('rejects a non-https URL before fetching', async () => {
    const fetchMock = stubFetch(() => new Response(PNG_BYTES));

    await expect(
      downloadQQAttachment(
        'http://multimedia.nt.qq.com.cn/download',
        QQ_IMAGE_MAX_BYTES,
      ),
    ).rejects.toThrow('must use https');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil.example.com/image.png',
    'https://evil-qq.com/image.png',
    'https://qq.com.evil.example/image.png',
    'https://multimedia.nt.qq.com.cn@evil.example/image.png',
    'https://multimedia.nt.qq.com.cn./image.png',
  ])('rejects the non-allowlisted host in %s', async (url) => {
    const fetchMock = stubFetch(() => new Response(PNG_BYTES));

    await expect(downloadQQAttachment(url, QQ_IMAGE_MAX_BYTES)).rejects.toThrow(
      'host not allowed',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts an uppercase allowlisted host', async () => {
    stubFetch(() => new Response(PNG_BYTES));

    const result = await downloadQQAttachment(
      'https://MULTIMEDIA.NT.QQ.COM.CN/download',
      QQ_IMAGE_MAX_BYTES,
    );

    expect(result.mimeType).toBe('image/png');
  });

  it('rejects a non-ok response with its status', async () => {
    stubFetch(() => new Response('nope', { status: 403 }));

    await expect(
      downloadQQAttachment(ALLOWED_URL, QQ_IMAGE_MAX_BYTES),
    ).rejects.toThrow('HTTP 403');
  });

  it('rejects a declared Content-Length over the cap', async () => {
    stubFetch(
      () => new Response(PNG_BYTES, { headers: { 'content-length': '9' } }),
    );

    await expect(downloadQQAttachment(ALLOWED_URL, 8)).rejects.toThrow(
      'declared size 9 exceeds 8 bytes',
    );
  });

  it('rejects a streamed body over the cap', async () => {
    stubFetch(() => new Response(Buffer.alloc(9)));

    await expect(downloadQQAttachment(ALLOWED_URL, 8)).rejects.toThrow(
      'size exceeds 8 bytes',
    );
  });

  it('returns the buffer and the sniffed image MIME', async () => {
    const fetchMock = stubFetch(
      () =>
        new Response(PNG_BYTES, {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    );

    const result = await downloadQQAttachment(ALLOWED_URL, QQ_IMAGE_MAX_BYTES);

    expect(result.buffer.equals(PNG_BYTES)).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(fetchMock).toHaveBeenCalledWith(
      ALLOWED_URL,
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it.each([
    ['image/jpeg', JPEG_BYTES],
    ['image/gif', GIF_BYTES],
  ])('sniffs %s from magic bytes', async (mimeType, bytes) => {
    stubFetch(() => new Response(bytes));

    const result = await downloadQQAttachment(ALLOWED_URL, QQ_IMAGE_MAX_BYTES);

    expect(result.mimeType).toBe(mimeType);
  });

  it('prefers the sniffed image MIME over the declared type', async () => {
    stubFetch(() => new Response(PNG_BYTES));

    const result = await downloadQQAttachment(
      ALLOWED_URL,
      QQ_IMAGE_MAX_BYTES,
      'image/jpeg',
    );

    expect(result.mimeType).toBe('image/png');
  });

  it('reports video/mp4 for the declared video type', async () => {
    stubFetch(() => new Response(MP4_BYTES));

    const result = await downloadQQAttachment(
      ALLOWED_URL,
      QQ_VIDEO_MAX_BYTES,
      'video/mp4',
    );

    expect(result.buffer.equals(MP4_BYTES)).toBe(true);
    expect(result.mimeType).toBe('video/mp4');
  });

  it('falls back to the declared image type for an unrecognized body', async () => {
    stubFetch(() => new Response(Buffer.from('not an image')));

    const result = await downloadQQAttachment(
      ALLOWED_URL,
      QQ_IMAGE_MAX_BYTES,
      'image/jpeg',
    );

    expect(result.mimeType).toBe('image/jpeg');
  });

  it('never labels an unrecognized body as video/mp4', async () => {
    stubFetch(() => new Response(Buffer.from('not an image')));

    const result = await downloadQQAttachment(ALLOWED_URL, QQ_VIDEO_MAX_BYTES);

    expect(result.mimeType).toBe('application/octet-stream');
  });
});
