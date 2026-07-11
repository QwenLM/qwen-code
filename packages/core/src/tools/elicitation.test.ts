/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ElicitRequestParams } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  getEnumOptions,
  getElicitationMode,
  getMultiSelectOptions,
  isMultiSelectSchema,
  isSingleSelectSchema,
  registerElicitationHandler,
  validateElicitationInput,
} from './elicitation.js';

describe('elicitation helpers', () => {
  it('defaults omitted mode to form', () => {
    expect(
      getElicitationMode({
        message: 'x',
        requestedSchema: { type: 'object', properties: {} },
      }),
    ).toBe('form');
    expect(
      getElicitationMode({
        mode: 'url',
        message: 'x',
        url: 'https://example.com',
        elicitationId: 'id',
      }),
    ).toBe('url');
  });

  it('extracts titled single-select enum options', () => {
    const schema = {
      type: 'string',
      oneOf: [
        { const: 'prod', title: 'Production' },
        { const: 'stage', title: 'Staging' },
      ],
    };

    expect(isSingleSelectSchema(schema)).toBe(true);
    expect(getEnumOptions(schema)).toEqual([
      { value: 'prod', label: 'Production' },
      { value: 'stage', label: 'Staging' },
    ]);
  });

  it('extracts titled multi-select enum options', () => {
    const schema = {
      type: 'array',
      items: {
        anyOf: [
          { const: 'read', title: 'Read' },
          { const: 'write', title: 'Write' },
        ],
      },
    };

    expect(isMultiSelectSchema(schema)).toBe(true);
    expect(getMultiSelectOptions(schema)).toEqual([
      { value: 'read', label: 'Read' },
      { value: 'write', label: 'Write' },
    ]);
  });

  it('validates primitive values and constraints', () => {
    expect(
      validateElicitationInput('user@example.com', {
        type: 'string',
        format: 'email',
      }),
    ).toEqual({ isValid: true, value: 'user@example.com' });

    expect(
      validateElicitationInput('17', {
        type: 'integer',
        minimum: 18,
      }),
    ).toEqual({ isValid: false, error: 'Must be >= 18' });

    expect(
      validateElicitationInput(['read'], {
        type: 'array',
        minItems: 2,
        items: { enum: ['read', 'write'] },
      }),
    ).toEqual({ isValid: false, error: 'Select at least 2' });
  });

  it('parses boolean strings explicitly', () => {
    expect(validateElicitationInput('false', { type: 'boolean' })).toEqual({
      isValid: true,
      value: false,
    });
    expect(validateElicitationInput('1', { type: 'boolean' })).toEqual({
      isValid: true,
      value: true,
    });
    expect(validateElicitationInput('yes', { type: 'boolean' })).toEqual({
      isValid: false,
      error: 'Enter true or false',
    });
  });

  it('rejects multi-select values outside the allowed options', () => {
    expect(
      validateElicitationInput(['read', 'admin'], {
        type: 'array',
        items: { enum: ['read', 'write'] },
      }),
    ).toEqual({ isValid: false, error: 'Invalid selection: admin' });

    expect(
      validateElicitationInput(['read', 'write'], {
        type: 'array',
        items: { enum: ['read', 'write'] },
      }),
    ).toEqual({ isValid: true, value: ['read', 'write'] });
  });

  it('requires numeric inputs to be fully numeric', () => {
    expect(validateElicitationInput('42xyz', { type: 'integer' })).toEqual({
      isValid: false,
      error: 'Enter an integer',
    });
    expect(validateElicitationInput('12.5abc', { type: 'number' })).toEqual({
      isValid: false,
      error: 'Enter a number',
    });
    expect(validateElicitationInput('12.50', { type: 'number' })).toEqual({
      isValid: true,
      value: 12.5,
    });
    expect(validateElicitationInput('.5', { type: 'number' })).toEqual({
      isValid: true,
      value: 0.5,
    });
    expect(validateElicitationInput('1e-3', { type: 'number' })).toEqual({
      isValid: true,
      value: 0.001,
    });
    expect(validateElicitationInput('1e', { type: 'number' })).toEqual({
      isValid: false,
      error: 'Enter a number',
    });
  });

  it('handles server-provided string patterns defensively', () => {
    expect(
      validateElicitationInput('OPS-42', {
        type: 'string',
        pattern: '^[A-Z]+-\\d+$',
      }),
    ).toEqual({ isValid: true, value: 'OPS-42' });

    expect(
      validateElicitationInput('ops-42', {
        type: 'string',
        pattern: '^[A-Z]+-\\d+$',
      }),
    ).toEqual({
      isValid: false,
      error: 'Does not match the required pattern',
    });

    expect(
      validateElicitationInput('OPS-42', {
        type: 'string',
        pattern: '[',
      }),
    ).toEqual({ isValid: false, error: 'Invalid pattern' });
  });
});

