import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn<typeof fetch>(),
}));

vi.stubGlobal('fetch', mockFetch);

// Mock AbortSignal.timeout — our mock fetch doesn't actually use the signal,
// so returning a simple object is sufficient.
vi.stubGlobal(
  'AbortSignal',
  class {
    static timeout(_ms: number) {
      return { aborted: false } as AbortSignal;
    }
  },
);

const {
  QQ_FILE_TYPE,
  QQRichMediaError,
  fetchAccessToken,
  fetchGatewayUrl,
  getApiBase,
  parseQQErrorCode,
  requestQQApi,
  sendQQMessage,
  uploadQQRichMedia,
  validateGatewayUrl,
} = await import('./api.js');

function mockResponse(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    // body?.cancel() is a no-op in tests — fetchAccessToken now calls
    // resp.body?.cancel() in the error path to drain Undici connections.
    body: {
      cancel: async () => undefined,
    },
  } as unknown as Response;
}

describe('getApiBase', () => {
  it('returns production host when sandbox is false', () => {
    expect(getApiBase(false)).toBe('https://api.sgroup.qq.com');
  });

  it('returns sandbox host when sandbox is true', () => {
    expect(getApiBase(true)).toBe('https://sandbox.api.sgroup.qq.com');
  });
});

describe('sendQQMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(mockResponse(true, 200, ''));
  });

  it('sends POST with JSON body and correct headers', async () => {
    await sendQQMessage(
      'https://api.example.com',
      '/v2/users/abc/messages',
      'token-123',
      { content: 'hello', msg_type: 0 },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v2/users/abc/messages');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)?.['Content-Type']).toBe(
      'application/json',
    );
    expect((init?.headers as Record<string, string>)?.['Authorization']).toBe(
      'QQBot token-123',
    );
    expect(init?.body).toBe(JSON.stringify({ content: 'hello', msg_type: 0 }));
  });

  it('returns the fetch Response directly', async () => {
    const fake = mockResponse(true, 200, '');
    mockFetch.mockResolvedValue(fake);

    const resp = await sendQQMessage(
      'https://api.example.com',
      '/v2/groups/g123/messages',
      'tok',
      { content: 'hi', msg_type: 0 },
    );

    expect(resp).toBe(fake);
  });
});

describe('requestQQApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(mockResponse(true, 200, ''));
  });

  it('sends GET without a body or Content-Type', async () => {
    await requestQQApi(
      'https://api.example.com',
      'GET',
      '/v2/groups/g123/info',
      'tok',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v2/groups/g123/info');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(
      (init?.headers as Record<string, string>)?.['Content-Type'],
    ).toBeUndefined();
    expect((init?.headers as Record<string, string>)?.['Authorization']).toBe(
      'QQBot tok',
    );
  });

  it('sends DELETE for message recall without a body', async () => {
    await requestQQApi(
      'https://api.example.com',
      'DELETE',
      '/v2/groups/g123/messages/m456',
      'tok',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.example.com/v2/groups/g123/messages/m456');
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
  });

  it('returns the fetch Response directly', async () => {
    const fake = mockResponse(true, 200, '');
    mockFetch.mockResolvedValue(fake);

    const resp = await requestQQApi(
      'https://api.example.com',
      'GET',
      '/v2/groups/g123/status',
      'tok',
    );

    expect(resp).toBe(fake);
  });
});

describe('fetchAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns access token on success', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, {
        access_token: 'tok-abc',
        expires_in: 7200,
      }),
    );

    const result = await fetchAccessToken('app-id', 'secret');
    expect(result).toEqual({ accessToken: 'tok-abc', expiresIn: 7200 });
  });

  it('defaults expiresIn to 7200 when missing', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, { access_token: 'tok-no-exp' }),
    );

    const result = await fetchAccessToken('app-id', 'secret');
    expect(result).toEqual({ accessToken: 'tok-no-exp', expiresIn: 7200 });
  });

  it('throws on HTTP error with exact status-only message (no body leak)', async () => {
    mockFetch.mockResolvedValue(mockResponse(false, 401, 'unauthorized-body'));

    // Exact regex: the message must NOT contain the response body — a
    // regression that reintroduces `: ${body}` would fail this assertion.
    await expect(fetchAccessToken('bad', 'bad')).rejects.toThrow(
      /^QQ Bot token request failed \(HTTP 401\)$/,
    );
  });

  it('throws when response is missing access_token', async () => {
    mockFetch.mockResolvedValue(mockResponse(true, 200, { other: 'data' }));

    await expect(fetchAccessToken('app-id', 'secret')).rejects.toThrow(
      'QQ Bot token response missing access_token',
    );
  });

  it('sends appId and clientSecret in JSON body', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, {
        access_token: 'tok',
        expires_in: 3600,
      }),
    );

    await fetchAccessToken('my-app', 'my-secret');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://bots.qq.com/app/getAppAccessToken');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ appId: 'my-app', clientSecret: 'my-secret' });
  });
});

