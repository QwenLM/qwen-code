/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend-facing integration tests for the dialog data/result wiring (R2):
 * model entries + selection persistence, theme application, permissions data
 * + mutations, and the MCP/extension feeds for the mounted dialogs.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// theme.ts (via the dialog modules) builds a SyntaxStyle at module scope,
// which needs the OpenTUI native FFI — unavailable in the test runtime. Stub
// the graphics surface like the other dialog tests do.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  AuthType,
  MCPServerStatus,
  type AvailableModel,
  type Config,
} from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import type { LoadedSettings, Settings } from '../../config/settings.js';
import { themeManager } from '../themes/theme-manager.js';
import {
  addPermissionRule,
  applyMcpServerAction,
  applyModelSelection,
  applyThemeSelection,
  buildExtensionRows,
  buildMcpServers,
  buildModelEntries,
  buildPermissionsData,
  computeModelDialogInitialKey,
  deletePermissionRule,
  enrichMcpOAuthState,
  getMcpServerResources,
  getMcpServerTools,
} from './dialog-data.js';
import type { McpServerInfo } from './dialogs-mcp.js';
import {
  buildModelSelectionKey,
  type OpenTuiModelEntry,
} from './dialogs-model.js';

interface WrittenValue {
  scope: SettingScope;
  key: string;
  value: unknown;
}

interface FakeSettings {
  settings: LoadedSettings;
  written: WrittenValue[];
}

function createFakeSettings(options?: {
  isTrusted?: boolean;
  user?: Settings;
  workspace?: Settings;
}): FakeSettings {
  const written: WrittenValue[] = [];
  const user = options?.user ?? {};
  const workspace = options?.workspace ?? {};
  const merged: Record<string, unknown> = {};
  const settings = {
    user: { settings: user },
    workspace: { settings: workspace },
    get merged() {
      return merged as Settings;
    },
    isTrusted: options?.isTrusted ?? false,
    setValue: (scope: SettingScope, key: string, value: unknown) => {
      written.push({ scope, key, value });
      if (key === 'ui.theme') {
        const ui = (merged['ui'] ?? {}) as Record<string, unknown>;
        ui['theme'] = value;
        const customThemes: Record<string, unknown> = {};
        for (const scopeSettings of [user, workspace]) {
          const uiCustomThemes = ((
            (scopeSettings.ui ?? {}) as Record<string, unknown>
          )['customThemes'] ?? {}) as Record<string, unknown>;
          Object.assign(customThemes, uiCustomThemes);
        }
        if (Object.keys(customThemes).length > 0) {
          ui['customThemes'] = customThemes;
        }
        merged['ui'] = ui;
      }
      if (key.startsWith('permissions.')) {
        const type = key.split('.')[1] as string;
        const permissions = (merged['permissions'] ?? {}) as Record<
          string,
          string[]
        >;
        permissions[type] = value as string[];
        merged['permissions'] = permissions;
        const target =
          scope === SettingScope.User
            ? user
            : scope === SettingScope.Workspace
              ? workspace
              : null;
        if (target) {
          (target as Record<string, unknown>)['permissions'] = permissions;
        }
      }
    },
    forScope: (scope: SettingScope) =>
      scope === SettingScope.User
        ? { settings: user }
        : { settings: workspace },
  } as unknown as LoadedSettings;
  return { settings, written };
}

function stubConfig(overrides: Partial<Config>): Config {
  return overrides as Config;
}

