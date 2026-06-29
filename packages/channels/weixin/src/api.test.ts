import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadToCdn } from './api.js';

describe('uploadToCdn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'HTTPS://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=abc',
    'HtTpS://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=abc',
  ])('accepts %s CDN upload URLs', async (uploadUrl) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: vi.fn((name: string) =>
          name.toLowerCase() === 'x-encrypted-param' ? 'cdn-param' : null,
        ),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadToCdn(uploadUrl, 'filekey-123', Buffer.from('encrypted')),
    ).resolves.toBe('cdn-param');

    expect(fetchMock).toHaveBeenCalledWith(
      uploadUrl,
      expect.objectContaining({
        method: 'POST',
        body: Buffer.from('encrypted'),
      }),
    );
  });

  it('rejects uppercase HTTP CDN upload URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      uploadToCdn(
        'HTTP://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=abc',
        'filekey-123',
        Buffer.from('encrypted'),
      ),
    ).rejects.toThrow('CDN upload URL must use HTTPS');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
