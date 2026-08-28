/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from './settings.js';
import { clearReasoningEffortForToggleOnlyModel } from './reasoning-effort-persistence.js';

function makeSettings({
  isTrusted = true,
  user = {},
  workspace = {},
}: {
  isTrusted?: boolean;
  user?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
} = {}): { settings: LoadedSettings; setValue: ReturnType<typeof vi.fn> } {
  const setValue = vi.fn();
  return {
    settings: {
      isTrusted,
      user: { settings: user },
      workspace: { settings: workspace },
      setValue,
    } as unknown as LoadedSettings,
    setValue,
  };
}

function makeConfig(): {
  config: Config;
  setReasoningEffort: ReturnType<typeof vi.fn>;
} {
  const setReasoningEffort = vi.fn();
  return {
    config: { setReasoningEffort } as unknown as Config,
    setReasoningEffort,
  };
}

describe('clearReasoningEffortForToggleOnlyModel', () => {
  it('clears persisted effort from every active writable scope', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
      workspace: { model: { reasoningEffort: 'high' } },
    });
    const { config, setReasoningEffort } = makeConfig();

    expect(
      clearReasoningEffortForToggleOnlyModel(config, settings, 'qwen3.7-max'),
    ).toBe(true);
    expect(setValue).toHaveBeenNthCalledWith(
      1,
      SettingScope.Workspace,
      'model.reasoningEffort',
      undefined,
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(setValue).toHaveBeenNthCalledWith(
      2,
      SettingScope.User,
      'model.reasoningEffort',
      undefined,
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
  });

  it('does not clear effort for tiered Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig();

    expect(
      clearReasoningEffortForToggleOnlyModel(
        config,
        settings,
        'qwen3.8-max-latest',
      ),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('does not clear effort for non-Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig();

    expect(
      clearReasoningEffortForToggleOnlyModel(config, settings, 'glm-5.2'),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('ignores workspace persistence when the workspace is untrusted', () => {
    const { settings, setValue } = makeSettings({
      isTrusted: false,
      workspace: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig();

    expect(
      clearReasoningEffortForToggleOnlyModel(config, settings, 'coder-model'),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });
});