describe('buildModelEntries', () => {
  const models = [
    {
      id: 'm1',
      label: 'M1',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://provider.example',
      contextWindowSize: 8192,
    },
    {
      id: 'fast1',
      label: 'Fast',
      authType: AuthType.USE_OPENAI,
      fastOnly: true,
    },
    {
      id: 'img1',
      label: 'Image',
      authType: AuthType.USE_OPENAI,
      imageOnly: true,
    },
    {
      id: 'oauth1',
      label: 'OAuth',
      authType: AuthType.QWEN_OAUTH,
    },
    {
      id: 'rt1',
      label: 'Runtime',
      authType: AuthType.USE_OPENAI,
      isRuntimeModel: true,
      runtimeSnapshotId: '$runtime|openai|rt1',
    },
  ];

  it('lists registry + runtime models for the primary selector', () => {
    const config = stubConfig({
      getAllConfiguredModels: (() =>
        models) as Config['getAllConfiguredModels'],
      getAuthType: () => AuthType.USE_OPENAI,
    } as Partial<Config>);
    const entries = buildModelEntries(config, 'primary');
    const ids = entries.map((entry) => entry.modelId);
    expect(ids).toEqual(['m1', 'rt1']);
    expect(entries[0]?.key).toBe(
      buildModelSelectionKey(
        String(AuthType.USE_OPENAI),
        'm1',
        'https://provider.example',
      ),
    );
  });

  it('includes fast-only entries only in fast mode', () => {
    const config = stubConfig({
      getAllConfiguredModels: (() =>
        models) as Config['getAllConfiguredModels'],
      getAuthType: () => AuthType.USE_OPENAI,
    } as Partial<Config>);
    expect(
      buildModelEntries(config, 'fast').map((entry) => entry.modelId),
    ).toEqual(['m1', 'fast1', 'rt1']);
  });

  it('lists only image models in image mode', () => {
    const config = stubConfig({
      getAllConfiguredModels: (() =>
        models) as Config['getAllConfiguredModels'],
      getAuthType: () => AuthType.USE_OPENAI,
      resolveImageGenerationModel: ((selector: string) =>
        selector.includes('img1')
          ? { model: 'img1', baseUrl: 'https://img.example', apiKeyEnv: 'K' }
          : undefined) as Config['resolveImageGenerationModel'],
    } as Partial<Config>);
    expect(
      buildModelEntries(config, 'image').map((entry) => entry.modelId),
    ).toEqual(['img1']);
  });

  it('shows QWEN_OAUTH models only under that auth type', () => {
    const config = stubConfig({
      getAllConfiguredModels: (() =>
        models) as Config['getAllConfiguredModels'],
      getAuthType: () => AuthType.QWEN_OAUTH,
    } as Partial<Config>);
    expect(
      buildModelEntries(config, 'primary').map((entry) => entry.modelId),
    ).toContain('oauth1');
  });

  it('keys runtime rows by their snapshot id and carries the raw model', () => {
    const config = stubConfig({
      getAllConfiguredModels: (() =>
        models) as Config['getAllConfiguredModels'],
      getAuthType: () => AuthType.USE_OPENAI,
    } as Partial<Config>);
    const entries = buildModelEntries(config, 'primary');
    const runtime = entries.find((entry) => entry.modelId === 'rt1');
    expect(runtime?.key).toBe('$runtime|openai|rt1');
    expect(runtime?.model?.id).toBe('rt1');
  });

  it('drops image rows the runtime cannot resolve', () => {
    const noResolver = stubConfig({
      getAllConfiguredModels: (() =>
        models) as Config['getAllConfiguredModels'],
      getAuthType: () => AuthType.USE_OPENAI,
    } as Partial<Config>);
    expect(buildModelEntries(noResolver, 'image')).toEqual([]);

    const rejectingResolver = stubConfig({
      getAllConfiguredModels: (() =>
        models) as Config['getAllConfiguredModels'],
      getAuthType: () => AuthType.USE_OPENAI,
      resolveImageGenerationModel: (() =>
        undefined) as Config['resolveImageGenerationModel'],
    } as Partial<Config>);
    expect(buildModelEntries(rejectingResolver, 'image')).toEqual([]);
  });

  it('returns no entries without a config', () => {
    expect(buildModelEntries(undefined, 'primary')).toEqual([]);
  });
});

