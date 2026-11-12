/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  normalizeSdkErrorResult,
  buildTurnFailureResult,
  resolveErrorPresentation,
  REQUEST_FAILED_MESSAGE,
  REQUEST_REJECTED_MESSAGE,
  EMPTY_ASSISTANT_COMPLETION_MESSAGES,
} from './errorPresentation.js';
import { ModelInferenceError } from '../provider/modelInferenceError.js';
import { EmptyAssistantCompletionError } from '../model-request/empty-assistant-completion.js';
import { CONTENT_FILTERED_MESSAGE } from '../core/query-event.js';
import { getQoderErrorText } from '../provider/qoder/qoderErrorText.js';
import {
  getResultErrorCode,
  getResultErrorCodeFromMessages,
} from './resultErrorCode.js';
import { formatApiErrorDisplayMessage } from './errorParsing.js';

const getErrorCodeMessage = vi.hoisted(() =>
  vi.fn((_code: unknown, message: string) => `Configured: ${message}`),
);
const uiLocale = vi.hoisted(() => ({ value: 'en' }));

vi.mock('../i18n/index.js', () => ({
  getI18nService: () => ({
    locale: uiLocale.value,
    get: (key: string, params?: { message?: string }) =>
      getErrorCodeMessage(
        key.replace(/^error\.code\./, ''),
        params?.message ?? '',
      ),
  }),
}));

const failure = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
};

describe('Provider display regression', () => {
  it('keeps a known error code ahead of conflicting diagnostic text', () => {
    const error = new ModelInferenceError('Session blocked', {
      code: '403',
      status: 403,
      kind: 'auth',
      phase: 'before_output',
    });
    expect(resolveErrorPresentation(error).fallbackMessage).toContain(
      'permissions',
    );
    expect(getResultErrorCode(error)).toBe('403');
  });

  it.each([
    {
      code: 'insufficient_quota',
      providerSource: 'qoder',
      status: 429,
      kind: 'quota_exhausted' as const,
      expected: 'check your quota',
    },
    {
      code: 'rate_limit_error',
      providerSource: 'qoder',
      status: 429,
      kind: 'rate_limited' as const,
      expected: 'check your quota',
    },
    {
      code: 'authentication_error',
      providerSource: 'qoder',
      status: 401,
      kind: 'auth' as const,
      expected: 'sign in again',
    },
    {
      code: 'permission_error',
      status: 403,
      kind: 'auth' as const,
      expected: 'permissions',
    },
    {
      code: undefined,
      status: 503,
      kind: 'server' as const,
      expected: 'temporarily unavailable',
    },
    {
      code: undefined,
      status: 408,
      kind: 'server' as const,
      expected: 'did not respond in time',
    },
    {
      code: undefined,
      status: 413,
      kind: 'prompt_too_long' as const,
      expected: 'input is too long',
    },
  ])(
    'restores the $status message while retaining the original $code',
    ({ code, status, kind, providerSource, expected }) => {
      const error = new ModelInferenceError('private provider diagnostic', {
        code,
        status,
        kind,
        phase: 'before_output',
      });
      const presentation = resolveErrorPresentation(error, providerSource);
      expect(presentation.fallbackMessage).toContain(expected);
      expect(presentation.displayErrorCode).toBe(code);
      expect(getResultErrorCode(error)).toBe(code);
      expect(
        normalizeSdkErrorResult(
          { ...failure, error_code: code, errors: [error.message] },
          error,
        ).error_code,
      ).toBe(code);
    },
  );

  it('uses the existing nested transport and message parsers for display', () => {
    const timeout = new ModelInferenceError('private diagnostic', {
      code: 'network_failure',
      kind: 'network',
      phase: 'before_output',
      cause: Object.assign(new Error('private transport detail'), {
        code: 'ETIMEDOUT',
      }),
    });
    expect(resolveErrorPresentation(timeout).fallbackMessage).toContain(
      'did not respond in time',
    );
    const quota = new ModelInferenceError('User quota exhausted', {
      code: 'insufficient_quota',
      kind: 'quota_exhausted',
      phase: 'before_output',
    });
    expect(resolveErrorPresentation(quota, 'qoder').fallbackMessage).toContain(
      'check your quota',
    );
  });
});

