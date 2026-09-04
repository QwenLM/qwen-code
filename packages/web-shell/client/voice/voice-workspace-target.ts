/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonCapabilities,
  DaemonClient,
  DaemonSettingUpdateResult,
  DaemonWorkspaceCapability,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceSettingsStatus,
  DaemonWorkspaceVoiceStatus,
} from '@qwen-code/sdk/daemon';

const PRIMARY_VOICE_FEATURE = 'voice_transcribe';
const QUALIFIED_VOICE_FEATURE = 'workspace_qualified_voice';
const QUALIFIED_CORE_FEATURE = 'workspace_qualified_rest_core';
const WORKSPACE_SETTINGS_FEATURE = 'workspace_settings';

const MODERN_WORKSPACE_FEATURES = new Set([
  'dynamic_workspace_registration',
  'persistent_workspace_registration',
  'scratch_workspace_registration',
  'workspace_display_name',
  'workspace_runtime_removal',
]);

interface VoiceTargetBase {
  cwd?: string;
  workspaceKey: string;
  ownerKey: string;
  sessionId?: string;
}

export type VoiceWorkspaceTarget =
  | (VoiceTargetBase & {
      route: 'legacy-primary';
      streamPath: 'voice/stream';
    })
  | (VoiceTargetBase & {
      route: 'workspace-qualified';
      cwd: string;
      selector: {
        kind: 'id' | 'cwd';
        value: string;
      };
      streamPath: string;
    });

export interface VoiceStatusRevision {
  user: number;
  workspace: number;
}

export interface ResolveVoiceWorkspaceTargetOptions {
  capabilities: DaemonCapabilities | undefined;
  intendedCwd: string | undefined;
  sessionId?: string;
  /**
   * Pass App's merged list when a locked workspace has been registered before
   * the next capabilities snapshot arrives.
   */
  workspaces?: readonly DaemonWorkspaceCapability[];
}

type VoiceTargetWithoutOwner =
  | {
      route: 'legacy-primary';
      cwd?: string;
      workspaceKey: string;
      streamPath: 'voice/stream';
    }
  | {
      route: 'workspace-qualified';
      cwd: string;
      workspaceKey: string;
      selector: {
        kind: 'id' | 'cwd';
        value: string;
      };
      streamPath: string;
    };

