/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { vi } from 'vitest';
import { validateAuthMethod } from './auth.js';

vi.mock('./settings.js', () => ({
  loadEnvironment: vi.fn(),
  loadSettings: vi.fn().mockReturnValue({
    merged: vi.fn().mockReturnValue({}),
  }),
}));

describe('validateAuthMethod', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should return null for USE_OPENAI', () => {
    process.env['OPENAI_API_KEY'] = 'fake-key';
    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
  });

  it('should return an error message for USE_OPENAI if OPENAI_API_KEY is not set', () => {
    delete process.env['OPENAI_API_KEY'];
    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBe(
      'OPENAI_API_KEY environment variable not found. You can enter it interactively or add it to your .env file.',
    );
  });

  it('should return null for QWEN_OAUTH', () => {
    expect(validateAuthMethod(AuthType.QWEN_OAUTH)).toBeNull();
  });

  it('should return an error message for an invalid auth method', () => {
    expect(validateAuthMethod('invalid-method')).toBe(
      'Invalid auth method selected.',
    );
  });
});