describe('Custom Provider authentication presentation', () => {
  it('shows a sign-in prompt for a server authentication failure while preserving its code', () => {
    const error = new ModelInferenceError('Login expired', {
      kind: 'auth',
      code: '105',
      status: 401,
      phase: 'before_output',
    });
    const presentation = resolveErrorPresentation(error, 'qoder');
    expect(presentation.displayErrorCode).toBe('105');
    expect(presentation.fallbackMessage).toContain('Please sign in again');
    expect(error.code).toBe('105');
  });

  it.each([undefined, 'invalid_api_key', '401', 'authentication_error'])(
    'selects credentials text without changing original code %s',
    (code) => {
      const error = new ModelInferenceError('private provider diagnostic', {
        code,
        kind: 'auth',
        status: 401,
        phase: 'before_output',
      });
      const originalResultCode = getResultErrorCode(error);
      const presentation = resolveErrorPresentation(error, 'custom-provider');
      expect(presentation.displayErrorCode).toBe(code);
      expect(presentation.fallbackMessage).toContain('credentials');
      expect(error.code).toBe(code);
      expect(getResultErrorCode(error)).toBe(originalResultCode);
      expect(error.message).toBe('private provider diagnostic');
    },
  );

  it.each([
    {
      providerSource: 'qoder',
      status: 401,
      code: '401',
      expected: 'sign in again',
    },
    {
      providerSource: 'qwen-subscription',
      status: 403,
      code: '403',
      expected: 'permissions',
    },
  ])(
    'preserves auth semantics for $code (provider=$providerSource)',
    ({ providerSource, status, code, expected }) => {
      const error = new ModelInferenceError('private diagnostic', {
        code,
        kind: 'auth',
        status,
        phase: 'before_output',
      });
      const presentation = resolveErrorPresentation(error, providerSource);
      expect(presentation.fallbackMessage).toContain(expected);
    },
  );

  it('recognizes a wrapped auth error frame without an HTTP status', () => {
    const cause = new ModelInferenceError('Invalid API key', {
      code: 'invalid_api_key',
      kind: 'auth',
      phase: 'before_output',
    });
    expect(
      resolveErrorPresentation(
        new Error('wrapper', { cause }),
        'custom-provider',
      ).fallbackMessage,
    ).toContain('credentials');
    expect(cause.code).toBe('invalid_api_key');
  });

  it('keeps cancellation ahead of a nested credentials error', () => {
    const cause = new ModelInferenceError('Invalid API key', {
      code: 'invalid_api_key',
      kind: 'auth',
      status: 401,
      phase: 'before_output',
    });
    const error = Object.assign(new Error('Cancelled', { cause }), {
      name: 'AbortError',
    });
    expect(resolveErrorPresentation(error, 'custom-provider')).toEqual({
      fallbackMessage: 'Operation aborted',
    });
  });
});