describe('fetchGatewayUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns WebSocket URL from production gateway', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, { url: 'wss://gateway.qq.com/ws' }),
    );

    const url = await fetchGatewayUrl('tok', false);
    expect(url).toBe('wss://gateway.qq.com/ws');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.sgroup.qq.com/gateway',
      expect.objectContaining({
        headers: { Authorization: 'QQBot tok' },
      }),
    );
  });

  it('uses sandbox gateway when sandbox is true', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, { url: 'wss://sandbox.gateway.qq.com/ws' }),
    );

    await fetchGatewayUrl('tok', true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://sandbox.api.sgroup.qq.com/gateway',
      expect.anything(),
    );
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValue(mockResponse(false, 500, 'server error'));

    await expect(fetchGatewayUrl('tok', false)).rejects.toThrow(
      'QQ Bot gateway request failed (HTTP 500)',
    );
  });

  it('throws when response is missing url field', async () => {
    mockFetch.mockResolvedValue(mockResponse(true, 200, {}));

    await expect(fetchGatewayUrl('tok', false)).rejects.toThrow(
      'QQ Bot gateway response missing WebSocket URL',
    );
  });
});

describe('validateGatewayUrl', () => {
  it('rejects https URLs', () => {
    expect(() => validateGatewayUrl('https://gateway.qq.com/ws')).toThrow(
      'wss://',
    );
  });

  it('rejects http URLs', () => {
    expect(() => validateGatewayUrl('http://gateway.qq.com/ws')).toThrow(
      'wss://',
    );
  });

  it('rejects ws URLs', () => {
    expect(() => validateGatewayUrl('ws://gateway.qq.com/ws')).toThrow(
      'wss://',
    );
  });

  it('accepts valid wss URL on *.qq.com', () => {
    const url = 'wss://api.sgroup.qq.com/ws';
    expect(validateGatewayUrl(url)).toBe(url);
  });

  it('accepts sandbox wss URL on *.qq.com', () => {
    const url = 'wss://sandbox.api.sgroup.qq.com/ws';
    expect(validateGatewayUrl(url)).toBe(url);
  });

  it('rejects *.tencentcs.com (attacker-controlled Tencent Cloud API Gateway)', () => {
    const url = 'wss://service-apigw.tencentcs.com/ws';
    expect(() => validateGatewayUrl(url)).toThrow('unexpected hostname');
  });

  it('rejects *.tencent.com (broad suffix)', () => {
    const url = 'wss://malicious.tencent.com/ws';
    expect(() => validateGatewayUrl(url)).toThrow('unexpected hostname');
  });

  it('rejects unknown hostname', () => {
    const url = 'wss://evil.example.com/ws';
    expect(() => validateGatewayUrl(url)).toThrow('unexpected hostname');
  });

  it('rejects invalid URLs', () => {
    expect(() => validateGatewayUrl('not a valid url')).toThrow(
      'not a valid URL',
    );
  });

  it('strips userinfo from valid wss URL with embedded credentials', () => {
    const url = 'wss://user:password@gateway.qq.com/ws';
    const result = validateGatewayUrl(url);
    expect(result).toBe('wss://gateway.qq.com/ws');
    expect(result).not.toContain('user');
    expect(result).not.toContain('password');
  });
});

describe('fetchGatewayUrl + validateGatewayUrl integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when API returns a non-wss URL (http://)', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, { url: 'http://gateway.qq.com/ws' }),
    );

    await expect(fetchGatewayUrl('tok', false)).rejects.toThrow('wss://');
  });

  it('rejects when API returns a non-wss URL (ws://)', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, { url: 'ws://gateway.qq.com/ws' }),
    );

    await expect(fetchGatewayUrl('tok', false)).rejects.toThrow('wss://');
  });

  it('rejects when API returns a *.tencentcs.com wss:// URL', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, {
        url: 'wss://bot-123.apigw.tencentcs.com/ws',
      }),
    );

    await expect(fetchGatewayUrl('tok', false)).rejects.toThrow(
      'unexpected hostname',
    );
  });

  it('rejects when API returns an invalid URL', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, { url: 'not a valid url' }),
    );

    await expect(fetchGatewayUrl('tok', false)).rejects.toThrow(
      'not a valid URL',
    );
  });

  it('accepts when API returns a valid wss:// URL', async () => {
    mockFetch.mockResolvedValue(
      mockResponse(true, 200, { url: 'wss://api.sgroup.qq.com/ws' }),
    );

    await expect(fetchGatewayUrl('tok', false)).resolves.toBe(
      'wss://api.sgroup.qq.com/ws',
    );
  });
});

