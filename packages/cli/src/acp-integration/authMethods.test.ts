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
  it('advertises one shared OpenAI key method', () => {
    const authMethods = buildAuthMethods();

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
    ]);
  });

  it('uses the shared OpenAI method for a Responses session', () => {
    expect(pickAuthMethodsForAuthRequired('openai-responses')).toEqual(
      buildAuthMethods(),
    );
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
    ]);
  });

  it('falls back to working methods for an unknown stored selection', () => {
    const authMethods = pickAuthMethodsForAuthRequired('not-a-real-auth-type');

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
    ]);
  });
});