describe('SDK 错误呈现', () => {
  it('keeps Provider diagnostic text raw for SDK consumers', () => {
    const error = new ModelInferenceError(
      'Malformed tool call stream: raw detail',
      {
        code: 'malformed_response',
        kind: 'protocol',
        phase: 'after_output',
      },
    );
    expect(
      normalizeSdkErrorResult({ ...failure, errors: [error.message] }, error),
    ).toMatchObject({
      error_code: error.code,
      errors: [error.message],
    });
  });

  it('个人 Credits 业务码 112 在展示和 SDK 结果中保持原值', () => {
    const error = new ModelInferenceError('Personal Credits exhausted', {
      kind: 'quota_exhausted',
      phase: 'before_output',
      code: '112',
      status: 403,
    });
    const presentation = resolveErrorPresentation(error, 'qoder');
    expect(presentation.displayErrorCode).toBe('112');
    expect(presentation.fallbackMessage).toContain('personal Credits');
    expect(buildTurnFailureResult('session', error)).toMatchObject({
      error_code: '112',
    });
    expect(
      normalizeSdkErrorResult({
        ...failure,
        error_code: getResultErrorCode(error),
        errors: [presentation.fallbackMessage],
      }),
    ).toMatchObject({ error_code: '112' });
  });

  it.each(['140', 'EXTERNAL_TOKEN_RATE_LIMITED'])(
    'Provider code %s survives presentation and SDK result without HTTP fallback',
    (code) => {
      const error = new ModelInferenceError('HTTP 503', {
        code,
        kind: 'server',
        status: 503,
        phase: 'before_output',
      });
      expect(resolveErrorPresentation(error).displayErrorCode).toBe(code);
      expect(
        normalizeSdkErrorResult(
          { ...failure, error_code: 10500, errors: ['HTTP 503'] },
          error,
        ).error_code,
      ).toBe(code);
    },
  );

  it('keeps a missing Provider code missing in SDK results', () => {
    const error = new ModelInferenceError('HTTP 503', {
      kind: 'server',
      status: 503,
      phase: 'before_output',
    });
    expect(resolveErrorPresentation(error)).not.toHaveProperty(
      'displayErrorCode',
    );
    expect(
      normalizeSdkErrorResult({ ...failure, errors: ['HTTP 503'] }, error),
    ).not.toHaveProperty('error_code');
  });

  it('max output tokens uses a dedicated safe fallback with its stable code', () => {
    const error = Object.assign(new Error('private provider diagnostic'), {
      code: 'max_output_tokens',
      error_code: 'max_output_tokens',
    });
    const presentation = resolveErrorPresentation(
      new Error('Display wrapper', { cause: error }),
    );
    expect(presentation.displayErrorCode).toBe('max_output_tokens');
    expect(presentation.fallbackMessage).not.toBe(REQUEST_FAILED_MESSAGE);
    expect(presentation.fallbackMessage).not.toContain(
      'private provider diagnostic',
    );
    expect(
      formatApiErrorDisplayMessage(
        presentation.displayErrorCode,
        presentation.fallbackMessage,
      ),
    ).toBe(`Configured: ${presentation.fallbackMessage}`);
  });

  it.each([
    ['EDQUOT', 'storage_insufficient', 'enough available disk space'],
    ['ENOSPC', 'storage_insufficient', 'enough available disk space'],
  ])('存储故障 %s 提供明确的环境错误文案', (code, expected, text) => {
    const error = Object.assign(
      new Error(`${code}: write failed, /private/session.jsonl`),
      { code },
    );
    const presentation = resolveErrorPresentation(error);
    expect(presentation.displayErrorCode).toBe(expected);
    expect(presentation.fallbackMessage).toContain(text);
    expect(presentation.fallbackMessage).not.toContain(
      '/private/session.jsonl',
    );
    expect(getResultErrorCodeFromMessages([presentation.fallbackMessage])).toBe(
      expected,
    );
  });
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
  ])('执行环境错误 %s 在呈现和 SDK result 中保留可读提示', (code, expected) => {
    const error = Object.assign(
      new Error(`${code}: operation failed, open '/private/session'`),
      { code, syscall: 'open' },
    );
    const presentation = resolveErrorPresentation(error);
    expect(presentation.displayErrorCode).toBe(expected);
    expect(presentation.fallbackMessage).not.toContain('/private/session');
    expect(getResultErrorCodeFromMessages([presentation.fallbackMessage])).toBe(
      expected,
    );
    expect(
      normalizeSdkErrorResult({
        ...failure,
        errors: [error.message],
        duration_ms: 23,
      }),
    ).toMatchObject({
      error_code: expected,
      errors: [presentation.fallbackMessage],
      duration_ms: 23,
    });
    expect(
      normalizeSdkErrorResult({ ...failure, error_code: expected, errors: [] }),
    ).toMatchObject({
      error_code: expected,
      errors: [presentation.fallbackMessage],
    });
    const aborted = Object.assign(
      new Error('Operation aborted', { cause: error }),
      { name: 'AbortError' },
    );
    expect(resolveErrorPresentation(aborted)).toEqual({
      fallbackMessage: 'Operation aborted',
    });
  });
  it.each(['aborted_streaming', 'aborted_tools'])(
    '取消终态 %s 不从伴随的系统异常文本推断环境错误码',
    (terminal_reason) => {
      const result = normalizeSdkErrorResult({
        ...failure,
        terminal_reason,
        errors: ['ENOMEM: not enough memory'],
      });
      expect(result).not.toHaveProperty('error_code');
      expect(result.terminal_reason).toBe(terminal_reason);
    },
  );
  it.each(['reasoning_only', 'no_visible_content'] as const)(
    '空补全（%s）使用专用文案与错误码，不走通用 500',
    (reason) => {
      const error = new EmptyAssistantCompletionError({
        reason,
        finishReason: 'end_turn',
        contentBlockCount: reason === 'reasoning_only' ? 1 : 0,
        reasoningBlockCount: reason === 'reasoning_only' ? 1 : 0,
        textCharacterCount: 0,
        model: 'auto',
        transport: 'legacy',
        serverRequestId: 'srv-empty-completion',
      });
      expect(resolveErrorPresentation(error)).toEqual({
        displayErrorCode: 'empty_assistant_completion',
        fallbackMessage: EMPTY_ASSISTANT_COMPLETION_MESSAGES[reason],
      });
      const wrapped = new ModelInferenceError('empty completion', {
        kind: 'unknown',
        phase: 'after_output',
        code: error.code,
        cause: error,
      });
      expect(resolveErrorPresentation(wrapped)).toEqual(
        resolveErrorPresentation(error),
      );
      expect(EMPTY_ASSISTANT_COMPLETION_MESSAGES[reason]).not.toBe(
        REQUEST_FAILED_MESSAGE,
      );
      // 专用错误码没有远端动态文案，展示文案必须原样保留。
      expect(
        formatApiErrorDisplayMessage(
          resolveErrorPresentation(error).displayErrorCode,
          resolveErrorPresentation(error).fallbackMessage,
        ),
      ).toBe(`Configured: ${EMPTY_ASSISTANT_COMPLETION_MESSAGES[reason]}`);
    },
  );
  it.each([
    new Error('internal assertion failed'),
    new Error(''),
    null,
    undefined,
    { privateData: 'secret' },
  ])('未知异常有安全兜底：%s', (error) => {
    expect(resolveErrorPresentation(error)).toEqual({
      displayErrorCode: 500,
      fallbackMessage: REQUEST_FAILED_MESSAGE,
    });
  });
  it('保留业务错误码并使用 CLI 文案', () => {
    expect(
      resolveErrorPresentation({
        providerCode: '122',
      }),
    ).toEqual({
      displayErrorCode: 122,
      fallbackMessage:
        'Your Billing Group has reached its Credits limit for this billing cycle. Please contact admin to continue.',
    });
    expect(
      normalizeSdkErrorResult({
        ...failure,
        error_code: 987654,
        errors: ['Custom provider detail'],
        uuid: 'original',
      }),
    ).toMatchObject({
      error_code: 987654,
      errors: ['Custom provider detail'],
      uuid: 'original',
    });
  });
  it('Credits 耗尽码 130 使用 CLI 文案，不透传服务端原文', () => {
    expect(
      resolveErrorPresentation({
        providerCode: '130',
      }),
    ).toEqual({
      displayErrorCode: 130,
      fallbackMessage:
        'Your Credits have been exhausted. Please check your plan or contact your administrator.',
    });
    expect(getResultErrorCode({ providerCode: '130' })).toBe(130);
  });
  it.each(['USER_PHONE_EMPTY', 'EXTERNAL_TOKEN_RATE_LIMITED', 'constructor'])(
    '保留字符串业务码 %s，并使用安全兜底文案',
    (code) => {
      expect(
        resolveErrorPresentation({
          providerCode: code,
        }),
      ).toEqual({
        displayErrorCode: code,
        fallbackMessage: REQUEST_FAILED_MESSAGE,
      });
      const result = normalizeSdkErrorResult({
        ...failure,
        error_code: code,
        errors: [],
        duration_ms: 123,
        session_id: 'original-session',
      });
      expect(result).toMatchObject({
        error_code: code,
        errors: [REQUEST_FAILED_MESSAGE],
        duration_ms: 123,
        session_id: 'original-session',
      });
    },
  );
  it.each(['', '  ', NaN, Infinity])('无效错误码 %s 使用兜底', (code) => {
    expect(
      normalizeSdkErrorResult({ ...failure, error_code: code }),
    ).toMatchObject({
      error_code: 500,
      errors: [REQUEST_FAILED_MESSAGE],
    });
  });
  it.each([
    ['Bad Request', 500],
    [JSON.stringify({ code: 400, message: 'raw-provider-detail' }), 500],
    [JSON.stringify({ message: 'raw-provider-detail' }), 500],
    [
      JSON.stringify({
        error: {
          message: 'raw-provider-detail',
          type: 'invalid_request_error',
        },
      }),
      500,
    ],
  ])(
    'HTTP 400 的正文和动态文案参数都不包含服务端原文：%s',
    (body, resultCode) => {
      const error = Object.assign(new Error(`HTTP 400: ${body}`), {
        code: 'http_error',
        status: 400,
      });
      const presentation = resolveErrorPresentation(error);
      expect(presentation.fallbackMessage).toBe(REQUEST_REJECTED_MESSAGE);
      expect(
        formatApiErrorDisplayMessage(
          presentation.displayErrorCode,
          presentation.fallbackMessage,
        ),
      ).toBe(`Configured: ${REQUEST_REJECTED_MESSAGE}`);
      expect(getResultErrorCode(error)).toBe(resultCode);
      expect(error.message).toContain(body);
    },
  );
  it('未知业务码保留，原始提示不对外展示', () => {
    const error = Object.assign(new Error('raw-provider-detail'), {
      providerCode: '987654',
    });
    expect(resolveErrorPresentation(error)).toEqual({
      displayErrorCode: 987654,
      fallbackMessage: REQUEST_FAILED_MESSAGE,
    });
    expect(getResultErrorCode(error)).toBe(987654);
  });
  it.each([[[]], [['']], [['  ', 'Unknown error', '[object Object]']]])(
    '空错误列表有稳定兜底：%s',
    (errors) => {
      expect(normalizeSdkErrorResult({ ...failure, errors })).toMatchObject({
        error_code: 500,
        errors: [REQUEST_FAILED_MESSAGE],
      });
    },
  );
  it('仅 Qoder 的 406 提供本地化指引，保留错误码与诊断', () => {
    const error = new ModelInferenceError('Session blocked', {
      code: '406',
      status: 406,
      kind: 'invalid_request',
      phase: 'before_output',
    });
    expect(resolveErrorPresentation(error, 'qoder')).toEqual({
      displayErrorCode: '406',
      fallbackMessage: getQoderErrorText(406),
    });
    expect(error.message).toBe('Session blocked');
    expect(getResultErrorCode(error)).toBe('406');
    expect(getQoderErrorText(406)).toContain('/clear');
    for (const provider of ['custom-provider', undefined]) {
      expect(resolveErrorPresentation(error, provider).fallbackMessage).toBe(
        CONTENT_FILTERED_MESSAGE,
      );
    }
    try {
      uiLocale.value = 'zh-CN';
      expect(resolveErrorPresentation(error, 'qoder').fallbackMessage).toBe(
        '模型服务拒绝了当前会话内容。请使用 /clear 新建会话后重新描述任务。',
      );
    } finally {
      uiLocale.value = 'en';
    }
    expect(
      resolveErrorPresentation(
        Object.assign(new Error('HTTP 406'), { status: 406 }),
      ),
    ).toEqual({
      displayErrorCode: 406,
      fallbackMessage: CONTENT_FILTERED_MESSAGE,
    });
    expect(
      resolveErrorPresentation(
        Object.assign(new Error(CONTENT_FILTERED_MESSAGE), {
          code: 'MODEL_REFUSAL',
        }),
        'qoder',
      ).fallbackMessage,
    ).toBe(CONTENT_FILTERED_MESSAGE);
  });
  it('取消不伪装成服务故障', () => {
    const result = normalizeSdkErrorResult({
      ...failure,
      terminal_reason: 'aborted_tools',
      errors: [],
    });
    expect(result.errors).toEqual(['Operation aborted']);
    expect(result).not.toHaveProperty('error_code');
    expect(
      resolveErrorPresentation(
        Object.assign(new Error('cancelled'), { name: 'AbortError' }),
      ),
    ).toEqual({ fallbackMessage: 'Operation aborted' });
  });
  it('识别超轮次而不归为未知错误', () => {
    expect(
      normalizeSdkErrorResult({
        ...failure,
        subtype: 'error_max_turns',
        errors: ['Turn limit reached'],
      }),
    ).toHaveProperty('error_code', 47902);
  });
  it('成功结果和非 result 事件保持原样', () => {
    const success = {
      ...failure,
      subtype: 'success',
      is_error: false,
      result: 'done',
    };
    expect(normalizeSdkErrorResult(success)).toBe(success);
    const message = { type: 'assistant' };
    expect(normalizeSdkErrorResult(message)).toBe(message);
  });
});