describe('uploadQQRichMedia', () => {
  const bytes = Buffer.from('file body');
  const base = 'https://api.sgroup.qq.com';

  function upload(
    overrides: Partial<Parameters<typeof uploadQQRichMedia>[0]> = {},
  ) {
    return uploadQQRichMedia({
      base,
      accessToken: 'tok',
      scope: 'users',
      chatId: 'CHAT',
      fileName: 'report.txt',
      bytes,
      fileType: QQ_FILE_TYPE.file,
      ...overrides,
    });
  }

  function prepareBody(
    parts: Array<{ index: number; url: string; size: number }>,
  ) {
    return {
      upload_id: 'upload-1',
      block_size: 10485760,
      parts: parts.map((part) => ({
        index: part.index,
        presigned_url: part.url,
        block_size: part.size,
      })),
      upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
    };
  }

  beforeEach(() => {
    // clearAllMocks keeps queued mockResolvedValueOnce responses, so one failing
    // case would leak its queue into the next one; reset drops the queue.
    mockFetch.mockReset();
  });

  it.each([
    [QQ_FILE_TYPE.image, 1],
    [QQ_FILE_TYPE.video, 2],
    [QQ_FILE_TYPE.voice, 3],
    [QQ_FILE_TYPE.file, 4],
  ])(
    'sends file_type %i in both the prepare and the merge body',
    async (fileType, expected) => {
      mockFetch
        .mockResolvedValueOnce(
          mockResponse(
            true,
            200,
            prepareBody([
              { index: 1, url: 'https://cos.test/p1', size: bytes.length },
            ]),
          ),
        )
        .mockResolvedValueOnce(mockResponse(true, 200, ''))
        .mockResolvedValueOnce(mockResponse(true, 200, {}))
        .mockResolvedValueOnce(
          mockResponse(true, 200, { file_info: 'FILE-INFO', ttl: 0 }),
        );

      await upload({ fileType });

      expect(
        JSON.parse(String(mockFetch.mock.calls[0]![1]?.body)),
      ).toMatchObject({ file_type: expected });
      expect(
        JSON.parse(String(mockFetch.mock.calls[3]![1]?.body)),
      ).toMatchObject({ file_type: expected });
    },
  );

  it('walks prepare → PUT → part_finish → merge and returns the handle', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FILE-INFO', ttl: 86400 }),
      );

    await expect(upload()).resolves.toEqual({
      fileInfo: 'FILE-INFO',
      ttl: 86400,
    });

    expect(mockFetch).toHaveBeenCalledTimes(4);
    const [prepareUrl, prepareInit] = mockFetch.mock.calls[0]!;
    expect(prepareUrl).toBe(`${base}/v2/users/CHAT/upload_prepare`);
    expect(JSON.parse(String(prepareInit?.body))).toEqual({
      file_type: 4,
      file_size: String(bytes.length),
      file_name: 'report.txt',
      md5: expect.any(String),
      sha1: expect.any(String),
      md5_10m: expect.any(String),
    });

    const [partUrl, partInit] = mockFetch.mock.calls[1]!;
    expect(partUrl).toBe('https://cos.test/p1');
    expect(partInit?.method).toBe('PUT');
    // The presigned URL carries its own signature; the bot token must not leak
    // onto the COS request.
    expect(partInit?.headers).toBeUndefined();

    const [finishUrl, finishInit] = mockFetch.mock.calls[2]!;
    expect(finishUrl).toBe(`${base}/v2/users/CHAT/upload_part_finish`);
    expect(JSON.parse(String(finishInit?.body))).toEqual({
      upload_id: 'upload-1',
      part_index: 1,
      block_size: bytes.length,
      md5: expect.any(String),
    });

    const [mergeUrl, mergeInit] = mockFetch.mock.calls[3]!;
    expect(mergeUrl).toBe(`${base}/v2/users/CHAT/files`);
    expect(JSON.parse(String(mergeInit?.body))).toEqual({
      upload_id: 'upload-1',
      file_type: 4,
      file_name: 'report.txt',
      srv_send_msg: false,
    });
  });

  it('computes md5_10m over the first 10002432 bytes only', async () => {
    const big = Buffer.alloc(10002432 + 10, 7);
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: big.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await upload({ bytes: big });

    const body = JSON.parse(String(mockFetch.mock.calls[0]![1]?.body)) as {
      md5: string;
      md5_10m: string;
    };
    expect(body.md5_10m).not.toBe(body.md5);
    expect(body.md5_10m).toHaveLength(32);
  });

  it('retries the retryable 40093001 part_finish failure', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(
        mockResponse(false, 400, { code: 40093001, message: 'retry' }),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await expect(upload()).resolves.toEqual({ fileInfo: 'FI', ttl: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('splits parts by cumulative offsets and hashes each slice', async () => {
    const first = bytes.subarray(0, 4);
    const second = bytes.subarray(4);
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: first.length },
            { index: 2, url: 'https://cos.test/p2', size: second.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await upload();

    const secondPut = mockFetch.mock.calls[3]!;
    expect(secondPut[0]).toBe('https://cos.test/p2');
    expect(Buffer.from(secondPut[1]?.body as Uint8Array).toString()).toBe(
      second.toString(),
    );
    const firstFinish = JSON.parse(
      String(mockFetch.mock.calls[2]![1]?.body),
    ) as { md5: string; part_index: number };
    const secondFinish = JSON.parse(
      String(mockFetch.mock.calls[4]![1]?.body),
    ) as { md5: string; part_index: number };
    expect(firstFinish.part_index).toBe(1);
    expect(secondFinish.part_index).toBe(2);
    expect(firstFinish.md5).not.toBe(secondFinish.md5);
  });

  it('rejects when prepare returns no parts', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(true, 200, {
        upload_id: 'u',
        block_size: 10485760,
        parts: [],
      }),
    );

    await expect(upload()).rejects.toBeInstanceOf(QQRichMediaError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects when the parts do not cover the file', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([{ index: 1, url: 'https://cos.test/p1', size: 2 }]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}));

    await expect(upload()).rejects.toThrow(/cover 2 of 9 bytes/);
    // Nothing is merged when the split does not add up.
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects when the merge returns no file_info', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(mockResponse(true, 200, { ttl: 10 }));

    await expect(upload()).rejects.toThrow(/no file_info/);
  });

  it('carries the platform error code on a non-retryable failure', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(false, 400, { code: 850031, message: 'too large' }),
    );

    await expect(upload()).rejects.toMatchObject({
      stage: 'prepare',
      status: 400,
      code: 850031,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retryable merge failure', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(false, 400, { code: 40093002, message: 'quota' }),
      );

    await expect(upload()).rejects.toMatchObject({ code: 40093002 });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('retries upload_prepare on the retryable 40093001', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(false, 400, { code: 40093001, message: 'retry' }),
      )
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await expect(upload()).resolves.toEqual({ fileInfo: 'FI', ttl: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('retries upload_prepare on 850027', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(false, 400, { code: 850027, message: 'later' }),
      )
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await expect(upload()).resolves.toEqual({ fileInfo: 'FI', ttl: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('retries a part PUT rejected with 429', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(false, 429, 'slow down'))
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await expect(upload()).resolves.toEqual({ fileInfo: 'FI', ttl: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('retries a part PUT that fails at the transport', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await expect(upload()).resolves.toEqual({ fileInfo: 'FI', ttl: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('retries a part_finish rejected with 500', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse(
          true,
          200,
          prepareBody([
            { index: 1, url: 'https://cos.test/p1', size: bytes.length },
          ]),
        ),
      )
      .mockResolvedValueOnce(mockResponse(true, 200, ''))
      .mockResolvedValueOnce(mockResponse(false, 500, 'boom'))
      .mockResolvedValueOnce(mockResponse(true, 200, {}))
      .mockResolvedValueOnce(
        mockResponse(true, 200, { file_info: 'FI', ttl: 0 }),
      );

    await expect(upload()).resolves.toEqual({ fileInfo: 'FI', ttl: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

describe('parseQQErrorCode', () => {
  it('reads code and err_code', () => {
    expect(parseQQErrorCode('{"code":850031}')).toBe(850031);
    expect(parseQQErrorCode('{"err_code":40093001}')).toBe(40093001);
  });

  it('returns undefined for non-JSON and code-less bodies', () => {
    expect(parseQQErrorCode('boom')).toBeUndefined();
    expect(parseQQErrorCode('{"message":"x"}')).toBeUndefined();
  });
});
