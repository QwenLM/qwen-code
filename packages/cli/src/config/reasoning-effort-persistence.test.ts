/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from './settings.js';
import { clearIncompatibleReasoningEffortForModel } from './reasoning-effort-persistence.js';

function makeSettings({
  isTrusted = true,
  system = {},
  systemDefaults = {},
  user = {},
  workspace = {},
}: {
  isTrusted?: boolean;
  system?: Record<string, unknown>;
  systemDefaults?: Record<string, unknown>;
  user?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
} = {}): { settings: LoadedSettings; setValue: ReturnType<typeof vi.fn> } {
  const setValue = vi.fn();
  return {
    settings: {
      isTrusted,
      system: { settings: system },
      systemDefaults: { settings: systemDefaults },
      user: { settings: user },
      workspace: { settings: workspace },
      setValue,
    } as unknown as LoadedSettings,
    setValue,
  };
}

function makeConfig(reasoningPreference?: string): {
  config: Config;
  setReasoningEffort: ReturnType<typeof vi.fn>;
} {
  const setReasoningEffort = vi.fn();
  return {
    config: {
      getReasoningPreference: vi.fn().mockReturnValue(reasoningPreference),
      setReasoningEffort,
    } as unknown as Config,
    setReasoningEffort,
  };
}

describe('clearIncompatibleReasoningEffortForModel', () => {
  it('clears persisted effort from every active writable scope', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
      workspace: { model: { reasoningEffort: 'high' } },
    });
    const { config, setReasoningEffort } = makeConfig('ultra');

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'qwen3.7-max'),
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
    const { config, setReasoningEffort } = makeConfig('ultra');

    expect(
      clearIncompatibleReasoningEffortForModel(
        config,
        settings,
        'qwen3.8-max-latest',
      ),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it('clears opaque effort for non-Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig('ultra');

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'glm-5.2'),
    ).toBe(true);
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.reasoningEffort',
      undefined,
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
  });

  it('preserves built-in effort for non-Qwen models', () => {
    const { settings, setValue } = makeSettings({
      user: { model: { reasoningEffort: 'high' } },
    });
    const { config, setReasoningEffort } = makeConfig('high');

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'glm-5.2'),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });

  it.each(['high', 'Vendor.Ultra'])(
    'clears live %s effort from a session-only toggle-only switch',
    (reasoningPreference) => {
      const { settings, setValue } = makeSettings({
        user: { model: { reasoningEffort: reasoningPreference } },
      });
      const { config, setReasoningEffort } = makeConfig(reasoningPreference);

      expect(
        clearIncompatibleReasoningEffortForModel(
          config,
          settings,
          'qwen3.7-max',
          false,
        ),
      ).toBe(true);
      expect(setValue).not.toHaveBeenCalled();
      expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
    },
  );

  it.each(['system', 'systemDefaults'] as const)(
    'clears a live incompatible effort owned by the read-only %s scope',
    (scope) => {
      const { settings, setValue } = makeSettings({
        [scope]: { model: { reasoningEffort: 'Vendor.Ultra' } },
      });
      const { config, setReasoningEffort } = makeConfig('Vendor.Ultra');

      expect(
        clearIncompatibleReasoningEffortForModel(
          config,
          settings,
          'qwen3.7-max',
        ),
      ).toBe(true);
      expect(setValue).not.toHaveBeenCalled();
      expect(setReasoningEffort).toHaveBeenCalledWith(undefined);
    },
  );

  it('ignores workspace persistence when the workspace is untrusted', () => {
    const { settings, setValue } = makeSettings({
      isTrusted: false,
      workspace: { model: { reasoningEffort: 'ultra' } },
    });
    const { config, setReasoningEffort } = makeConfig();

    expect(
      clearIncompatibleReasoningEffortForModel(config, settings, 'coder-model'),
    ).toBe(false);
    expect(setValue).not.toHaveBeenCalled();
    expect(setReasoningEffort).not.toHaveBeenCalled();
  });
});
