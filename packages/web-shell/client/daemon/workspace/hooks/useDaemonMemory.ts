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

export function useDaemonMemory(options: DaemonResourceOptions = {}) {
  const workspaceActions = useDaemonWorkspaceActions();
  const load = useCallback(
    () => workspaceActions.loadMemoryStatus(),
    [workspaceActions],
  );
  const result = useDaemonResource(load, options);
  // Read through the memory route, not the sandboxed file API: the global
  // file sits outside the bound workspace, and `GET /file` refuses it.
  // Daemons that predate `includeContent` omit `content`, so fall back.
  const readMemoryFile = useCallback(
    async (filePath: string) => {
      const status = await workspaceActions.loadMemoryStatus({
        includeContent: true,
      });
      const file = status.files.find((item) => item.path === filePath);
      if (typeof file?.content === 'string') {
        return { content: file.content, truncated: file.truncated === true };
      }
      return workspaceActions.readWorkspaceFile(filePath);
    },
    [workspaceActions],
  );
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(
    signals?.memoryVersion,
    result.reload,
    options.autoLoad === true || result.data !== undefined,
  );
  return {
    ...result,
    status: result.data,
    files: result.data?.files ?? [],
    readFile: workspaceActions.readWorkspaceFile,
    readMemoryFile,
    writeMemory: workspaceActions.writeMemory,
  };
}
