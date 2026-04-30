import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetGlobalDispatcher = vi.hoisted(() => vi.fn());
const mockProxyAgent = vi.hoisted(() =>
  vi.fn((url: string) => ({ proxyUrl: url })),
);

vi.mock('undici', () => ({
  ProxyAgent: mockProxyAgent,
  setGlobalDispatcher: mockSetGlobalDispatcher,
}));

import { resolveProxy } from './start.js';

describe('resolveProxy', () => {
  beforeEach(() => {
    mockSetGlobalDispatcher.mockClear();
    mockProxyAgent.mockClear();
    delete process.env['HTTPS_PROXY'];
    delete process.env['https_proxy'];
    delete process.env['HTTP_PROXY'];
    delete process.env['http_proxy'];
  });

  it('prefers the CLI proxy over settings and environment proxies', () => {
    process.env['HTTPS_PROXY'] = 'http://env.example.com:8080';

    const proxy = resolveProxy(
      'http://cli.example.com:8080',
      'http://settings.example.com:8080',
    );

    expect(proxy).toBe('http://cli.example.com:8080');
    expect(mockProxyAgent).toHaveBeenCalledWith('http://cli.example.com:8080');
    expect(mockSetGlobalDispatcher).toHaveBeenCalledWith({
      proxyUrl: 'http://cli.example.com:8080',
    });
  });

  it('prefers settings.proxy over environment proxies', () => {
    process.env['HTTPS_PROXY'] = 'http://env.example.com:8080';

    const proxy = resolveProxy(undefined, 'http://settings.example.com:8080');

    expect(proxy).toBe('http://settings.example.com:8080');
    expect(mockProxyAgent).toHaveBeenCalledWith(
      'http://settings.example.com:8080',
    );
  });

  it('falls back to proxy environment variables', () => {
    process.env['HTTP_PROXY'] = 'http://env.example.com:8080';

    const proxy = resolveProxy();

    expect(proxy).toBe('http://env.example.com:8080');
    expect(mockProxyAgent).toHaveBeenCalledWith('http://env.example.com:8080');
  });
});
