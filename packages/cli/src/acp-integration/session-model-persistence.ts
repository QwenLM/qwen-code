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

const debugLogger = createDebugLogger('SESSION_MODEL');

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
): Promise<void> {
  const recorded = projection?.runtime.recording.sessionModel;
  const fallbackModel = projection?.runtime.recording.lastAssistantModel;
  const authType = (recorded?.authType || liveAuthType(config))?.trim();
  const modelId = recorded?.modelId || fallbackModel;
  if (!modelId?.trim() || !authType) return;

  const currentModel = stripRuntimeSnapshotPrefix(config.getModel() ?? '');
  const currentAuth = liveAuthType(config);
  const targetModel = stripRuntimeSnapshotPrefix(modelId.trim());
  const targetBaseUrl = recorded?.baseUrl;
  const currentRegistryBaseUrl = config.getCurrentModelRegistryBaseUrl?.();
  const baseUrlMatches = recordedRouteMatches(recorded, currentRegistryBaseUrl);
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
    await config.switchModel(
      authType as AuthType,
      switchModelId,
      switchOptions,
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
): Promise<void> {
  const originalAuth = liveAuthType(config);
  const originalModel = config.getModel();
  const originalBaseUrl = config.getCurrentModelRegistryBaseUrl?.();
  const originalRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
  await applyRestoredSessionModel(config, projection);
  try {
    await authenticate();
  } catch (error) {
    if (
      liveAuthType(config) === originalAuth &&
      config.getModel() === originalModel &&
      (config.getCurrentModelRegistryBaseUrl?.() ?? undefined) ===
        (originalBaseUrl ?? undefined)
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
    await authenticate();
  }
}
