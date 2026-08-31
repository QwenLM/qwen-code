/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import type { DaemonStatusReportDetail } from '@qwen-code/sdk/daemon';
import { useDaemonWorkspaceActions } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';

export interface DaemonStatusReportOptions extends DaemonResourceOptions {
  /** Detail level to request; defaults to the cheap `summary` view. */
  detail?: DaemonStatusReportDetail;
}

export function useDaemonStatusReport(options: DaemonStatusReportOptions = {}) {
  const { detail = 'summary', ...resourceOptions } = options;
  const workspaceActions = useDaemonWorkspaceActions();
  const load = useCallback(
    () => workspaceActions.loadDaemonStatus(detail),
    [workspaceActions, detail],
  );
  const result = useDaemonResource(load, resourceOptions);
  return {
    ...result,
    report: result.data,
  };
}
