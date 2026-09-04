/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isStandaloneModelPickerUnavailable } from './composerModels';

describe('isStandaloneModelPickerUnavailable', () => {
  it('is available when a session is attached', () => {
    expect(
      isStandaloneModelPickerUnavailable({
        sessionId: 'session-1',
        sessionContextKind: 'standalone',
        models: undefined,
      }),
    ).toBe(false);
  });

  it('is available outside standalone contexts', () => {
    expect(
      isStandaloneModelPickerUnavailable({
        sessionId: undefined,
        sessionContextKind: 'workspace',
        models: [],
      }),
    ).toBe(false);
  });

  it('is unavailable before the catalog hydrates', () => {
    expect(
      isStandaloneModelPickerUnavailable({
        sessionId: undefined,
        sessionContextKind: 'standalone',
        models: undefined,
      }),
    ).toBe(true);
  });

  it('is unavailable when the hydrated catalog is empty', () => {
    expect(
      isStandaloneModelPickerUnavailable({
        sessionId: undefined,
        sessionContextKind: 'standalone',
        models: [],
      }),
    ).toBe(true);
  });

  it('is unavailable when the catalog only holds hidden models', () => {
    expect(
      isStandaloneModelPickerUnavailable({
        sessionId: undefined,
        sessionContextKind: 'standalone',
        models: [{ id: 'coder-model(qwen-oauth)' }],
      }),
    ).toBe(true);
  });

  it('is available when the catalog has a user-selectable model', () => {
    expect(
      isStandaloneModelPickerUnavailable({
        sessionId: undefined,
        sessionContextKind: 'standalone',
        models: [
          { id: 'coder-model(qwen-oauth)' },
          { id: 'qwen3-max(USE_OPENAI)' },
        ],
      }),
    ).toBe(false);
  });
});
