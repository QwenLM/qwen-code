/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  resolveToggleTarget,
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

  it('falls back to the current auth type when no provider owns the id', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['qwen3-coder'],
    });
    expect(
      resolveToggleTarget(config, 'unknown-model', AuthType.QWEN_OAUTH),
    ).toEqual({ modelId: 'unknown-model', authType: AuthType.QWEN_OAUTH });
  });

  it('strips a non-authType parenthesized suffix and treats it as a bare id', () => {
    const config = makeConfig({
      [AuthType.QWEN_OAUTH]: ['some-model(note)'],
    });
    expect(
      resolveToggleTarget(config, 'some-model(note)', AuthType.QWEN_OAUTH),
    ).toEqual({ modelId: 'some-model(note)', authType: AuthType.QWEN_OAUTH });
  });
});
