/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import { validateModelConfig } from '../core/contentGenerator.js';
import {
  CODE_ASSIST_ENDPOINT,
  DEFAULT_GOOGLE_OAUTH_MODEL,
  GOOGLE_OAUTH_TOKEN_PLACEHOLDER,
} from '../code_assist/constants.js';
import { resolveModelConfig } from './modelConfigResolver.js';
import { ModelRegistry } from './modelRegistry.js';

function resolveGoogle(
  input: {
    model?: string;
    endpoint?: string;
    cliBaseUrl?: string;
  } = {},
) {
  return resolveModelConfig({
    authType: AuthType.GOOGLE_OAUTH,
    cli: {
      ...(input.model ? { model: input.model } : {}),
      ...(input.cliBaseUrl ? { baseUrl: input.cliBaseUrl } : {}),
    },
    settings: {
      apiKey: 'must-not-leak',
      baseUrl: 'https://must-not-leak.invalid',
    },
    env: {
      ...(input.endpoint ? { CODE_ASSIST_ENDPOINT: input.endpoint } : {}),
      GEMINI_API_KEY: 'also-must-not-leak',
    },
  });
}

describe('Google OAuth model configuration', () => {
  it('defaults to Gemini 4 Argon without inheriting a static credential', () => {
    const result = resolveGoogle();
    expect(result.config).toMatchObject({
      authType: AuthType.GOOGLE_OAUTH,
      model: 'gemini-4-argon',
      apiKey: GOOGLE_OAUTH_TOKEN_PLACEHOLDER,
      baseUrl: CODE_ASSIST_ENDPOINT,
    });
    expect(DEFAULT_GOOGLE_OAUTH_MODEL).toBe('gemini-4-argon');
    expect(result.warnings).toEqual([]);
    expect(
      validateModelConfig({ ...result.config, apiKey: undefined }).valid,
    ).toBe(true);
  });

  it.each([
    'gemini-4-argon',
    'gemini-4-carbon',
    'gemini-4-hydrogen',
    'gemini-2.5-pro',
  ])('passes the built-in model ID %s verbatim', (model) => {
    const result = resolveGoogle({ model });
    expect(result.config.model).toBe(model);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to Argon for an unknown model', () => {
    const result = resolveGoogle({ model: 'gemini-4-unknown' });
    expect(result.config.model).toBe('gemini-4-argon');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('gemini-4-unknown');
  });

  it('still requires a model while exempting Google from static API-key checks', () => {
    const result = resolveGoogle();
    expect(
      validateModelConfig({ ...result.config, model: '', apiKey: undefined }),
    ).toMatchObject({ valid: false });
    expect(
      validateModelConfig({ ...result.config, apiKey: undefined }).valid,
    ).toBe(true);
  });

  it('uses an explicit Code Assist-compatible test endpoint', () => {
    const result = resolveGoogle({ endpoint: 'http://127.0.0.1:8787' });
    expect(result.config.baseUrl).toBe('http://127.0.0.1:8787');
    expect(result.config.apiKey).toBe(GOOGLE_OAUTH_TOKEN_PLACEHOLDER);
  });

  it('rejects a generic CLI base URL override', () => {
    expect(() =>
      resolveGoogle({ cliBaseUrl: 'https://not-code-assist.invalid' }),
    ).toThrow('does not accept a generic base URL override');
  });

  it('registers the Gemini 4 family without custom-provider overrides', () => {
    const registry = new ModelRegistry({
      'google-oauth': [
        { id: 'gemini-4-argon', baseUrl: 'https://override.invalid' },
      ],
    });
    const models = registry.getModelsForAuthType(AuthType.GOOGLE_OAUTH);
    expect(models.map((model) => model.id)).toEqual([
      'gemini-4-argon',
      'gemini-4-carbon',
      'gemini-4-hydrogen',
      'gemini-2.5-pro',
    ]);
    expect(
      registry.getDefaultModelForAuthType(AuthType.GOOGLE_OAUTH),
    ).toMatchObject({
      id: 'gemini-4-argon',
      baseUrl: CODE_ASSIST_ENDPOINT,
    });
  });
});
