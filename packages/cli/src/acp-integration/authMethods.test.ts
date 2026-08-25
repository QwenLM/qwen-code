/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  buildAuthMethods,
  pickAuthMethodsForAuthRequired,
} from './authMethods.js';

describe('ACP auth methods', () => {
  it('advertises OpenAI and OpenAI Responses, but not discontinued Qwen OAuth', () => {
    const authMethods = buildAuthMethods();

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
      AuthType.USE_OPENAI_RESPONSES,
    ]);
  });

  it('exposes the Responses method with its own name and CLI auth-type argument', () => {
    const responses = buildAuthMethods().find(
      (method) => method.id === AuthType.USE_OPENAI_RESPONSES,
    );

    expect(responses).toMatchObject({
      name: 'Use OpenAI Responses API key',
      description: 'Requires setting the `OPENAI_API_KEY` environment variable',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=openai-responses'],
      },
    });
  });

  it('selects only the Responses method for a stored openai-responses selection', () => {
    const authMethods = pickAuthMethodsForAuthRequired('openai-responses');

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI_RESPONSES,
    ]);
  });

  it('selects only the OpenAI method for a stored openai selection', () => {
    const authMethods = pickAuthMethodsForAuthRequired('openai');

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
    ]);
  });

  it('falls back to working methods for a stored discontinued Qwen OAuth selection', () => {
    const authMethods = pickAuthMethodsForAuthRequired('qwen-oauth');

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
      AuthType.USE_OPENAI_RESPONSES,
    ]);
  });

  it('falls back to working methods for an unknown stored selection', () => {
    const authMethods = pickAuthMethodsForAuthRequired('not-a-real-auth-type');

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
      AuthType.USE_OPENAI_RESPONSES,
    ]);
  });
});
