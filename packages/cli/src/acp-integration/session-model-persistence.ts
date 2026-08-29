/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  buildRuntimeSnapshotId,
  createDebugLogger,
  stripRuntimeSnapshotPrefix,
  type Config,
  type SessionModelRecordPayload,
  type SessionRestoreProjection,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { clearIncompatibleReasoningEffortForModel } from '../config/reasoning-effort-persistence.js';

const debugLogger = createDebugLogger('SESSION_MODEL');
const AUTH_TYPES = new Set<string>(Object.values(AuthType));

function isAuthType(value: string): value is AuthType {
  return AUTH_TYPES.has(value);
}

function registryHonoredBaseUrl(
  config: Config,
  authType: AuthType,
  modelId: string,
  baseUrl: string | undefined,
): string | undefined {
  if (typeof baseUrl !== 'string' || !baseUrl) {
    return undefined;
  }
  return config.getResolvedModelConfig?.(authType, modelId, baseUrl)
    ? baseUrl
    : undefined;
}

export async function recordDaemonSessionModel(
  config: Config,
  payload: SessionModelRecordPayload,
): Promise<void> {
  const recording = config.getChatRecordingService?.();
  if (!recording?.recordSessionModel) return;
  try {
    await recording.recordSessionModel(payload);
  } catch (error) {
    debugLogger.debug('recordSessionModel failed', error);
  }
}

export async function recordDaemonSessionModelFromConfig(
  config: Config,
): Promise<void> {
  const modelId = config.getModel()?.trim();
  const authType = config.getAuthType();
  if (!modelId || !authType) return;
  const snapshot = config.getActiveRuntimeModelSnapshot?.();
  // `null` is the implicit-registry sentinel; do not coerce it to the resolved
  // default endpoint or restore can pick an explicit same-id route.
  const registryBaseUrl = snapshot
    ? undefined
    : config.getCurrentModelRegistryBaseUrl?.();
  await recordDaemonSessionModel(config, {
    modelId,
    authType,
    ...(typeof registryBaseUrl === 'string'
      ? { baseUrl: registryBaseUrl }
      : {}),
    ...(snapshot ? { isRuntime: true } : {}),
  });
}

function hasMatchingRuntimeSnapshot(
  config: Config,
  authType: string,
  modelId: string,
): boolean {
  const snapshot = config.getActiveRuntimeModelSnapshot?.();
  return snapshot?.authType === authType && snapshot.modelId === modelId;
}

function liveAuthType(config: Config): string | undefined {
  return (
    config.getAuthType() ?? config.getModelsConfig?.()?.getCurrentAuthType?.()
  );
}

function runtimeSnapshotIdentity(
  snapshot: { id?: string; authType?: string; modelId?: string } | undefined,
): string | undefined {
  if (!snapshot) return undefined;
  if (typeof snapshot.id === 'string' && snapshot.id) {
    return snapshot.id;
  }
  if (snapshot.authType && snapshot.modelId) {
    return buildRuntimeSnapshotId(snapshot.authType, snapshot.modelId);
  }
  return undefined;
}

function recordedRouteMatches(
  recorded: SessionModelRecordPayload | undefined,
  currentRegistryBaseUrl: string | null | undefined,
): boolean {
  if (!recorded || recorded.isRuntime) return true;
  const targetBaseUrl = recorded.baseUrl;
  if (targetBaseUrl === undefined) {
    return (
      currentRegistryBaseUrl === null || currentRegistryBaseUrl === undefined
    );
  }
  if (targetBaseUrl === '') {
    return (
      currentRegistryBaseUrl === null ||
      currentRegistryBaseUrl === undefined ||
      currentRegistryBaseUrl === ''
    );
  }
  return currentRegistryBaseUrl === targetBaseUrl;
}