function key(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

function hasModernWorkspaceFeature(features: readonly string[]): boolean {
  return features.some(
    (feature) =>
      MODERN_WORKSPACE_FEATURES.has(feature) ||
      feature.startsWith('multi_workspace_') ||
      feature.startsWith('workspace_qualified_'),
  );
}

function withOwner(
  target: VoiceTargetWithoutOwner,
  sessionId: string | undefined,
): VoiceWorkspaceTarget {
  return {
    ...target,
    ...(sessionId ? { sessionId } : {}),
    ownerKey: key([
      target.workspaceKey,
      sessionId ? ['session', sessionId] : ['draft'],
    ]),
  } as VoiceWorkspaceTarget;
}

function legacyTarget(
  cwd: string | undefined,
  sessionId: string | undefined,
): VoiceWorkspaceTarget {
  return withOwner(
    {
      route: 'legacy-primary',
      ...(cwd ? { cwd } : {}),
      workspaceKey: key(['legacy-primary', cwd ?? null]),
      streamPath: 'voice/stream',
    },
    sessionId,
  );
}

export function resolveVoiceWorkspaceTarget({
  capabilities,
  intendedCwd,
  sessionId,
  workspaces,
}: ResolveVoiceWorkspaceTargetOptions): VoiceWorkspaceTarget | undefined {
  if (!capabilities) return undefined;

  const registered = workspaces ?? capabilities.workspaces;
  const primaryCwd =
    registered?.find((workspace) => workspace.primary)?.cwd ??
    capabilities.workspaceCwd;
  const cwd = intendedCwd ?? (sessionId ? undefined : primaryCwd);

  if (registered) {
    if (!cwd) return undefined;
    const matches = registered.filter((workspace) => workspace.cwd === cwd);
    if (matches.length !== 1) return undefined;
    const workspace = matches[0];
    if (workspace.kind === 'live') return undefined;
    if (workspace.primary) return legacyTarget(workspace.cwd, sessionId);
    if (!workspace.trusted) return undefined;

    const usableId = workspace.id.trim() ? workspace.id : undefined;
    const idIsUnique =
      usableId !== undefined &&
      registered.filter((entry) => entry.id === usableId).length === 1;
    const selector = idIsUnique
      ? ({ kind: 'id', value: usableId } as const)
      : ({ kind: 'cwd', value: workspace.cwd } as const);
    const workspaceKey = key([
      'workspace-qualified',
      selector.kind,
      selector.value,
      workspace.cwd,
    ]);
    return withOwner(
      {
        route: 'workspace-qualified',
        cwd: workspace.cwd,
        workspaceKey,
        selector,
        streamPath: `workspaces/${encodeURIComponent(selector.value)}/voice/stream`,
      },
      sessionId,
    );
  }

  if (capabilities.workspaceCwd) {
    if (cwd !== capabilities.workspaceCwd) return undefined;
    return legacyTarget(capabilities.workspaceCwd, sessionId);
  }

  if (!intendedCwd && !hasModernWorkspaceFeature(capabilities.features)) {
    return legacyTarget(undefined, sessionId);
  }

  return undefined;
}

export function supportsVoiceCapture(
  target: VoiceWorkspaceTarget | undefined,
  features: readonly string[],
): boolean {
  if (!target) return false;
  return features.includes(
    target.route === 'legacy-primary'
      ? PRIMARY_VOICE_FEATURE
      : QUALIFIED_VOICE_FEATURE,
  );
}

export function supportsVoiceModelSettings(
  target: VoiceWorkspaceTarget | undefined,
  features: readonly string[],
): boolean {
  if (!target) return false;
  if (target.route === 'legacy-primary') return true;
  return [
    QUALIFIED_VOICE_FEATURE,
    QUALIFIED_CORE_FEATURE,
    WORKSPACE_SETTINGS_FEATURE,
  ].every((feature) => features.includes(feature));
}

function qualifiedClient(client: DaemonClient, target: VoiceWorkspaceTarget) {
  if (target.route !== 'workspace-qualified') return undefined;
  return target.selector.kind === 'id'
    ? client.workspaceById(target.selector.value)
    : client.workspaceByCwd(target.selector.value);
}

export async function loadVoiceStatus(
  client: DaemonClient,
  target: VoiceWorkspaceTarget,
): Promise<DaemonWorkspaceVoiceStatus> {
  const status =
    target.route === 'legacy-primary'
      ? await client.workspaceVoice()
      : await qualifiedClient(client, target)!.workspaceVoice();
  if (target.cwd && status.workspaceCwd !== target.cwd) {
    throw new Error(
      'Voice status workspace does not match the selected target.',
    );
  }
  return status;
}

export async function loadVoiceProviders(
  client: DaemonClient,
  target: VoiceWorkspaceTarget,
): Promise<DaemonWorkspaceProvidersStatus> {
  const status =
    target.route === 'legacy-primary'
      ? await client.workspaceProviders()
      : await qualifiedClient(client, target)!.workspaceProviders();
  if (target.cwd && status.workspaceCwd !== target.cwd) {
    throw new Error(
      'Voice provider workspace does not match the selected target.',
    );
  }
  return status;
}

export async function loadVoiceSettings(
  client: DaemonClient,
  target: VoiceWorkspaceTarget,
): Promise<DaemonWorkspaceSettingsStatus> {
  return target.route === 'legacy-primary'
    ? await client.workspaceSettings()
    : await qualifiedClient(client, target)!.workspaceSettings();
}

export async function setVoiceModelSetting(
  client: DaemonClient,
  target: VoiceWorkspaceTarget,
  scope: 'workspace' | 'user',
  value: string,
): Promise<DaemonSettingUpdateResult> {
  if (target.route === 'workspace-qualified' && scope === 'workspace') {
    return await qualifiedClient(client, target)!.setWorkspaceSetting(
      'workspace',
      'voiceModel',
      value,
    );
  }
  return await client.setWorkspaceSetting(scope, 'voiceModel', value);
}
