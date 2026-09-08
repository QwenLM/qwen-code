/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DaemonSkillInstallRequest,
  DaemonWorkspaceRuntimeStatus,
} from '@qwen-code/sdk/daemon';
import { useDaemonWorkspaceEventSignals } from '../../session/DaemonSessionProvider.js';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';
import { useWorkspaceEventReload } from './useWorkspaceEventReload.js';

interface DaemonSkillsOptions extends DaemonResourceOptions {
  workspaceCwd?: string;
}

const RUNTIME_STATUS_POLL_MS = 5_000;

function requireLegacyPrimary(workspaceMismatch: boolean): void {
  if (workspaceMismatch) {
    throw new Error(
      'Legacy Skills management supports only the primary workspace.',
    );
  }
}

export function useDaemonSkills(options: DaemonSkillsOptions = {}) {
  const { actions, capabilities, client, workspaceCwd } = useDaemonWorkspace();
  const { workspaceCwd: requestedWorkspaceCwd, ...resourceOptions } = options;
  const targetWorkspaceCwd = requestedWorkspaceCwd ?? workspaceCwd;
  const workspaceClient = useMemo(
    () =>
      targetWorkspaceCwd
        ? client.workspaceByCwd(targetWorkspaceCwd)
        : undefined,
    [client, targetWorkspaceCwd],
  );
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<Error>();
  const splitRuntimeAvailable =
    capabilities?.features.includes('workspace_skills_config_runtime') === true;
  const legacyWorkspaceMismatch =
    requestedWorkspaceCwd !== undefined &&
    requestedWorkspaceCwd !== workspaceCwd;
  const loadConfig = useCallback(() => {
    if (!splitRuntimeAvailable) {
      requireLegacyPrimary(legacyWorkspaceMismatch);
      return actions.loadSkillsStatus();
    }
    if (!workspaceClient) throw new Error('Workspace is unavailable.');
    return workspaceClient.workspaceConfigSkills();
  }, [
    actions,
    legacyWorkspaceMismatch,
    splitRuntimeAvailable,
    workspaceClient,
  ]);
  const loadRuntime = useCallback(() => {
    if (!workspaceClient) throw new Error('Workspace is unavailable.');
    return workspaceClient.workspaceRuntimeSkills();
  }, [workspaceClient]);
  const config = useDaemonResource(loadConfig, resourceOptions);
  const runtime = useDaemonResource(loadRuntime, {
    ...resourceOptions,
    autoLoad: false,
    enabled: resourceOptions.enabled !== false && splitRuntimeAvailable,
  });
  const reloadConfig = config.reload;
  const reloadRuntime = runtime.reload;
  const [coordinatorStatus, setCoordinatorStatus] = useState<
    DaemonWorkspaceRuntimeStatus | undefined
  >();
  const ensureRuntime = useCallback(async () => {
    if (!splitRuntimeAvailable || !workspaceClient) return undefined;
    setPreparing(true);
    setPrepareError(undefined);
    try {
      const prepared = await workspaceClient.ensureRuntime();
      setCoordinatorStatus(prepared);
      const capabilityError = prepared.capabilities?.skills?.error;
      if (capabilityError) setPrepareError(new Error(capabilityError.message));
      return await reloadRuntime();
    } catch (error) {
      setPrepareError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return undefined;
    } finally {
      setPreparing(false);
    }
  }, [reloadRuntime, splitRuntimeAvailable, workspaceClient]);
  useEffect(() => {
    if (!splitRuntimeAvailable || !workspaceClient || !coordinatorStatus) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observe = async () => {
      try {
        const latest = await workspaceClient.runtimeStatus();
        if (cancelled) return;
        const currentSkills = coordinatorStatus.capabilities?.skills;
        const latestSkills = latest.capabilities?.skills;
        if (
          latest.runtimeLive === coordinatorStatus.runtimeLive &&
          latest.runtimeEpoch === coordinatorStatus.runtimeEpoch &&
          latestSkills?.state === currentSkills?.state &&
          latestSkills?.revision === currentSkills?.revision &&
          latestSkills?.runtimeEpoch === currentSkills?.runtimeEpoch &&
          (latestSkills?.state !== 'ready' ||
            (runtime.data?.initialized === true &&
              runtime.data.runtimeEpoch === latest.runtimeEpoch &&
              runtime.error === undefined))
        ) {
          return;
        }
        const applyLatest = () => {
          setCoordinatorStatus(latest);
          setPrepareError(
            latestSkills?.error
              ? new Error(latestSkills.error.message)
              : undefined,
          );
        };
        if (
          latest.runtimeLive &&
          latest.runtimeEpoch !== coordinatorStatus.runtimeEpoch
        ) {
          applyLatest();
          await ensureRuntime();
        } else if (
          latestSkills?.state === 'ready' &&
          latestSkills.runtimeEpoch === latest.runtimeEpoch
        ) {
          const [configStatus, runtimeStatus] = await Promise.all([
            reloadConfig(),
            reloadRuntime(),
          ]);
          if (!cancelled && configStatus && runtimeStatus) applyLatest();
        } else {
          applyLatest();
        }
      } catch {
        // Keep the last known catalog on a transient status read failure.
      } finally {
        if (!cancelled) timer = setTimeout(observe, RUNTIME_STATUS_POLL_MS);
      }
    };
    timer = setTimeout(observe, RUNTIME_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    coordinatorStatus,
    ensureRuntime,
    reloadConfig,
    reloadRuntime,
    runtime.data?.initialized,
    runtime.data?.runtimeEpoch,
    runtime.error,
    splitRuntimeAvailable,
    workspaceClient,
  ]);
  const runtimeCurrent =
    splitRuntimeAvailable &&
    coordinatorStatus?.capabilities?.skills?.state === 'ready' &&
    coordinatorStatus.capabilities.skills.runtimeEpoch ===
      coordinatorStatus.runtimeEpoch &&
    runtime.data?.initialized === true &&
    runtime.data.runtimeEpoch === coordinatorStatus.runtimeEpoch;
  const skills = useMemo(() => {
    const configSkills = config.data?.skills ?? [];
    if (!runtimeCurrent) return configSkills;
    const runtimeByName = new Map(
      (runtime.data?.skills ?? []).map((skill) => [
        skill.name.toLowerCase(),
        skill,
      ]),
    );
    const merged = configSkills.map((configured) => {
      const live = runtimeByName.get(configured.name.toLowerCase());
      if (!live) return configured;
      runtimeByName.delete(configured.name.toLowerCase());
      return {
        ...live,
        ...configured,
        installedPath: configured.installedPath ?? live.installedPath,
      };
    });
    return [...merged, ...runtimeByName.values()];
  }, [config.data?.skills, runtime.data?.skills, runtimeCurrent]);
  const reload = useCallback(async () => {
    if (!splitRuntimeAvailable) return await reloadConfig();
    const [configStatus, runtimeStatus] = await Promise.all([
      reloadConfig(),
      ensureRuntime(),
    ]);
    return runtimeStatus ?? configStatus;
  }, [ensureRuntime, reloadConfig, splitRuntimeAvailable]);
  const signals = useDaemonWorkspaceEventSignals();
  const version = signals
    ? signals.settingsVersion +
      signals.extensionsVersion +
      signals.skillsVersion
    : undefined;
  useWorkspaceEventReload(version, reloadConfig, config.data !== undefined);
  useWorkspaceEventReload(version, reloadRuntime, runtime.data !== undefined);
  return {
    data: config.data ?? runtime.data,
    status: config.data ?? runtime.data,
    configStatus: config.data,
    runtimeStatus: runtime.data,
    skills,
    loading: config.loading || (preparing && config.data === undefined),
    preparing,
    error:
      config.error ??
      (splitRuntimeAvailable ? (prepareError ?? runtime.error) : undefined),
    reload,
    reloadConfig,
    reloadRuntime,
    ensureRuntime,
    setEnabled: async (
      skillName: string,
      enabled: boolean,
      opts?: { clientId?: string },
    ) => {
      if (!splitRuntimeAvailable) {
        requireLegacyPrimary(legacyWorkspaceMismatch);
        return await actions.setWorkspaceSkillEnabled(skillName, enabled);
      }
      if (!workspaceClient) throw new Error('Workspace is unavailable.');
      const result = await workspaceClient.setWorkspaceConfigSkillEnabled(
        skillName,
        enabled,
        opts,
      );
      await ensureRuntime();
      return result;
    },
    install: async (request: DaemonSkillInstallRequest) => {
      if (!splitRuntimeAvailable) {
        requireLegacyPrimary(legacyWorkspaceMismatch);
        return await actions.installWorkspaceSkill(request);
      }
      let result;
      if (request.scope === 'global') {
        result = await client.installWorkspaceConfigSkill({
          ...request,
          scope: 'global',
        });
      } else {
        if (!workspaceClient) throw new Error('Workspace is unavailable.');
        result = await workspaceClient.installWorkspaceConfigSkill({
          ...request,
          scope: 'workspace',
        });
      }
      await ensureRuntime();
      return result;
    },
    remove: async (skillName: string, scope: 'workspace' | 'global') => {
      if (!splitRuntimeAvailable) {
        requireLegacyPrimary(legacyWorkspaceMismatch);
        return await actions.deleteWorkspaceSkill(skillName, scope);
      }
      let result;
      if (scope === 'global') {
        result = await client.deleteWorkspaceConfigSkill(skillName, scope);
      } else {
        if (!workspaceClient) throw new Error('Workspace is unavailable.');
        result = await workspaceClient.deleteWorkspaceConfigSkill(
          skillName,
          scope,
        );
      }
      await ensureRuntime();
      return result;
    },
  };
}
