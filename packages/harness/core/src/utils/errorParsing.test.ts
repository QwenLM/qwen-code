/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  CONNECTION_INTERRUPTED_MESSAGE,
  formatApiErrorDisplayMessage,
  getApiErrorDisplayMetadata,
  parseAndFormatApiError,
  parseAndFormatApiErrorMessage,
} from './errorParsing.js';
import { AuthType } from '@qwen-code/resource';
import type { StructuredError } from '../core/turn-events.js';
import { BRAND_CLI_BIN } from '../config/brand.js';

const mocks = vi.hoisted(() => ({
  getErrorCodeMessage: vi.fn(
    (_code: string | number | undefined, defaultMessage = '') => defaultMessage,
  ),
}));

vi.mock('../i18n/index.js', () => ({
  getI18nService: () => ({
    get: (key: string, params?: { message?: string }) =>
      mocks.getErrorCodeMessage(
        key.replace(/^error\.code\./, ''),
        params?.message,
      ),
  }),
}));

describe('parseAndFormatApiError', () => {
  it.each(['EDQUOT', 'ENOSPC'])(
    '文件系统错误 %s 展示存储提示并保留错误分类元数据',
    (code) => {
      const error = Object.assign(new Error(`${code}: write failed, write`), {
        code,
      });
      const metadata = getApiErrorDisplayMetadata(error);
      expect(metadata?.displayErrorCode).toBe('storage_insufficient');
      expect(parseAndFormatApiError(error)).toBe(metadata?.fallbackMessage);
      expect(parseAndFormatApiErrorMessage(error)).toBe(
        metadata?.fallbackMessage,
      );
      expect(parseAndFormatApiError(error)).not.toContain('API Error');
    },
  );
  it.each([
    ['EACCES', 'filesystem_access_denied'],
    ['EPERM', 'filesystem_access_denied'],
    ['EROFS', 'filesystem_access_denied'],
    ['EMFILE', 'open_files_limit_reached'],
    ['ENFILE', 'open_files_limit_reached'],
    ['EIO', 'filesystem_io_failed'],
    ['ESTALE', 'filesystem_io_failed'],
    ['ENOMEM', 'memory_insufficient'],
    ['EBUSY', 'filesystem_busy'],
    ['ETXTBSY', 'filesystem_busy'],
  ])('系统错误 %s 的解析提示和元数据使用同一分类', (code, expected) => {
    const error = Object.assign(
      new Error(`${code}: operation failed, open '/private/session'`),
      { code, syscall: 'open' },
    );
    const metadata = getApiErrorDisplayMetadata(error);
    expect(metadata?.displayErrorCode).toBe(expected);
    expect(parseAndFormatApiError(error)).toBe(metadata?.fallbackMessage);
    expect(parseAndFormatApiErrorMessage(error.message)).toBe(
      metadata?.fallbackMessage,
    );
  });
  it('错误对象的文件监听信息不能在递归解析文本时丢失', () => {
    const error = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
      syscall: 'watch',
    });
    expect(getApiErrorDisplayMetadata(error)?.displayErrorCode).not.toBe(
      'storage_insufficient',
    );
    expect(parseAndFormatApiError(error)).toBe(
      '[API Error: ENOSPC: no space left on device]',
    );
  });
  const rateLimitFallbackMessage =
    'Possible quota limitations in place or slow response times detected. Switching to the lite model';

  beforeEach(() => {
    mocks.getErrorCodeMessage.mockReset();
    mocks.getErrorCodeMessage.mockImplementation(
      (_code: string | number | undefined, defaultMessage = '') =>
        defaultMessage,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses a nonempty fallback when dynamic error text is blank', () => {
    mocks.getErrorCodeMessage.mockReturnValueOnce('  ');
    expect(formatApiErrorDisplayMessage(500, 'Readable fallback')).toBe(
      'Readable fallback',
    );
    expect(formatApiErrorDisplayMessage(undefined, '  ')).toBe(
      'The request could not be completed. Please try again.',
    );
  });

  it('should format a valid API error JSON', () => {
    const errorMessage =
      'got status: 400 Bad Request. {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}';
    const expected =
      '[API Error: API key not valid. Please pass a valid API key. (Status: INVALID_ARGUMENT)]';
    expect(parseAndFormatApiError(errorMessage)).toBe(expected);
  });

  it('should format a 429 API error with the default message', () => {
    const errorMessage =
      'got status: 429 Too Many Requests. {"error":{"code":429,"message":"Rate limit exceeded","status":"RESOURCE_EXHAUSTED"}}';
    const result = parseAndFormatApiError(errorMessage, undefined, 'lite');
    expect(result).toContain('[API Error: Rate limit exceeded');
    expect(result).toContain(
      'Possible quota limitations in place or slow response times detected. Switching to the lite model',
    );
  });

  it('should format a 429 API error with the fallback message for PAT auth', () => {
    const errorMessage =
      'got status: 429 Too Many Requests. {"error":{"code":429,"message":"Rate limit exceeded","status":"RESOURCE_EXHAUSTED"}}';
    const result = parseAndFormatApiError(errorMessage, AuthType.QODER_PAT);
    expect(result).toContain('[API Error: Rate limit exceeded');
    expect(result).toContain(rateLimitFallbackMessage);
  });

  it('should return the original message if it is not a JSON error', () => {
    const errorMessage = 'This is a plain old error message';
    expect(parseAndFormatApiError(errorMessage)).toBe(
      `[API Error: ${errorMessage}]`,
    );
  });

  it.each([
    [
      'dns',
      'Unable to resolve the model service address. Check your DNS or network connection, then try again.',
    ],
    [
      'proxy_connect',
      'Unable to connect through the configured proxy. Check your proxy settings and try again.',
    ],
    [
      'connect',
      'Unable to connect to the model service. Check your network or proxy settings, then try again.',
    ],
    [
      'tls',
      'Unable to establish a secure connection to the model service. Check your network, proxy, system time, and certificates.',
    ],
    [
      'timeout',
      'The model service did not respond in time. Check your network and try again.',
    ],
  ])('formats NetworkAttemptError phase %s for users', (phase, message) => {
    const error = Object.assign(
      new Error(`Network attempt failed at ${phase}`),
      {
        name: 'NetworkAttemptError',
        phase,
        attempts: [{}],
      },
    );

    expect(parseAndFormatApiError(error)).toBe(`[API Error: ${message}]`);
  });

  it('formats a local request-build failure without blaming the network', () => {
    const error = Object.assign(
      new Error(
        'Request could not be built locally: Cannot convert argument to a ByteString because the character at index 3 has a value of 27611 which is greater than 255.',
        {
          cause: new TypeError(
            'Cannot convert argument to a ByteString because the character at index 3 has a value of 27611 which is greater than 255.',
          ),
        },
      ),
      {
        name: 'NetworkAttemptError',
        phase: 'request_build',
        attempts: [{}],
      },
    );

    const result = parseAndFormatApiError(error);

    expect(result).toContain('could not be built on your machine');
    expect(result).toContain('not a network failure');
    expect(result).toContain('ByteString');
    expect(result).not.toContain('Check your network');
  });

  it('formats an empty route set without exposing the internal error', () => {
    const error = Object.assign(new Error('No route candidates available'), {
      name: 'NetworkAttemptError',
      attempts: [],
    });

    expect(parseAndFormatApiError(error)).toBe(
      '[API Error: No network route to the model service is currently available. Check your network, DNS, or proxy settings.]',
    );
  });

  it('should return the original message for malformed JSON', () => {
    const errorMessage = '[Stream Error: {"error": "malformed}';
    expect(parseAndFormatApiError(errorMessage)).toBe(
      `[API Error: ${errorMessage}]`,
    );
  });

  it('should handle JSON that does not match the ApiError structure', () => {
    const errorMessage = '[Stream Error: {"not_an_error": "some other json"}]';
    expect(parseAndFormatApiError(errorMessage)).toBe(
      `[API Error: ${errorMessage}]`,
    );
  });

  it('should format a nested API error', () => {
    const nestedErrorMessage = JSON.stringify({
      error: {
        code: 429,
        message:
          "Gemini 2.5 Pro Preview doesn't have a free quota tier. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
        status: 'RESOURCE_EXHAUSTED',
      },
    });

    const errorMessage = JSON.stringify({
      error: {
        code: 429,
        message: nestedErrorMessage,
        status: 'Too Many Requests',
      },
    });

    const result = parseAndFormatApiError(errorMessage, AuthType.QODER_BROWSER);
    expect(result).toContain('Gemini 2.5 Pro Preview');
    expect(result).toContain(rateLimitFallbackMessage);
  });

  it('should format structured business errors with the server message', () => {
    const serverMessage =
      'Your Billing Group has reached its Credits limit for this billing cycle. Please contact admin to continue.';
    const body = JSON.stringify({
      code: '122',
      message: serverMessage,
      pricingUrl: 'https://example.com/pricing',
    });
    const error = new Error(`Qoder API error: FORBIDDEN - ${body}`);

    expect(parseAndFormatApiError(error)).toBe(`[API Error: ${serverMessage}]`);
  });

  it('should format string-only business errors with the server message', () => {
    const serverMessage =
      'Your Billing Group has reached its Credits limit for this billing cycle. Please contact admin to continue.';
    const body = JSON.stringify({
      code: '122',
      message: serverMessage,
      pricingUrl: 'https://example.com/pricing',
    });

    expect(parseAndFormatApiError(`Qoder API error: FORBIDDEN - ${body}`)).toBe(
      `[API Error: ${serverMessage}]`,
    );
  });

  it('should use the server message for other business codes too', () => {
    const serverMessage = 'Teams admin credits are exhausted.';
    const body = JSON.stringify({
      code: '116',
      message: serverMessage,
    });

    expect(parseAndFormatApiError(`Qoder API error: FORBIDDEN - ${body}`)).toBe(
      `[API Error: ${serverMessage}]`,
    );
  });

  it('should prefer dynamic error-code text when available', () => {
    mocks.getErrorCodeMessage.mockImplementation((code, defaultMessage = '') =>
      code === '116' ? 'Dynamic Teams admin credits text' : defaultMessage,
    );
    const body = JSON.stringify({
      code: '116',
      message: 'Teams admin credits are exhausted.',
    });

    expect(parseAndFormatApiError(`Qoder API error: FORBIDDEN - ${body}`)).toBe(
      '[API Error: Dynamic Teams admin credits text]',
    );
  });

  it('should use provider status for a generic provider error code', () => {
    mocks.getErrorCodeMessage.mockImplementation((code, defaultMessage = '') =>
      String(code) === '416'
        ? 'The current model declined this request.'
        : defaultMessage,
    );
    const body = JSON.stringify({
      code: 'provider_error',
      message: 'Session blocked',
      type: 'provider_error',
    });
    const error = Object.assign(
      new Error(`Qoder API error: REQUESTED_RANGE_NOT_SATISFIABLE - ${body}`),
      { status: 416 },
    );

    expect(parseAndFormatApiError(error)).toBe(
      '[API Error: The current model declined this request.]',
    );
    expect(mocks.getErrorCodeMessage).toHaveBeenCalledWith(
      '416',
      'Session blocked',
    );
  });

  it('should recover provider status from a string-only error', () => {
    mocks.getErrorCodeMessage.mockImplementation((code, defaultMessage = '') =>
      String(code) === '416'
        ? 'The current model declined this request.'
        : defaultMessage,
    );
    const body = JSON.stringify({
      code: 'provider_error',
      message: 'Session blocked',
      type: 'provider_error',
    });

    expect(
      parseAndFormatApiError(
        `Qoder API error: REQUESTED_RANGE_NOT_SATISFIABLE - ${body}`,
      ),
    ).toBe('[API Error: The current model declined this request.]');
  });

  it.each([
    ['TOO_MANY_REQUESTS', 429],
    ['INTERNAL_SERVER_ERROR', 500],
  ])(
    'should recover standard HTTP status %s from a string-only Qoder error',
    (statusName, statusCode) => {
      mocks.getErrorCodeMessage.mockImplementation(
        (code, defaultMessage = '') =>
          String(code) === String(statusCode)
            ? `Dynamic HTTP ${statusCode}`
            : defaultMessage,
      );
      const body = JSON.stringify({
        code: 'provider_error',
        message: 'Provider fallback',
      });

      expect(
        parseAndFormatApiError(`Qoder API error: ${statusName} - ${body}`),
      ).toBe(`[API Error: Dynamic HTTP ${statusCode}]`);
    },
  );

  it.each([
    Object.assign(new Error('other side closed'), {
      name: 'SocketError',
      code: 'UND_ERR_SOCKET',
    }),
    new Error('other side closed'),
    new Error('socket connection was closed unexpectedly'),
  ])('uses a friendly message for an interrupted connection', (error) => {
    expect(getApiErrorDisplayMetadata(error)).toEqual({
      fallbackMessage: CONNECTION_INTERRUPTED_MESSAGE,
    });
  });

  it('should format a StructuredError', () => {
    const error: StructuredError = {
      message: 'A structured error occurred',
      status: 500,
    };
    const expected = '[API Error: A structured error occurred]';
    expect(parseAndFormatApiError(error)).toBe(expected);
  });

  it('should clarify invalid proxy URL parse errors', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:78901');

    const result = parseAndFormatApiError(
      '"http://127.0.0.1:78901" cannot be parsed as a URL.',
    );

    expect(result).toBe(
      '[API Error: Invalid proxy URL in HTTPS_PROXY: "http://127.0.0.1:78901". Port 78901 is outside the valid range of 0-65535. Check your proxy environment variable and use a valid http://, https://, socks5://, socks5h://, or socks:// proxy address.]',
    );
  });

  it('should clarify proxy connection errors', () => {
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:7890');

    const result = parseAndFormatApiError(
      new Error('connect ECONNREFUSED 127.0.0.1:7890'),
    );

    expect(result).toBe(
      '[API Error: Proxy connection failed for HTTP_PROXY: "http://127.0.0.1:7890". Check that the proxy server is running and reachable. Original error: connect ECONNREFUSED 127.0.0.1:7890]',
    );
  });

  it('should clarify socks5h proxy connection errors with the default socks port', () => {
    vi.stubEnv('HTTPS_PROXY', 'socks5h://proxy.example.com');

    const result = parseAndFormatApiError(
      new Error('connect ECONNREFUSED proxy.example.com:1080'),
    );

    expect(result).toBe(
      '[API Error: Proxy connection failed for HTTPS_PROXY: "socks5h://proxy.example.com". Check that the proxy server is running and reachable. Original error: connect ECONNREFUSED proxy.example.com:1080]',
    );
  });

  it('should clarify HTTPS proxy TLS handshake errors for local mixed proxy ports', () => {
    vi.stubEnv('https_proxy', 'https://127.0.0.1:7890');

    const result = parseAndFormatApiError(
      new Error(
        'Client network socket disconnected before secure TLS connection was established',
      ),
    );

    expect(result).toBe(
      `[API Error: Proxy TLS handshake failed for https_proxy: "https://127.0.0.1:7890". The proxy URL starts with https://, which means ${BRAND_CLI_BIN} will use TLS to connect to the proxy server itself. If 127.0.0.1:7890 is a local mixed proxy port such as Clash/ClashX, use "http://127.0.0.1:7890" or "socks5://127.0.0.1:7890" instead. Original error: Client network socket disconnected before secure TLS connection was established]`,
    );
  });

  it('should format a 429 StructuredError with the fallback message for PAT auth', () => {
    const error: StructuredError = {
      message: 'Rate limit exceeded',
      status: 429,
    };
    const result = parseAndFormatApiError(error, AuthType.QODER_PAT);
    expect(result).toContain('[API Error: Rate limit exceeded]');
    expect(result).toContain(rateLimitFallbackMessage);
  });

  it('should handle an unknown error type', () => {
    const error = 12345;
    const expected = '[API Error: An unknown error occurred.]';
    expect(parseAndFormatApiError(error)).toBe(expected);
  });
});

describe('parseAndFormatApiErrorMessage', () => {
  it('strips the [API Error: …] wrapper from the formatted message', () => {
    expect(parseAndFormatApiErrorMessage('boom')).toBe('boom');
  });

  it('preserves multi-line content inside the wrapper', () => {
    const message = 'line one\nline two';
    expect(parseAndFormatApiErrorMessage(message)).toBe(message);
  });
});