describe('applyModelSelection', () => {
  function modelRow(
    model: Partial<AvailableModel> & { id: string },
  ): OpenTuiModelEntry {
    const full: AvailableModel = {
      label: model.id,
      authType: AuthType.USE_OPENAI,
      ...model,
    };
    const key = buildModelSelectionKey(
      String(full.authType),
      full.id,
      full.baseUrl,
    );
    return {
      key,
      value: key,
      authType: String(full.authType),
      label: full.label,
      modelId: full.id,
      model: full,
    };
  }

  function resolvedConfig(overrides: Partial<Config>): Config {
    return stubConfig({
      getAuthType: () => AuthType.USE_OPENAI,
      getContentGeneratorConfig: (() => ({
        authType: AuthType.USE_OPENAI,
        model: 'm2',
        baseUrl: 'https://provider.example',
        apiKey: 'sk-1234567',
      })) as Config['getContentGeneratorConfig'],
      getUsageStatisticsEnabled: (() =>
        false) as Config['getUsageStatisticsEnabled'],
      ...overrides,
    } as Partial<Config>);
  }

  describe('primary mode (default selection)', () => {
    it('switches the runtime model before persisting model.name', async () => {
      const switchModel = vi.fn(async () => {});
      const config = resolvedConfig({
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [
        modelRow({ id: 'm2', baseUrl: 'https://provider.example' }),
      ];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'primary',
        selectionKey: entries[0].key,
      });

      expect(switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'm2',
        expect.objectContaining({ baseUrl: 'https://provider.example' }),
      );
      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'model.name',
        value: 'm2',
      });
      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'model.baseUrl',
        value: 'https://provider.example',
      });
      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'security.auth.selectedType',
        value: AuthType.USE_OPENAI,
      });
      // Persisted only after the runtime switch resolved, with its outcome.
      expect(
        written.findIndex((write) => write.key === 'model.name'),
      ).toBeGreaterThan(-1);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.message).toContain('Using model: m2');
      }
    });

    it('does not persist before the switch resolves', async () => {
      const writesSeenDuringSwitch: number[] = [];
      const { settings, written } = createFakeSettings();
      const switchModel = vi.fn(async () => {
        writesSeenDuringSwitch.push(written.length);
      });
      const config = resolvedConfig({
        switchModel: switchModel as Config['switchModel'],
      });
      const entries = [modelRow({ id: 'm2' })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'primary',
        selectionKey: entries[0].key,
      });

      expect(outcome.ok).toBe(true);
      expect(writesSeenDuringSwitch).toEqual([0]);
    });

    it('keeps the dialog open and settings untouched when switchModel fails', async () => {
      const switchModel = vi.fn(async () => {
        throw new Error('network down');
      });
      const config = resolvedConfig({
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [modelRow({ id: 'm2' })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'primary',
        selectionKey: entries[0].key,
      });

      expect(switchModel).toHaveBeenCalled();
      expect(written).toEqual([]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain("Failed to switch model to 'm2'.");
        expect(outcome.error).toContain('network down');
      }
    });

    it('honors an explicit persist scope and falls back for untrusted workspaces', async () => {
      const trusted = createFakeSettings({ isTrusted: true });
      await applyModelSelection({
        config: resolvedConfig({
          switchModel: (async () => {}) as Config['switchModel'],
        }),
        settings: trusted.settings,
        entries: [modelRow({ id: 'm2' })],
        mode: 'primary',
        selectionKey: buildModelSelectionKey(String(AuthType.USE_OPENAI), 'm2'),
        persistScope: 'workspace',
      });
      expect(
        trusted.written.every(
          (write) => write.scope === SettingScope.Workspace,
        ),
      ).toBe(true);

      const untrusted = createFakeSettings({ isTrusted: false });
      await applyModelSelection({
        config: resolvedConfig({
          switchModel: (async () => {}) as Config['switchModel'],
        }),
        settings: untrusted.settings,
        entries: [modelRow({ id: 'm2' })],
        mode: 'primary',
        selectionKey: buildModelSelectionKey(String(AuthType.USE_OPENAI), 'm2'),
        persistScope: 'workspace',
      });
      expect(
        untrusted.written.every((write) => write.scope === SettingScope.User),
      ).toBe(true);
    });

    it('blocks discontinued qwen-oauth selections without switching', async () => {
      const switchModel = vi.fn(async () => {});
      const config = resolvedConfig({
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [
        modelRow({ id: 'old-model', authType: AuthType.QWEN_OAUTH }),
      ];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'primary',
        selectionKey: entries[0].key,
      });

      expect(switchModel).not.toHaveBeenCalled();
      expect(written).toEqual([]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain('discontinued');
      }
    });

    it('passes runtime snapshot ids straight to switchModel', async () => {
      const switchModel = vi.fn(async () => {});
      const config = resolvedConfig({
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings } = createFakeSettings();
      const snapshotId = `$runtime|${AuthType.USE_OPENAI}|rt-model`;

      const outcome = await applyModelSelection({
        config,
        settings,
        entries: [],
        mode: 'primary',
        selectionKey: snapshotId,
      });

      expect(outcome.ok).toBe(true);
      expect(switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        snapshotId,
        expect.objectContaining({ baseUrl: undefined }),
      );
    });
  });

  describe('mode-specific selections', () => {
    it('fast mode writes fastModel and syncs Config.setFastModel', async () => {
      const setFastModel = vi.fn();
      const switchModel = vi.fn(async () => {});
      const config = resolvedConfig({
        setFastModel: setFastModel as Config['setFastModel'],
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [modelRow({ id: 'fast1' })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'fast',
        selectionKey: entries[0].key,
      });

      expect(setFastModel).toHaveBeenCalledWith('openai:fast1');
      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'fastModel',
        value: 'openai:fast1',
      });
      expect(
        written.find((write) => write.key === 'model.name'),
      ).toBeUndefined();
      expect(switchModel).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.message).toContain('Fast Model: openai:fast1');
      }
    });

    it('vision mode writes visionModel and syncs Config.setVisionModel', async () => {
      const setVisionModel = vi.fn();
      const switchModel = vi.fn(async () => {});
      const config = resolvedConfig({
        setVisionModel: setVisionModel as Config['setVisionModel'],
        isCurrentPrimaryModel: (() => false) as Config['isCurrentPrimaryModel'],
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [
        modelRow({
          id: 'qv',
          baseUrl: 'https://v.example',
          modalities: { image: true },
        }),
      ];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'vision',
        selectionKey: entries[0].key,
      });

      expect(setVisionModel).toHaveBeenCalledWith(
        'openai:qv\0https://v.example',
      );
      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'visionModel',
        value: 'openai:qv\0https://v.example',
      });
      expect(
        written.find((write) => write.key === 'model.name'),
      ).toBeUndefined();
      expect(switchModel).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
    });

    it('vision mode rejects pinning the current primary model', async () => {
      const setVisionModel = vi.fn();
      const config = resolvedConfig({
        setVisionModel: setVisionModel as Config['setVisionModel'],
        isCurrentPrimaryModel: (() => true) as Config['isCurrentPrimaryModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [modelRow({ id: 'qv' })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'vision',
        selectionKey: entries[0].key,
      });

      expect(setVisionModel).not.toHaveBeenCalled();
      expect(written).toEqual([]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain('current primary model');
      }
    });

    it('compaction mode writes compactionModel and syncs Config.setCompactionModel', async () => {
      const setCompactionModel = vi.fn();
      const switchModel = vi.fn(async () => {});
      const config = resolvedConfig({
        setCompactionModel: setCompactionModel as Config['setCompactionModel'],
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [modelRow({ id: 'compact1' })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'compaction',
        selectionKey: entries[0].key,
      });

      expect(setCompactionModel).toHaveBeenCalledWith('openai:compact1');
      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'compactionModel',
        value: 'openai:compact1',
      });
      expect(
        written.find((write) => write.key === 'model.name'),
      ).toBeUndefined();
      expect(switchModel).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
    });

    it('image mode applies the runtime image model before persisting imageModel', async () => {
      const setImageModel = vi.fn(async () => {});
      const switchModel = vi.fn(async () => {});
      const baseUrl = 'https://img.example/v1';
      const selector = `openai:img-gen\0${baseUrl}`;
      const config = resolvedConfig({
        setImageModel: setImageModel as Config['setImageModel'],
        resolveImageGenerationModel: ((candidate: string) =>
          candidate === selector
            ? { model: 'img-gen', baseUrl, apiKeyEnv: 'IMG_KEY' }
            : undefined) as Config['resolveImageGenerationModel'],
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [modelRow({ id: 'img-gen', baseUrl, imageOnly: true })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'image',
        selectionKey: entries[0].key,
      });

      expect(setImageModel).toHaveBeenCalledWith(selector);
      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'imageModel',
        value: selector,
      });
      expect(
        written.find((write) => write.key === 'model.name'),
      ).toBeUndefined();
      expect(switchModel).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
    });

    it('image mode rejects models the runtime cannot resolve', async () => {
      const setImageModel = vi.fn(async () => {});
      const config = resolvedConfig({
        setImageModel: setImageModel as Config['setImageModel'],
        resolveImageGenerationModel: (() =>
          undefined) as Config['resolveImageGenerationModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [modelRow({ id: 'img-gen', imageOnly: true })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'image',
        selectionKey: entries[0].key,
      });

      expect(setImageModel).not.toHaveBeenCalled();
      expect(written).toEqual([]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain('valid HTTPS baseUrl');
      }
    });

    it('voice mode writes voiceModel for a selectable ASR model', async () => {
      const setFastModel = vi.fn();
      const switchModel = vi.fn(async () => {});
      const config = resolvedConfig({
        setFastModel: setFastModel as Config['setFastModel'],
        switchModel: switchModel as Config['switchModel'],
      });
      const { settings, written } = createFakeSettings();
      const entries = [
        modelRow({
          id: 'qwen3-asr-flash',
          baseUrl: 'https://asr.example/v1',
        }),
      ];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'voice',
        selectionKey: entries[0].key,
      });

      expect(written).toContainEqual({
        scope: SettingScope.User,
        key: 'voiceModel',
        value: 'qwen3-asr-flash',
      });
      expect(
        written.find((write) => write.key === 'model.name'),
      ).toBeUndefined();
      expect(switchModel).not.toHaveBeenCalled();
      expect(setFastModel).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
    });

    it('voice mode rejects models without transcription support', async () => {
      const config = resolvedConfig({});
      const { settings, written } = createFakeSettings();
      const entries = [modelRow({ id: 'qwen3-coder' })];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'voice',
        selectionKey: entries[0].key,
      });

      expect(written).toEqual([]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain('cannot be used for transcription');
      }
    });

    it('voice mode rejects duplicate model ids across providers', async () => {
      const config = resolvedConfig({});
      const { settings, written } = createFakeSettings();
      const entries = [
        modelRow({
          id: 'qwen3-asr-flash',
          baseUrl: 'https://asr-one.example/v1',
        }),
        modelRow({
          id: 'qwen3-asr-flash',
          baseUrl: 'https://asr-two.example/v1',
        }),
      ];

      const outcome = await applyModelSelection({
        config,
        settings,
        entries,
        mode: 'voice',
        selectionKey: entries[0].key,
      });

      expect(written).toEqual([]);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error).toContain('configured more than once');
      }
    });
  });
});

