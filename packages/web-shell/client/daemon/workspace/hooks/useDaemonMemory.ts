/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react';
import { useDaemonWorkspaceEventSignals } from '../../session/DaemonSessionProvider.js';
import {
  useDaemonWorkspace,
  useDaemonWorkspaceActions,
} from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';
import { useWorkspaceEventReload } from './useWorkspaceEventReload.js';

export function useDaemonMemory(
  options: DaemonResourceOptions & { workspaceCwd?: string } = {},
) {
  const { workspaceCwd, ...resourceOptions } = options;
  const workspace = useDaemonWorkspace();
  const workspaceActions = useDaemonWorkspaceActions();
  const workspaceClient = useMemo(
    () =>
      workspaceCwd ? workspace.client.workspaceByCwd(workspaceCwd) : undefined,
    [workspace.client, workspaceCwd],
  );
  const loadMemoryStatus = useCallback(
    (opts?: { includeContent?: boolean }) =>
      workspaceClient && opts?.includeContent !== true
        ? workspaceClient.workspaceMemory()
        : workspaceActions.loadMemoryStatus(opts),
    [workspaceClient, workspaceActions],
  );
  const load = useCallback(() => loadMemoryStatus(), [loadMemoryStatus]);
  const result = useDaemonResource(load, resourceOptions);
  // Read through the memory route, not the sandboxed file API: the global
  // file sits outside the bound workspace, and `GET /file` refuses it.
  // Daemons that predate `includeContent` omit `content`, so fall back.
  const readMemoryFile = useCallback(
    async (filePath: string) => {
      if (workspaceClient) {
        try {
          return await workspaceClient.readWorkspaceFile(filePath);
        } catch {
          // Global memory lives outside the workspace; fall back to the
          // primary memory route below.
        }
      }
      const status = await workspaceActions.loadMemoryStatus({
        includeContent: true,
      });
      const file = status.files.find((item) => item.path === filePath);
      if (typeof file?.content === 'string') {
        return { content: file.content, truncated: file.truncated === true };
      }
      if (file?.truncated === true) {
        // The daemon could not provide a safely replaceable snapshot.
        // Preserve its read-only marker for withheld content or a torn read.
        return { content: '', truncated: true };
      }
      return workspaceActions.readWorkspaceFile(filePath);
    },
    [workspaceActions, workspaceClient],
  );
  const writeMemory = useCallback(
    (request: Parameters<typeof workspaceActions.writeMemory>[0]) =>
      workspaceClient && request.scope === 'workspace'
        ? workspaceClient.writeWorkspaceMemory({
            ...request,
            scope: 'workspace',
          })
        : workspaceActions.writeMemory(request),
    [workspaceActions, workspaceClient],
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
    readFile: workspaceClient
      ? (filePath: string) => workspaceClient.readWorkspaceFile(filePath)
      : workspaceActions.readWorkspaceFile,
    readMemoryFile,
    writeMemory,
  };
}
