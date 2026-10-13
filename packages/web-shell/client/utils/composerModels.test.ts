/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { RUNTIME_SNAPSHOT_PREFIX } from '@qwen-code/qwen-code-core/utils/runtimeModelPrefix.js';
import { QWEN_OAUTH_MODELS } from '@qwen-code/qwen-code-core/models/constants.js';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import {
  isVisibleComposerModel,
  isStandaloneModelPickerUnavailable,
} from './composerModels';

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

describe('isVisibleComposerModel discontinued OAuth rule', () => {
  it.each([
    ...QWEN_OAUTH_MODELS.map((model) => model.id),
    'qwen3-coder-plus',
    'model(with-parens)',
  ])('hides any registry OAuth route: %s', (id) => {
    expect(
      isVisibleComposerModel({ id: `${id}(${AuthType.QWEN_OAUTH})` }),
    ).toBe(false);
  });
  it.each(['coder-model', 'qwen3-coder-plus'])(
    'preserves runtime snapshots and other providers: %s',
    (id) => {
      expect(
        isVisibleComposerModel({
          id: `${RUNTIME_SNAPSHOT_PREFIX}qwen-oauth|${id}(qwen-oauth)`,
        }),
      ).toBe(true);
      expect(isVisibleComposerModel({ id: `${id}(openai)` })).toBe(true);
    },
  );
  it('trims the route before checking the trailing auth marker', () => {
    expect(
      isVisibleComposerModel({ id: '  qwen3-coder-plus(qwen-oauth)  ' }),
    ).toBe(false);
  });
});