describe('applyThemeSelection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cancels silently for an undefined theme', () => {
    const { settings, written } = createFakeSettings();
    expect(applyThemeSelection(settings, undefined, SettingScope.User)).toEqual(
      {},
    );
    expect(written).toEqual([]);
  });

  it('persists and applies a valid theme', () => {
    const setActiveTheme = vi
      .spyOn(themeManager, 'setActiveTheme')
      .mockReturnValue(true);
    const { settings, written } = createFakeSettings();
    const result = applyThemeSelection(settings, 'Default', SettingScope.User);
    expect(result).toEqual({ applied: 'Default' });
    expect(written).toContainEqual({
      scope: SettingScope.User,
      key: 'ui.theme',
      value: 'Default',
    });
    expect(setActiveTheme).toHaveBeenCalledWith('Default');
  });

  it('applies a scope-local custom theme', () => {
    const setActiveTheme = vi
      .spyOn(themeManager, 'setActiveTheme')
      .mockReturnValue(true);
    const loadCustomThemes = vi
      .spyOn(themeManager, 'loadCustomThemes')
      .mockImplementation(() => {});
    const { settings } = createFakeSettings({
      user: {
        ui: { customThemes: { mytheme: { name: 'mytheme' } } },
      } as unknown as Settings,
    });
    const result = applyThemeSelection(settings, 'mytheme', SettingScope.User);
    expect(result).toEqual({ applied: 'mytheme' });
    expect(loadCustomThemes).toHaveBeenCalled();
    expect(setActiveTheme).toHaveBeenCalledWith('mytheme');
  });

  it('rejects themes unknown to the selected scope', () => {
    vi.spyOn(themeManager, 'setActiveTheme').mockReturnValue(false);
    const { settings } = createFakeSettings();
    const result = applyThemeSelection(
      settings,
      'no-such-theme',
      SettingScope.User,
    );
    expect(result.applied).toBeUndefined();
    expect(result.error).toContain('no-such-theme');
  });
});