describe('registerElicitationHandler', () => {
  const params: ElicitRequestParams = {
    message: 'Need input',
    requestedSchema: { type: 'object', properties: {} },
  };

  function registerWithConfig(config: Partial<Config>) {
    let requestHandler:
      | ((
          request: { params: ElicitRequestParams },
          extra: { requestId?: string | number; signal: AbortSignal },
        ) => Promise<unknown>)
      | undefined;
    const client = {
      setRequestHandler: vi.fn((_schema, handler) => {
        requestHandler = handler as typeof requestHandler;
      }),
      setNotificationHandler: vi.fn(),
    };

    registerElicitationHandler(
      client as unknown as Client,
      'test-server',
      config as Config,
    );

    if (!requestHandler) {
      throw new Error('request handler was not registered');
    }
    return requestHandler;
  }

  it('lets a before hook answer without showing UI', async () => {
    const uiHandler = vi.fn();
    const hookHandler = vi.fn().mockResolvedValue({ action: 'decline' });
    const requestHandler = registerWithConfig({
      getElicitationHandler: () => uiHandler,
      getElicitationHookHandler: () => hookHandler,
    });

    const result = await requestHandler(
      { params },
      { requestId: 'req-1', signal: new AbortController().signal },
    );

    expect(result).toEqual({ action: 'decline' });
    expect(uiHandler).not.toHaveBeenCalled();
    expect(hookHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'before',
        serverName: 'test-server',
        requestId: 'req-1',
        params,
      }),
    );
  });

  it('falls through to UI when a before hook returns undefined', async () => {
    const uiResult = { action: 'accept', content: { name: 'Qwen' } };
    const uiHandler = vi.fn().mockResolvedValue(uiResult);
    const hookHandler = vi.fn().mockResolvedValue(undefined);
    const requestHandler = registerWithConfig({
      getElicitationHandler: () => uiHandler,
      getElicitationHookHandler: () => hookHandler,
    });

    const result = await requestHandler(
      { params },
      {
        requestId: 'req-before-undefined',
        signal: new AbortController().signal,
      },
    );

    expect(result).toEqual(uiResult);
    expect(uiHandler).toHaveBeenCalledOnce();
    expect(hookHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'before',
        requestId: 'req-before-undefined',
      }),
    );
  });

  it('falls through to UI when a before hook throws', async () => {
    const uiResult = { action: 'accept', content: { name: 'Qwen' } };
    const uiHandler = vi.fn().mockResolvedValue(uiResult);
    const hookHandler = vi.fn().mockRejectedValue(new Error('hook failed'));
    const requestHandler = registerWithConfig({
      getElicitationHandler: () => uiHandler,
      getElicitationHookHandler: () => hookHandler,
    });

    const result = await requestHandler(
      { params },
      { requestId: 'req-before-throws', signal: new AbortController().signal },
    );

    expect(result).toEqual(uiResult);
    expect(uiHandler).toHaveBeenCalledOnce();
  });

  it('lets an after hook modify the UI response', async () => {
    const uiHandler = vi.fn().mockResolvedValue({ action: 'decline' });
    const hookHandler = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ action: 'cancel' });
    const requestHandler = registerWithConfig({
      getElicitationHandler: () => uiHandler,
      getElicitationHookHandler: () => hookHandler,
    });

    const result = await requestHandler(
      { params },
      { requestId: 'req-2', signal: new AbortController().signal },
    );

    expect(result).toEqual({ action: 'cancel' });
    expect(uiHandler).toHaveBeenCalledOnce();
    expect(hookHandler).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'after',
        result: { action: 'decline' },
      }),
    );
  });

  it('returns the UI response when an after hook throws', async () => {
    const uiResult = { action: 'decline' };
    const uiHandler = vi.fn().mockResolvedValue(uiResult);
    const hookHandler = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('after hook failed'));
    const requestHandler = registerWithConfig({
      getElicitationHandler: () => uiHandler,
      getElicitationHookHandler: () => hookHandler,
    });

    const result = await requestHandler(
      { params },
      { requestId: 'req-after-throws', signal: new AbortController().signal },
    );

    expect(result).toEqual(uiResult);
    expect(uiHandler).toHaveBeenCalledOnce();
    expect(hookHandler).toHaveBeenCalledTimes(2);
  });
});
