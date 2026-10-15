/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  HIDDEN_COMPOSER_MODEL_IDS,
  isDiscontinuedSettingsModel,
  isStandaloneModelPickerUnavailable,
} from './composerModels';

describe('isDiscontinuedSettingsModel', () => {
  const oauth = { authType: 'qwen-oauth' };
  const registryRow = { baseModelId: 'coder-model', isCurrent: false };

  it('hides the registry entry of the discontinued built-in OAuth model', () => {
    expect(isDiscontinuedSettingsModel(oauth, registryRow)).toBe(true);
  });

  it('keeps the row the session is currently running', () => {
    // The daemon's provider list skips runtime rows and hardcodes
    // `isRuntime: false`, so `isCurrent` is the only signal that a live
    // qwen-oauth session still needs its own model listed.
    expect(
      isDiscontinuedSettingsModel(oauth, {
        baseModelId: 'coder-model',
        isCurrent: true,
      }),
    ).toBe(false);
  });

  it('keeps a same-named model on another auth type', () => {
    expect(
      isDiscontinuedSettingsModel({ authType: 'openai' }, registryRow),
    ).toBe(false);
  });

  it('derives the hidden ids from HIDDEN_COMPOSER_MODEL_IDS', () => {
    // The composer hides `coder-model(qwen-oauth)`; Settings must reach the
    // same verdict for every id on that shared list instead of hardcoding one.
    for (const id of HIDDEN_COMPOSER_MODEL_IDS) {
      const parsed = /^(.*)\(([^)]+)\)$/.exec(id);
      expect(parsed).not.toBeNull();
      expect(
        isDiscontinuedSettingsModel(
          { authType: parsed[2] },
          { baseModelId: parsed[1], isCurrent: false },
        ),
      ).toBe(true);
    }
  });

  it('keeps another model on the OAuth auth type', () => {
    expect(
      isDiscontinuedSettingsModel(oauth, {
        baseModelId: 'qwen3-coder-plus',
        isCurrent: false,
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
