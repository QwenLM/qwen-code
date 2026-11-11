/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { formatCustomProviderConfigurationWarnings } from './configuration-warnings.js';
import type { CustomProvidersState } from './types.js';

describe('formatCustomProviderConfigurationWarnings', () => {
  it('explains how to replace the removed provider image setting', () => {
    const state: CustomProvidersState = {
      status: 'invalid_configuration',
      issues: [
        {
          providerId: 'alibaba',
          field: 'image',
          message:
            'providers[provider].image has been removed; use tools.imageGen',
        },
      ],
    };

    expect(formatCustomProviderConfigurationWarnings(state)).toEqual([
      'Custom provider "alibaba" was ignored: image: providers[provider].image has been removed; use tools.imageGen.',
    ]);
  });

  it('formats global issues as ignored settings', () => {
    const state: CustomProvidersState = {
      status: 'invalid_configuration',
      issues: [
        {
          providerId: '*',
          field: 'providers',
          message: 'must be an object',
        },
      ],
    };

    expect(formatCustomProviderConfigurationWarnings(state)).toEqual([
      'Custom provider settings were ignored: providers: must be an object.',
    ]);
  });

  it('groups multiple issues by provider', () => {
    const state: CustomProvidersState = {
      status: 'invalid_configuration',
      issues: [
        {
          providerId: 'gateway',
          field: 'apiKey',
          message: 'is required',
        },
        {
          providerId: 'gateway',
          field: 'baseUrl',
          message: 'must be an http(s) URL',
        },
      ],
    };

    expect(formatCustomProviderConfigurationWarnings(state)).toEqual([
      'Custom provider "gateway" was ignored: apiKey: is required; baseUrl: must be an http(s) URL.',
    ]);
  });

  it('returns no warnings for an empty issue list', () => {
    const state: CustomProvidersState = {
      status: 'active',
      providerCount: 1,
      modelCount: 1,
      issues: [],
    };

    expect(formatCustomProviderConfigurationWarnings(state)).toEqual([]);
  });
});
