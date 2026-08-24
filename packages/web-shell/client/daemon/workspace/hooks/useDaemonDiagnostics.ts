/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { useDaemonWorkspaceEventSignals } from '../../session/DaemonSessionProvider.js';
import { useDaemonWorkspaceActions } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';
import { useWorkspaceEventReload } from './useWorkspaceEventReload.js';

export function useDaemonDiagnostics(options: DaemonResourceOptions = {}) {
  const workspaceActions = useDaemonWorkspaceActions();
  const loadEnv = useCallback(
    () => workspaceActions.loadEnv(),
    [workspaceActions],
  );
  const loadPreflight = useCallback(
    () => workspaceActions.loadPreflight(),
    [workspaceActions],
  );
  const env = useDaemonResource(loadEnv, options);
  const preflight = useDaemonResource(loadPreflight, options);
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(
    signals?.initVersion,
    env.reload,
    options.autoLoad === true || env.data !== undefined,
  );
  useWorkspaceEventReload(
    signals?.initVersion,
    preflight.reload,
    options.autoLoad === true || preflight.data !== undefined,
  );
  return { env, preflight };
}
