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
  fetchAccessToken,
  fetchGatewayUrl,
  getApiBase,
  sendQQMessage,
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