describe('permissions data and mutations', () => {
  const addPersistentRule = vi.fn();
  const removePersistentRule = vi.fn();
  const config = stubConfig({
    getPermissionManager: (() => ({
      listRules: () => [
        {
          rule: { raw: 'Bash(git *)', toolName: 'Bash' },
          type: 'allow',
          scope: 'user',
        },
        {
          rule: { raw: 'Write', toolName: 'Write' },
          type: 'deny',
          scope: 'session',
        },
      ],
      addPersistentRule,
      removePersistentRule,
    })) as unknown as Config['getPermissionManager'],
    getWorkspaceContext: (() => ({
      getDirectories: () => ['/workspace/a'],
      getInitialDirectories: () => ['/workspace/a'],
    })) as unknown as Config['getWorkspaceContext'],
  } as Partial<Config>);

  afterEach(() => {
    addPersistentRule.mockClear();
    removePersistentRule.mockClear();
  });

  it('maps PermissionManager rules and workspace directories', () => {
    const data = buildPermissionsData(config);
    expect(data.rules).toEqual([
      { raw: 'Bash(git *)', toolName: 'Bash', type: 'allow', scope: 'user' },
      { raw: 'Write', toolName: 'Write', type: 'deny', scope: 'session' },
    ]);
    expect(data.directories).toEqual(['/workspace/a']);
    expect(data.initialDirectories).toEqual(['/workspace/a']);
  });

  it('adds a rule to the manager and persists it to the chosen scope', () => {
    const { settings, written } = createFakeSettings();
    addPermissionRule(
      config,
      settings,
      'Read(./src/**)',
      'allow',
      SettingScope.Workspace,
    );
    expect(addPersistentRule).toHaveBeenCalledWith('Read(./src/**)', 'allow');
    expect(written).toContainEqual({
      scope: SettingScope.Workspace,
      key: 'permissions.allow',
      value: ['Read(./src/**)'],
    });
  });

  it('does not duplicate an already-present rule', () => {
    const { settings, written } = createFakeSettings({
      user: { permissions: { allow: ['Bash(git *)'] } } as Settings,
    });
    // Reflect the existing rule in the merged view the code reads.
    (settings.merged as Record<string, unknown>)['permissions'] = {
      allow: ['Bash(git *)'],
    };
    addPermissionRule(
      config,
      settings,
      'Bash(git *)',
      'allow',
      SettingScope.User,
    );
    expect(written).toEqual([]);
  });

  it('deletes a rule from the manager and the persisting scope', () => {
    const { settings, written } = createFakeSettings({
      user: { permissions: { allow: ['Bash(git *)'] } } as Settings,
    });
    deletePermissionRule(config, settings, 'Bash(git *)', 'allow');
    expect(removePersistentRule).toHaveBeenCalledWith('Bash(git *)', 'allow');
    expect(written).toContainEqual({
      scope: SettingScope.User,
      key: 'permissions.allow',
      value: [],
    });
  });
});

