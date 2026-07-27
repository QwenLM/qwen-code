/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonCapabilities,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  loadVoiceProviders,
  loadVoiceStatus,
  resolveVoiceWorkspaceTarget,
  setVoiceModelSetting,
  supportsVoiceCapture,
  supportsVoiceModelSettings,
} from './voice-workspace-target';

function capabilities(
  overrides: Partial<DaemonCapabilities> = {},
): DaemonCapabilities {
  return {
    v: 1,
    mode: 'http-bridge',
    features: [],
    modelServices: [],
    ...overrides,
  };
}

const primary: DaemonWorkspaceCapability = {
  id: 'primary',
  cwd: '/repo/primary',
  primary: true,
  trusted: false,
};
const secondary: DaemonWorkspaceCapability = {
  id: 'secondary id',
  cwd: '/repo/secondary',
  primary: false,
  trusted: true,
};

describe('resolveVoiceWorkspaceTarget', () => {
  it('keeps a registered primary on legacy routes without a new trust gate', () => {
    const target = resolveVoiceWorkspaceTarget({
      capabilities: capabilities({ workspaces: [primary, secondary] }),
      intendedCwd: primary.cwd,
    });

    expect(target).toMatchObject({
      route: 'legacy-primary',
      cwd: primary.cwd,
      streamPath: 'voice/stream',
    });
  });

  it('uses a unique secondary id and encodes it once', () => {
    const target = resolveVoiceWorkspaceTarget({
      capabilities: capabilities({ workspaces: [primary, secondary] }),
      intendedCwd: secondary.cwd,
      sessionId: 'session-1',
    });

    expect(target).toMatchObject({
      route: 'workspace-qualified',
      cwd: secondary.cwd,
      selector: { kind: 'id', value: secondary.id },
      streamPath: 'workspaces/secondary%20id/voice/stream',
      sessionId: 'session-1',
    });
    expect(target?.ownerKey).toContain('session-1');
  });

  it('falls back to an encoded cwd for duplicate or empty ids', () => {
    const target = resolveVoiceWorkspaceTarget({
      capabilities: capabilities({
        workspaces: [primary, { ...secondary, id: '', cwd: '/repo/二 次' }],
      }),
      intendedCwd: '/repo/二 次',
    });

    expect(target).toMatchObject({
      route: 'workspace-qualified',
      selector: { kind: 'cwd', value: '/repo/二 次' },
      streamPath: 'workspaces/%2Frepo%2F%E4%BA%8C%20%E6%AC%A1/voice/stream',
    });
  });

  it('falls back to cwd when a non-empty id is duplicated', () => {
    const target = resolveVoiceWorkspaceTarget({
      capabilities: capabilities({
        workspaces: [primary, secondary, { ...secondary, cwd: '/repo/other' }],
      }),
      intendedCwd: secondary.cwd,
    });

    expect(target).toMatchObject({
      route: 'workspace-qualified',
      selector: { kind: 'cwd', value: secondary.cwd },
      streamPath: 'workspaces/%2Frepo%2Fsecondary/voice/stream',
    });
  });

  it.each([
    [
      'Windows drive',
      'C:\\repo\\voice',
      'workspaces/C%3A%5Crepo%5Cvoice/voice/stream',
    ],
    [
      'UNC',
      '\\\\server\\share\\voice',
      'workspaces/%5C%5Cserver%5Cshare%5Cvoice/voice/stream',
    ],
  ])('encodes a %s cwd selector once', (_label, cwd, streamPath) => {
    const target = resolveVoiceWorkspaceTarget({
      capabilities: capabilities({
        workspaces: [primary, { ...secondary, id: '', cwd, trusted: true }],
      }),
      intendedCwd: cwd,
    });

    expect(target).toMatchObject({
      route: 'workspace-qualified',
      selector: { kind: 'cwd', value: cwd },
      streamPath,
    });
  });

  it('fails closed for an untrusted secondary target', () => {
    expect(
      resolveVoiceWorkspaceTarget({
        capabilities: capabilities({
          workspaces: [primary, { ...secondary, trusted: false }],
        }),
        intendedCwd: secondary.cwd,
      }),
    ).toBeUndefined();
  });

  it('fails closed for unknown and ambiguous secondary targets', () => {
    const duplicate = { ...secondary, id: 'other' };
    const caps = capabilities({
      workspaces: [primary, secondary, duplicate],
    });

    expect(
      resolveVoiceWorkspaceTarget({
        capabilities: caps,
        intendedCwd: secondary.cwd,
      }),
    ).toBeUndefined();
    expect(
      resolveVoiceWorkspaceTarget({
        capabilities: caps,
        intendedCwd: '/repo/missing',
      }),
    ).toBeUndefined();
  });

  it('requires a live modern session to report its workspace cwd', () => {
    expect(
      resolveVoiceWorkspaceTarget({
        capabilities: capabilities({ workspaces: [primary, secondary] }),
        intendedCwd: undefined,
        sessionId: 'session-1',
      }),
    ).toBeUndefined();
  });

  it('preserves old single-workspace and opaque legacy daemons', () => {
    expect(
      resolveVoiceWorkspaceTarget({
        capabilities: capabilities({ workspaceCwd: '/legacy' }),
        intendedCwd: '/legacy',
      }),
    ).toMatchObject({ route: 'legacy-primary', cwd: '/legacy' });
    const opaque = resolveVoiceWorkspaceTarget({
      capabilities: capabilities(),
      intendedCwd: undefined,
    });
    expect(opaque).toMatchObject({ route: 'legacy-primary' });
    expect(opaque?.cwd).toBeUndefined();
  });

  it.each([
    'dynamic_workspace_registration',
    'persistent_workspace_registration',
    'scratch_workspace_registration',
    'workspace_display_name',
    'workspace_runtime_removal',
    'multi_workspace_sessions',
    'multi_workspace_session_shell',
    'workspace_qualified_rest_core',
    'workspace_qualified_voice',
  ])('does not synthesize opaque legacy ownership with %s', (feature) => {
    expect(
      resolveVoiceWorkspaceTarget({
        capabilities: capabilities({
          features: [feature],
        }),
        intendedCwd: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('Voice target operation gates', () => {
  const legacy = resolveVoiceWorkspaceTarget({
    capabilities: capabilities({ workspaces: [primary] }),
    intendedCwd: primary.cwd,
  });
  const qualified = resolveVoiceWorkspaceTarget({
    capabilities: capabilities({ workspaces: [primary, secondary] }),
    intendedCwd: secondary.cwd,
  });

  it('separates dictation from secondary model/settings support', () => {
    expect(supportsVoiceCapture(legacy, ['voice_transcribe'])).toBe(true);
    expect(supportsVoiceCapture(qualified, ['workspace_qualified_voice'])).toBe(
      true,
    );
    expect(
      supportsVoiceModelSettings(qualified, ['workspace_qualified_voice']),
    ).toBe(false);
    expect(
      supportsVoiceModelSettings(qualified, [
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ]),
    ).toBe(true);
  });

  it('keeps legacy model settings available without dictation', () => {
    expect(supportsVoiceCapture(legacy, [])).toBe(false);
    expect(supportsVoiceModelSettings(legacy, [])).toBe(true);
  });
});

describe('Voice target route adapters', () => {
  it('uses qualified reads and workspace writes without primary fallback', async () => {
    const workspaceVoice = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: secondary.cwd,
      enabled: true,
      mode: 'tap',
      language: 'en',
      voiceModel: null,
      availableVoiceModels: [],
    });
    const workspaceProviders = vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: secondary.cwd,
      initialized: true,
      providers: [],
    });
    const setWorkspaceSetting = vi.fn().mockResolvedValue({
      key: 'voiceModel',
      scope: 'workspace',
      value: 'voice-1',
      requiresRestart: false,
    });
    const rootVoice = vi.fn();
    const rootProviders = vi.fn();
    const rootSet = vi.fn();
    const client = {
      workspaceVoice: rootVoice,
      workspaceProviders: rootProviders,
      setWorkspaceSetting: rootSet,
      workspaceById: vi.fn(() => ({
        workspaceVoice,
        workspaceProviders,
        setWorkspaceSetting,
      })),
    };
    const target = resolveVoiceWorkspaceTarget({
      capabilities: capabilities({ workspaces: [primary, secondary] }),
      intendedCwd: secondary.cwd,
    });
    if (!target) throw new Error('expected qualified target');

    await expect(
      loadVoiceStatus(client as never, target),
    ).resolves.toMatchObject({ workspaceCwd: secondary.cwd });
    await expect(
      loadVoiceProviders(client as never, target),
    ).resolves.toMatchObject({ workspaceCwd: secondary.cwd });
    await setVoiceModelSetting(client as never, target, 'workspace', 'voice-1');

    expect(client.workspaceById).toHaveBeenCalledWith(secondary.id);
    expect(workspaceVoice).toHaveBeenCalledTimes(1);
    expect(workspaceProviders).toHaveBeenCalledTimes(1);
    expect(setWorkspaceSetting).toHaveBeenCalledWith(
      'workspace',
      'voiceModel',
      'voice-1',
    );
    expect(rootVoice).not.toHaveBeenCalled();
    expect(rootProviders).not.toHaveBeenCalled();
    expect(rootSet).not.toHaveBeenCalled();
  });

  it('rejects a response for the wrong workspace', async () => {
    const client = {
      workspaceById: vi.fn(() => ({
        workspaceVoice: vi.fn().mockResolvedValue({
          v: 1,
          workspaceCwd: '/wrong',
          enabled: true,
          mode: 'tap',
          language: 'en',
          voiceModel: null,
          availableVoiceModels: [],
        }),
      })),
    };
    const target = resolveVoiceWorkspaceTarget({
      capabilities: capabilities({ workspaces: [primary, secondary] }),
      intendedCwd: secondary.cwd,
    });
    if (!target) throw new Error('expected qualified target');

    await expect(loadVoiceStatus(client as never, target)).rejects.toThrow(
      'does not match',
    );
  });
});
