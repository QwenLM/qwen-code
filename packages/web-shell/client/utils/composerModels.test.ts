/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isDiscontinuedSettingsModel,
  isStandaloneModelPickerUnavailable,
} from './composerModels';

describe('isDiscontinuedSettingsModel', () => {
  const oauth = { authType: 'qwen-oauth' };
  const registryRow = { baseModelId: 'coder-model', isRuntime: false };

  it('hides the registry entry of the discontinued built-in OAuth model', () => {
    expect(isDiscontinuedSettingsModel(oauth, registryRow)).toBe(true);
  });

  it('keeps a runtime snapshot of the same entry', () => {
    // A session already authenticated on the model must still see the one it
    // is running, which is the carve-out `isDiscontinuedModel` makes in the
    // VS Code webview.
    expect(
      isDiscontinuedSettingsModel(oauth, {
        baseModelId: 'coder-model',
        isRuntime: true,
      }),
    ).toBe(false);
  });

  it('keeps a same-named model on another auth type', () => {
    expect(
      isDiscontinuedSettingsModel({ authType: 'openai' }, registryRow),
    ).toBe(false);
  });

  it('keeps another model on the OAuth auth type', () => {
    expect(
      isDiscontinuedSettingsModel(oauth, {
        baseModelId: 'qwen3-coder-plus',
        isRuntime: false,
      }),
    ).toBe(false);
  });
});

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