describe('mcp and extension feeds', () => {
  const config = stubConfig({
    getMcpServers: (() => ({
      docs: { command: 'npx docs-mcp', scope: 'project' },
      legacy: {},
    })) as unknown as Config['getMcpServers'],
    getToolRegistry: (() => ({
      getAllTools: () => [
        { serverName: 'docs', name: 'search', description: 'Search docs' },
        { serverName: 'docs', name: 'broken' },
        { serverName: 'other', name: 'unrelated' },
      ],
    })) as unknown as Config['getToolRegistry'],
    getPromptRegistry: (() => ({
      getAllPrompts: () => [],
    })) as unknown as Config['getPromptRegistry'],
    getResourceRegistry: (() => ({
      getResourcesByServer: () => [],
    })) as unknown as Config['getResourceRegistry'],
    isMcpServerDisabled: ((name: string) =>
      name === 'legacy') as Config['isMcpServerDisabled'],
  } as Partial<Config>);

  it('builds the MCP server inventory from config + registries', () => {
    const servers = buildMcpServers(config);
    expect(servers).toHaveLength(2);
    const docs = servers.find((server) => server.name === 'docs');
    expect(docs).toMatchObject({
      source: 'project',
      toolCount: 2,
      invalidToolCount: 1,
      isDisabled: false,
      command: 'npx docs-mcp',
    });
    expect(docs?.status).toBeTruthy();
    const legacy = servers.find((server) => server.name === 'legacy');
    expect(legacy).toMatchObject({ source: 'user', isDisabled: true });
  });

  it('feeds the tool list for one server', () => {
    const tools = getMcpServerTools(config, 'docs');
    expect(tools).toEqual([
      { name: 'search', description: 'Search docs', isValid: true },
      { name: 'broken', isValid: false },
    ]);
  });

  it('builds extension rows from the loaded extensions', () => {
    const rows = buildExtensionRows(
      stubConfig({
        getExtensions: (() => [
          { name: 'ext-one', path: '/x/ext-one', isActive: true },
          { name: 'ext-two', path: '/x/ext-two', isActive: false },
        ]) as unknown as Config['getExtensions'],
      } as Partial<Config>),
    );
    expect(rows).toEqual([
      { key: 'ext-one', label: 'ext-one', meta: '/x/ext-one', enabled: true },
      { key: 'ext-two', label: 'ext-two', meta: '/x/ext-two', enabled: false },
    ]);
  });

  it('feeds the resource list for one server', () => {
    const config = stubConfig({
      getResourceRegistry: (() => ({
        getResourcesByServer: (name: string) =>
          name === 'docs'
            ? [{ uri: 'file:///a.md', name: 'a', title: 'Doc A' }]
            : [],
      })) as unknown as Config['getResourceRegistry'],
    } as Partial<Config>);
    expect(getMcpServerResources(config, 'docs')).toEqual([
      { uri: 'file:///a.md', name: 'a', title: 'Doc A' },
    ]);
    expect(getMcpServerResources(config, 'other')).toEqual([]);
  });
});

describe('MCP OAuth enrichment (real token state)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function serverInfo(name: string): McpServerInfo {
    return {
      name,
      status: MCPServerStatus.DISCONNECTED,
      source: 'user',
      toolCount: 0,
      invalidToolCount: 0,
      promptCount: 0,
      resourceCount: 0,
      isDisabled: false,
      hasOAuthTokens: false,
      requiresAuth: false,
    };
  }

  it('reads hasOAuthTokens from the token storage and derives requiresAuth', async () => {
    const { MCPOAuthTokenStorage } = await import('@qwen-code/qwen-code-core');
    vi.spyOn(
      MCPOAuthTokenStorage.prototype,
      'getCredentials',
    ).mockImplementation(async (name: string) =>
      name === 'with-token' ? ({} as never) : null,
    );
    const config = stubConfig({
      getMcpServers: (() => ({
        'with-token': { oauth: { enabled: true } },
        'no-token-oauth': { oauth: { enabled: true } },
        plain: {},
      })) as unknown as Config['getMcpServers'],
    } as Partial<Config>);
    const enriched = await enrichMcpOAuthState(config, [
      serverInfo('with-token'),
      serverInfo('no-token-oauth'),
      serverInfo('plain'),
    ]);
    expect(enriched[0]).toMatchObject({
      hasOAuthTokens: true,
      requiresAuth: false,
    });
    expect(enriched[1]).toMatchObject({
      hasOAuthTokens: false,
      requiresAuth: true,
    });
    expect(enriched[2]).toMatchObject({
      hasOAuthTokens: false,
      requiresAuth: false,
    });
  });
});