describe('buildTurnFailureResult', () => {
  it('keeps the concrete turn error in the display field', () => {
    const error = Object.assign(
      new Error("EPERM: operation not permitted, open 'C:\tmpsession.jsonl'"),
      {
        code: 'EPERM',
        syscall: 'open',
        path: 'C:\tmpsession.jsonl',
      },
    );

    const result = buildTurnFailureResult('session-1', error);

    expect(result).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'session-1',
      result: error.message,
    });
    expect(result.errors).toEqual([error.message]);
    expect(result).not.toHaveProperty('error_message');
    expect(result.error_code).toBe('filesystem_access_denied');
    expect(result.uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves existing business and authentication codes before the 500 normalizer', () => {
    expect(
      buildTurnFailureResult(
        'session-business',
        Object.assign(new Error('quota exhausted'), {
          providerCode: '115',
          providerStatus: 429,
        }),
      ).error_code,
    ).toBe(115);
    expect(
      buildTurnFailureResult(
        'session-auth',
        Object.assign(new Error('host token rejected'), {
          code: 'job_token_invalid',
        }),
      ).error_code,
    ).toBe('job_token_invalid');
  });

  it('never assigns a cancellation code', () => {
    const cancelled = Object.assign(
      new Error('Operation aborted', {
        cause: Object.assign(new Error('disk full'), {
          code: 'ENOSPC',
          syscall: 'write',
        }),
      }),
      { name: 'AbortError' },
    );
    expect(
      buildTurnFailureResult('session-cancel', cancelled),
    ).not.toHaveProperty('error_code');
  });

  it('preserves the server explanation and falls back for an empty error', () => {
    const serverError = Object.assign(new Error('initialization failed'), {
      qoderApiError: { message: 'Service rejected initialization' },
    });

    expect(buildTurnFailureResult('session-2', serverError).error_message).toBe(
      'Service rejected initialization',
    );
    expect(buildTurnFailureResult('session-3', new Error('')).errors).toEqual([
      'Unknown error',
    ]);
  });
});
