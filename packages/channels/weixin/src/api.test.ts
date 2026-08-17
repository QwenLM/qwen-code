import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUpdates, quoteUnsafeIntegerLiterals, uploadToCdn } from './api.js';

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

describe('quoteUnsafeIntegerLiterals', () => {
  it('quotes integers above Number.MAX_SAFE_INTEGER', () => {
    expect(quoteUnsafeIntegerLiterals('{"message_id": 9007199254740993}')).toBe(
      '{"message_id": "9007199254740993"}',
    );
  });

  it('quotes negative integers beyond the safe range', () => {
    expect(quoteUnsafeIntegerLiterals('[-9007199254740993]')).toBe(
      '["-9007199254740993"]',
    );
  });

  it('leaves safe integers untouched, including the boundary value', () => {
    const raw = '{"ret": 0, "seq": 42, "max": 9007199254740991}';
    expect(quoteUnsafeIntegerLiterals(raw)).toBe(raw);
  });

  it('quotes MAX_SAFE_INTEGER + 1, which native parsing cannot distinguish', () => {
    expect(quoteUnsafeIntegerLiterals('[9007199254740992]')).toBe(
      '["9007199254740992"]',
    );
  });

  it('leaves fractional and exponent numbers untouched', () => {
    const raw = '{"a": 1.5, "b": 9007199254740993.5, "c": 1e21, "d": -2.5e-3}';
    expect(quoteUnsafeIntegerLiterals(raw)).toBe(raw);
  });

  it('does not touch digit sequences inside string values', () => {
    const raw = '{"text": "id 9007199254740993 stays", "n": 9007199254740993}';
    expect(quoteUnsafeIntegerLiterals(raw)).toBe(
      '{"text": "id 9007199254740993 stays", "n": "9007199254740993"}',
    );
  });

  it('tracks escaped quotes inside strings', () => {
    const raw = '{"text": "say \\" then 9007199254740993", "n": 1}';
    expect(quoteUnsafeIntegerLiterals(raw)).toBe(raw);
  });

  it('handles large integers nested in arrays and leading zeros', () => {
    expect(
      quoteUnsafeIntegerLiterals(
        '{"ids": [1, 18446744073709551615], "z": 007}',
      ),
    ).toBe('{"ids": [1, "18446744073709551615"], "z": 007}');
  });
});

describe('getUpdates large message IDs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves message_id values above the safe integer limit as exact strings', async () => {
    const rawBody =
      '{"ret": 0, "msgs": [' +
      '{"message_id": 9007199254740993, "message_type": 1, "create_time_ms": 1755400000000},' +
      '{"message_id": 123, "message_type": 1}' +
      '], "get_updates_buf": "cursor-1", "longpolling_timeout_ms": 40000}';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => rawBody,
    });
    vi.stubGlobal('fetch', fetchMock);

    const resp = await getUpdates('https://ilink.example', 'token', 'cursor-0');

    expect(resp.msgs?.[0]?.message_id).toBe('9007199254740993');
    // Safe-range numerics keep their native representation.
    expect(resp.msgs?.[1]?.message_id).toBe(123);
    expect(resp.ret).toBe(0);
    expect(resp.get_updates_buf).toBe('cursor-1');
    expect(resp.longpolling_timeout_ms).toBe(40000);
    expect(resp.msgs?.[0]?.create_time_ms).toBe(1755400000000);
  });
});
