/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import type { DaemonWorkspaceRuntimeStatus } from '@qwen-code/sdk/daemon';
import { useDaemonWorkspaceEventSignals } from '../../session/DaemonSessionProvider.js';
import { useDaemonWorkspaceActions } from '../DaemonWorkspaceProvider.js';
import type {
  DaemonResourceOptions,
  DaemonWorkspaceSkillsViewStatus,
} from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';
import { useWorkspaceEventReload } from './useWorkspaceEventReload.js';

export function useDaemonSkills(
  options: DaemonResourceOptions = {},
  workspaceCwdOverride?: string,
) {
  const workspaceActions = useDaemonWorkspaceActions(workspaceCwdOverride);
  const preparedRuntimeStatusRef = useRef<
    DaemonWorkspaceRuntimeStatus | undefined
  >(undefined);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<Error | undefined>();
  const [prepareWarning, setPrepareWarning] = useState<Error | undefined>();
  const loadConfig = useCallback(
    () => workspaceActions.loadSkillsConfigStatus(),
    [workspaceActions],
  );
  const loadRuntime =
    useCallback(async (): Promise<DaemonWorkspaceSkillsViewStatus> => {
      const preparedStatus = preparedRuntimeStatusRef.current;
      preparedRuntimeStatusRef.current = undefined;
      return await workspaceActions.loadSkillsStatus(preparedStatus);
    }, [workspaceActions]);
  const config = useDaemonResource(loadConfig, options);
  const runtime = useDaemonResource(loadRuntime, {
    ...options,
    autoLoad: false,
  });
  const reloadConfig = config.reload;
  const reloadRuntime = runtime.reload;
  const reload = useCallback(async () => {
    const [, runtimeStatus] = await Promise.all([
      reloadConfig(),
      reloadRuntime(),
    ]);
    return runtimeStatus;
  }, [reloadConfig, reloadRuntime]);
  const ensureRuntime = useCallback(async () => {
    setPreparing(true);
    setPrepareError(undefined);
    setPrepareWarning(undefined);
    try {
      const preparedStatus = await workspaceActions.ensureRuntime();
      preparedRuntimeStatusRef.current = preparedStatus;
      const refreshedStatus = await reloadRuntime();
      if (
        preparedStatus.capabilities.skills?.state === 'error' &&
        refreshedStatus?.runtimeState !== 'ready'
      ) {
        setPrepareWarning(
          new Error(
            preparedStatus.capabilities.skills.error?.message ??
              'Workspace skills runtime failed',
          ),
        );
      }
      return refreshedStatus;
    } catch (error) {
      setPrepareError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return undefined;
    } finally {
      setPreparing(false);
    }
  }, [reloadRuntime, workspaceActions]);
  const signals = useDaemonWorkspaceEventSignals();
  const version = signals
    ? signals.settingsVersion + signals.extensionsVersion
    : undefined;
  useWorkspaceEventReload(
    version,
    reloadConfig,
    options.autoLoad === true || config.data !== undefined,
  );
  useWorkspaceEventReload(version, reloadRuntime, runtime.data !== undefined);
  const status = config.data ?? runtime.data;
  return {
    data: status,
    status,
    configStatus: config.data,
    runtimeStatus: runtime.data,
    skills: config.data?.skills ?? runtime.data?.skills ?? [],
    loading: config.loading || runtime.loading || preparing,
    error: config.error ?? runtime.error ?? prepareError,
    warning:
      runtime.data?.runtimeState === 'ready' ? undefined : prepareWarning,
    reload,
    reloadConfig,
    reloadRuntime,
    ensureRuntime,
    setEnabled: workspaceActions.setWorkspaceSkillEnabled,
    install: workspaceActions.installWorkspaceSkill,
    remove: workspaceActions.deleteWorkspaceSkill,
  };
}
