/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  resolveToggleTarget,
  computeToggleAction,
  needsCachedCredentials,
  type ToggleModelProviderLookup,
} from './resolve-toggle-model.js';

function makeConfig(modelsByAuthType: {
  [authType: string]: string[];
}): ToggleModelProviderLookup {
  return {
    getAvailableModelsForAuthType: (authType: AuthType) =>
      (modelsByAuthType[authType] ?? []).map((id) => ({ id })),
  };
}

describe('resolveToggleTarget', () => {
  it('honors an explicit provider-qualified suffix', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['qwen3-coder'],
      [AuthType.USE_OPENAI]: ['gpt-4'],
    });
    expect(
      resolveToggleTarget(
        config,
        `gpt-4(${AuthType.USE_OPENAI})`,
        AuthType.QWEN_OAUTH,
      ),
    ).toEqual({ modelId: 'gpt-4', authType: AuthType.USE_OPENAI });
  });

  it('uses the qualified auth type even when the current provider also owns the id', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['qwen3-coder'],
      [AuthType.USE_OPENAI]: ['qwen3-coder'],
    });
    expect(
      resolveToggleTarget(
        config,
        `qwen3-coder(${AuthType.USE_OPENAI})`,
        AuthType.QWEN_OAUTH,
      ),
    ).toEqual({ modelId: 'qwen3-coder', authType: AuthType.USE_OPENAI });
  });

  it('keeps the current auth type for an unqualified same-provider model', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['qwen3-coder', 'qwen3-max'],
    });
    expect(
      resolveToggleTarget(config, 'qwen3-max', AuthType.QWEN_OAUTH),
    ).toEqual({ modelId: 'qwen3-max', authType: AuthType.QWEN_OAUTH });
  });

  it('prefers the current auth type when multiple providers own the id', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['shared-model'],
      [AuthType.USE_OPENAI]: ['shared-model'],
    });
    expect(
      resolveToggleTarget(config, 'shared-model', AuthType.USE_OPENAI),
    ).toEqual({ modelId: 'shared-model', authType: AuthType.USE_OPENAI });
  });

  it('resolves the owning provider for an unqualified cross-provider model', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['qwen3-coder'],
      [AuthType.USE_OPENAI]: ['gpt-4'],
    });
    expect(resolveToggleTarget(config, 'gpt-4', AuthType.QWEN_OAUTH)).toEqual({
      modelId: 'gpt-4',
      authType: AuthType.USE_OPENAI,
    });
  });

  it('picks the first enum-order provider when multiple non-current providers own the id', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['qwen3-coder'],
      [AuthType.USE_GEMINI]: ['shared-model'],
      [AuthType.USE_VERTEX_AI]: ['shared-model'],
    });
    // Current provider (qwen-oauth) does not own 'shared-model'.
    // Both gemini and vertex-ai do — gemini comes first in AuthType enum order.
    expect(
      resolveToggleTarget(config, 'shared-model', AuthType.QWEN_OAUTH),
    ).toEqual({ modelId: 'shared-model', authType: AuthType.USE_GEMINI });
  });

  it('falls back to the current auth type when no provider owns the id', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['qwen3-coder'],
    });
    expect(
      resolveToggleTarget(config, 'unknown-model', AuthType.QWEN_OAUTH),
    ).toEqual({ modelId: 'unknown-model', authType: AuthType.QWEN_OAUTH });
  });

  it('keeps a non-authType parenthesized suffix as part of the bare model id', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['some-model(note)'],
    });
    expect(
      resolveToggleTarget(config, 'some-model(note)', AuthType.QWEN_OAUTH),
    ).toEqual({ modelId: 'some-model(note)', authType: AuthType.QWEN_OAUTH });
  });
});

describe('computeToggleAction', () => {
  const target = { modelId: 'model-b', authType: AuthType.USE_OPENAI };

  it('returns no-auth when currentAuthType is undefined', () => {
    expect(computeToggleAction('model-a', undefined, target, null)).toEqual({
      type: 'no-auth',
    });
  });

  it('returns forward with previous snapshot when not on target', () => {
    expect(
      computeToggleAction('model-a', AuthType.USE_OPENAI, target, null),
    ).toEqual({
      type: 'forward',
      target,
      previous: { modelId: 'model-a', authType: AuthType.USE_OPENAI },
    });
  });

  it('returns backward when already on target and previousModel exists', () => {
    const prev = { modelId: 'model-a', authType: AuthType.USE_OPENAI };
    expect(
      computeToggleAction('model-b', AuthType.USE_OPENAI, target, prev),
    ).toEqual({ type: 'backward', previous: prev });
  });

  it('returns already-on when on target with no previousModel', () => {
    expect(
      computeToggleAction('model-b', AuthType.USE_OPENAI, target, null),
    ).toEqual({ type: 'already-on', modelId: 'model-b' });
  });

  it('returns forward when model id matches but authType differs', () => {
    const qwenTarget = { modelId: 'shared', authType: AuthType.QWEN_OAUTH };
    expect(
      computeToggleAction('shared', AuthType.USE_OPENAI, qwenTarget, null),
    ).toEqual({
      type: 'forward',
      target: qwenTarget,
      previous: { modelId: 'shared', authType: AuthType.USE_OPENAI },
    });
  });

  it('returns forward (not stale backward) after external model change invalidates previousModel', () => {
    // Scenario: user toggles to model-b (sets previous=model-a), then
    // switches to model-c via /model. onModelChange fires with
    // isTogglingRef=false → previousModelRef is nulled. Next Ctrl+F
    // must do a fresh forward toggle, not jump back to stale model-a.
    const afterInvalidation = null; // previousModelRef cleared by onModelChange
    expect(
      computeToggleAction(
        'model-c',
        AuthType.USE_OPENAI,
        target,
        afterInvalidation,
      ),
    ).toEqual({
      type: 'forward',
      target,
      previous: { modelId: 'model-c', authType: AuthType.USE_OPENAI },
    });
  });
});

describe('needsCachedCredentials', () => {
  it('returns true when switching into qwen-oauth from another provider', () => {
    expect(
      needsCachedCredentials(AuthType.QWEN_OAUTH, AuthType.USE_OPENAI),
    ).toBe(true);
  });

  it('returns false when staying on the same provider', () => {
    expect(
      needsCachedCredentials(AuthType.QWEN_OAUTH, AuthType.QWEN_OAUTH),
    ).toBe(false);
  });

  it('returns false when switching into a non-qwen-oauth provider', () => {
    expect(
      needsCachedCredentials(AuthType.USE_OPENAI, AuthType.QWEN_OAUTH),
    ).toBe(false);
  });
});