vi.mock('../../config/mcpApprovals.js', () => ({
  loadMcpApprovals: () => ({ setState: vi.fn() }),
}));

describe('applyMcpServerAction (real server actions)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function serverInfo(overrides: Partial<McpServerInfo>): McpServerInfo {
    return {
      name: 'srv',
      status: MCPServerStatus.DISCONNECTED,
      source: 'user',
      toolCount: 0,
      invalidToolCount: 0,
      promptCount: 0,
      resourceCount: 0,
      isDisabled: false,
      hasOAuthTokens: false,
      requiresAuth: false,
      ...overrides,
    };
  }

  it('reconnect rediscovers the server tools', async () => {
    const discoverToolsForServer = vi.fn(async () => {});
    const config = stubConfig({
      getToolRegistry: (() => ({
        discoverToolsForServer,
      })) as unknown as Config['getToolRegistry'],
    } as Partial<Config>);
    const { settings } = createFakeSettings();
    const result = await applyMcpServerAction(
      config,
      settings,
      serverInfo({}),
      'reconnect',
    );
    expect(discoverToolsForServer).toHaveBeenCalledWith('srv');
    expect(result.changed).toBe(true);
  });

  it('disable writes mcp.excluded to the user scope and disables the server', async () => {
    const disableMcpServer = vi.fn(async () => {});
    const config = stubConfig({
      getMcpServers: (() => ({
        srv: {},
      })) as unknown as Config['getMcpServers'],
      getToolRegistry: (() => ({
        disableMcpServer,
      })) as unknown as Config['getToolRegistry'],
    } as Partial<Config>);
    const { settings, written } = createFakeSettings();
    const result = await applyMcpServerAction(
      config,
      settings,
      serverInfo({}),
      'toggle-disable',
    );
    expect(disableMcpServer).toHaveBeenCalledWith('srv');
    expect(written).toContainEqual({
      scope: SettingScope.User,
      key: 'mcp.excluded',
      value: ['srv'],
    });
    expect(result.message).toContain('Disabled');
  });

  it('project-scoped servers disable into the workspace scope', async () => {
    const disableMcpServer = vi.fn(async () => {});
    const config = stubConfig({
      getMcpServers: (() => ({
        srv: { scope: 'project' },
      })) as unknown as Config['getMcpServers'],
      getToolRegistry: (() => ({
        disableMcpServer,
      })) as unknown as Config['getToolRegistry'],
    } as Partial<Config>);
    const { settings, written } = createFakeSettings();
    await applyMcpServerAction(
      config,
      settings,
      serverInfo({ source: 'project' }),
      'toggle-disable',
    );
    expect(
      written.some(
        (w) => w.scope === SettingScope.Workspace && w.key === 'mcp.excluded',
      ),
    ).toBe(true);
  });

  it('enable removes the exclusion and rediscovers', async () => {
    const discoverToolsForServer = vi.fn(async () => {});
    const setExcludedMcpServers = vi.fn();
    const config = stubConfig({
      getMcpServers: (() => ({
        srv: {},
      })) as unknown as Config['getMcpServers'],
      getToolRegistry: (() => ({
        discoverToolsForServer,
      })) as unknown as Config['getToolRegistry'],
      getExcludedMcpServers: (() => [
        'srv',
      ]) as unknown as Config['getExcludedMcpServers'],
      setExcludedMcpServers,
    } as Partial<Config>);
    const { settings, written } = createFakeSettings({
      user: { mcp: { excluded: ['srv'] } } as Settings,
    });
    const result = await applyMcpServerAction(
      config,
      settings,
      serverInfo({ isDisabled: true }),
      'toggle-disable',
    );
    expect(discoverToolsForServer).toHaveBeenCalledWith('srv');
    expect(setExcludedMcpServers).toHaveBeenCalledWith([]);
    expect(
      written.some(
        (w) => w.key === 'mcp.excluded' && (w.value as string[]).length === 0,
      ),
    ).toBe(true);
    expect(result.message).toContain('Enabled');
  });

  it('clear-auth deletes stored tokens and disconnects', async () => {
    const { MCPOAuthTokenStorage } = await import('@qwen-code/qwen-code-core');
    const deleteCredentials = vi
      .spyOn(MCPOAuthTokenStorage.prototype, 'deleteCredentials')
      .mockResolvedValue(undefined);
    const disconnectServer = vi.fn(async () => {});
    const config = stubConfig({
      getToolRegistry: (() => ({
        disconnectServer,
      })) as unknown as Config['getToolRegistry'],
    } as Partial<Config>);
    const { settings } = createFakeSettings();
    const result = await applyMcpServerAction(
      config,
      settings,
      serverInfo({ hasOAuthTokens: true }),
      'clear-auth',
    );
    expect(deleteCredentials).toHaveBeenCalledWith('srv');
    expect(disconnectServer).toHaveBeenCalledWith('srv');
    expect(result.changed).toBe(true);
  });

  it('reports failures instead of throwing', async () => {
    const config = stubConfig({
      getToolRegistry: (() => ({
        discoverToolsForServer: async () => {
          throw new Error('boom');
        },
      })) as unknown as Config['getToolRegistry'],
    } as Partial<Config>);
    const { settings } = createFakeSettings();
    const result = await applyMcpServerAction(
      config,
      settings,
      serverInfo({}),
      'reconnect',
    );
    expect(result.message).toContain('boom');
  });
});

