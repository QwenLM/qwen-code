import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUpdates, uploadToCdn } from './api.js';

describe('getUpdates', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves message IDs larger than Number.MAX_SAFE_INTEGER', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            '{"ret":0,"msgs":[{"message_id":7489534892789344264,"message_type":1}]}',
            { status: 200 },
          ),
        ),
    );

    const result = await getUpdates('https://ilink.example', 'token', '');

    expect(result.msgs?.[0]?.message_id).toBe('7489534892789344264');
    expect(result.ret).toBe(0);
  });
});

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