export async function applyRestoredSessionModel(
  config: Config,
  projection: SessionRestoreProjection | undefined,
  settings: LoadedSettings,
): Promise<void> {
  const recorded = projection?.runtime.recording.sessionModel;
  const fallbackModel = projection?.runtime.recording.lastAssistantModel;
  const recordedAuth = recorded?.authType?.trim();
  const authType = (
    recordedAuth && isAuthType(recordedAuth)
      ? recordedAuth
      : liveAuthType(config)
  )?.trim();
  const modelId = recorded?.modelId || fallbackModel;
  if (!modelId?.trim() || !authType || !isAuthType(authType)) return;

  const currentModel = stripRuntimeSnapshotPrefix(config.getModel() ?? '');
  const currentAuth = liveAuthType(config);
  const targetModel = stripRuntimeSnapshotPrefix(modelId.trim());
  const targetBaseUrl = recorded?.isRuntime
    ? undefined
    : registryHonoredBaseUrl(config, authType, targetModel, recorded?.baseUrl);
  const recordedRoute = recorded
    ? {
        ...recorded,
        ...(targetBaseUrl
          ? { baseUrl: targetBaseUrl }
          : { baseUrl: undefined }),
      }
    : undefined;
  const currentRegistryBaseUrl = config.getCurrentModelRegistryBaseUrl?.();
  const baseUrlMatches = recordedRouteMatches(
    recordedRoute,
    currentRegistryBaseUrl,
  );
  const currentRuntimeMatches = hasMatchingRuntimeSnapshot(
    config,
    authType,
    targetModel,
  );
  // Same id/auth/route is not a no-op when the record is implicit registry
  // but Config currently holds a same-id runtime snapshot.
  if (
    currentModel === targetModel &&
    currentAuth === authType &&
    baseUrlMatches &&
    !(recorded && !recorded.isRuntime && currentRuntimeMatches)
  ) {
    return;
  }

  const useRuntimeSnapshot =
    Boolean(recorded?.isRuntime) &&
    hasMatchingRuntimeSnapshot(config, authType, targetModel);
  const switchModelId = useRuntimeSnapshot
    ? buildRuntimeSnapshotId(authType, targetModel)
    : targetModel;
  const requireCachedCredentials =
    authType === AuthType.QWEN_OAUTH && currentAuth !== authType;
  const switchOptions =
    targetBaseUrl || requireCachedCredentials
      ? {
          ...(targetBaseUrl ? { baseUrl: targetBaseUrl } : {}),
          ...(requireCachedCredentials
            ? { requireCachedCredentials: true }
            : {}),
        }
      : undefined;
  try {
    const previousModelRouteIdentity = config.getModelRouteIdentity?.();
    await config.switchModel(authType, switchModelId, switchOptions);
    clearIncompatibleReasoningEffortForModel(
      config,
      settings,
      targetModel,
      false,
      previousModelRouteIdentity,
    );
  } catch (error) {
    debugLogger.warn(
      `restore session model failed (${targetModel}/${authType}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function restoreSessionModelThenAuthenticate(
  config: Config,
  projection: SessionRestoreProjection | undefined,
  authenticate: () => Promise<void>,
  settings: LoadedSettings,
): Promise<void> {
  const originalAuth = liveAuthType(config);
  const originalModel = config.getModel();
  const originalBaseUrl = config.getCurrentModelRegistryBaseUrl?.();
  const originalRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
  const originalReasoningPreference = config.getReasoningPreference?.();
  await applyRestoredSessionModel(config, projection, settings);
  try {
    await authenticate();
  } catch (error) {
    if (
      liveAuthType(config) === originalAuth &&
      config.getModel() === originalModel &&
      (config.getCurrentModelRegistryBaseUrl?.() ?? undefined) ===
        (originalBaseUrl ?? undefined) &&
      runtimeSnapshotIdentity(config.getActiveRuntimeModelSnapshot?.()) ===
        runtimeSnapshotIdentity(originalRuntimeSnapshot)
    ) {
      throw error;
    }
    debugLogger.warn(
      'restored session model made authentication fail; retrying with settings model',
    );
    if (!originalAuth || !originalModel) {
      throw error;
    }
    const rollbackModelId =
      originalRuntimeSnapshot?.authType === originalAuth &&
      originalRuntimeSnapshot.modelId ===
        stripRuntimeSnapshotPrefix(originalModel)
        ? buildRuntimeSnapshotId(
            originalAuth,
            stripRuntimeSnapshotPrefix(originalModel),
          )
        : originalModel;
    try {
      await config.switchModel(
        originalAuth as AuthType,
        rollbackModelId,
        typeof originalBaseUrl === 'string'
          ? { baseUrl: originalBaseUrl }
          : undefined,
      );
    } catch {
      throw error;
    }
    if (originalReasoningPreference === false) {
      config.disableReasoning();
    } else if (typeof originalReasoningPreference === 'string') {
      config.setReasoningEffort(originalReasoningPreference);
    }
    await authenticate();
  }
}