describe('computeModelDialogInitialKey (/model opens on the current model)', () => {
  function entry(overrides: Partial<OpenTuiModelEntry>): OpenTuiModelEntry {
    return {
      key: overrides.key ?? 'key',
      value: overrides.key ?? 'key',
      authType: 'api_key',
      label: overrides.label ?? 'Model',
      modelId: overrides.modelId ?? overrides.model?.id ?? 'model',
      ...overrides,
    } as OpenTuiModelEntry;
  }

  const baseEntries = [
    entry({
      key: buildModelSelectionKey(
        AuthType.USE_OPENAI,
        'm1',
        'https://provider.example',
      ),
      authType: AuthType.USE_OPENAI,
      modelId: 'm1',
    }),
    entry({
      key: buildModelSelectionKey(AuthType.USE_OPENAI, 'm2'),
      authType: AuthType.USE_OPENAI,
      modelId: 'm2',
    }),
  ];

  it('highlights the exact current auth/model/baseUrl row in primary mode', () => {
    const { settings } = createFakeSettings();
    const key = computeModelDialogInitialKey({
      config: stubConfig({
        getModel: () => 'm1',
        getAuthType: () => AuthType.USE_OPENAI,
        getContentGeneratorConfig: (() => ({
          baseUrl: 'https://provider.example',
        })) as Config['getContentGeneratorConfig'],
      } as Partial<Config>),
      settings,
      entries: baseEntries,
      mode: 'primary',
    });
    expect(key).toBe(baseEntries[0].key);
  });

  it('falls back to the same-id row when the baseUrl drifted', () => {
    const { settings } = createFakeSettings();
    const key = computeModelDialogInitialKey({
      config: stubConfig({
        getModel: () => 'm2',
        getAuthType: () => AuthType.USE_OPENAI,
        getContentGeneratorConfig: (() => ({
          baseUrl: 'https://moved.example',
        })) as Config['getContentGeneratorConfig'],
      } as Partial<Config>),
      settings,
      entries: baseEntries,
      mode: 'primary',
    });
    expect(key).toBe(baseEntries[1].key);
  });

  it('prefers the active runtime snapshot id when present', () => {
    const { settings } = createFakeSettings();
    const snapshotEntry = entry({ key: '$runtime|api_key|m1', modelId: 'm1' });
    const key = computeModelDialogInitialKey({
      config: stubConfig({
        getModel: () => 'm2',
        getAuthType: () => AuthType.USE_OPENAI,
        getActiveRuntimeModelSnapshot: (() => ({
          id: '$runtime|api_key|m1',
        })) as Config['getActiveRuntimeModelSnapshot'],
      } as Partial<Config>),
      settings,
      entries: [...baseEntries, snapshotEntry],
      mode: 'primary',
    });
    expect(key).toBe('$runtime|api_key|m1');
  });

  it('highlights the entry owning the persisted aux selector', () => {
    const settings = {
      merged: { fastModel: `${AuthType.USE_OPENAI}:m1` },
    } as unknown as LoadedSettings;
    const key = computeModelDialogInitialKey({
      config: stubConfig({}),
      settings,
      entries: baseEntries,
      mode: 'fast',
    });
    expect(key).toBe(baseEntries[0].key);
  });

  it('returns undefined without a current model (dialog starts on row 1)', () => {
    const { settings } = createFakeSettings();
    const key = computeModelDialogInitialKey({
      config: stubConfig({ getModel: () => 'unknown-model' }),
      settings,
      entries: baseEntries,
      mode: 'primary',
    });
    expect(key).toBeUndefined();
    expect(
      computeModelDialogInitialKey({
        config: stubConfig({}),
        settings,
        entries: [],
        mode: 'primary',
      }),
    ).toBeUndefined();
  });
});
