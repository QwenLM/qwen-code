/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react';
import { useDaemonWorkspaceEventSignals } from '../../session/DaemonSessionProvider.js';
import { useDaemonWorkspace } from '../DaemonWorkspaceProvider.js';
import type { DaemonResourceOptions } from '../types.js';
import { useDaemonResource } from './useDaemonResource.js';
import { useWorkspaceEventReload } from './useWorkspaceEventReload.js';

interface DaemonMemoryOptions extends DaemonResourceOptions {
  workspaceCwd?: string;
}

export function useDaemonMemory(options: DaemonMemoryOptions = {}) {
  const { actions: workspaceActions, client } = useDaemonWorkspace();
  const { workspaceCwd: requestedWorkspaceCwd, ...resourceOptions } = options;
  const workspaceClient = useMemo(
    () =>
      requestedWorkspaceCwd
        ? client.workspaceByCwd(requestedWorkspaceCwd)
        : undefined,
    [client, requestedWorkspaceCwd],
  );
  const load = useCallback(
    () =>
      workspaceClient
        ? workspaceClient.workspaceMemory()
        : workspaceActions.loadMemoryStatus(),
    [workspaceActions, workspaceClient],
  );
  const result = useDaemonResource(load, resourceOptions);
  const readFile = useCallback<typeof workspaceActions.readWorkspaceFile>(
    (filePath, readOptions) => {
      if (workspaceClient) {
        return readOptions === undefined
          ? workspaceClient.readWorkspaceFile(filePath)
          : workspaceClient.readWorkspaceFile(filePath, readOptions);
      }
      return readOptions === undefined
        ? workspaceActions.readWorkspaceFile(filePath)
        : workspaceActions.readWorkspaceFile(filePath, readOptions);
    },
    [workspaceActions, workspaceClient],
  );
  // Read through the memory route, not the sandboxed file API: the global
  // file sits outside the bound workspace, and `GET /file` refuses it.
  // Daemons that predate `includeContent` omit `content`, so fall back.
  const readMemoryFile = useCallback(
    async (filePath: string) => {
      const status = workspaceClient
        ? await workspaceClient.workspaceMemory({ includeContent: true })
        : await workspaceActions.loadMemoryStatus({
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
      return readFile(filePath);
    },
    [readFile, workspaceActions, workspaceClient],
  );
  const writeMemory = useCallback<typeof workspaceActions.writeMemory>(
    (req) => {
      if (req.scope === 'workspace' && workspaceClient) {
        return workspaceClient.writeWorkspaceMemory({
          mode: req.mode,
          content: req.content,
          scope: 'workspace',
        });
      }
      return workspaceActions.writeMemory(req);
    },
    [workspaceActions, workspaceClient],
  );
  const signals = useDaemonWorkspaceEventSignals();
  useWorkspaceEventReload(
    signals?.memoryVersion,
    result.reload,
    resourceOptions.autoLoad === true || result.data !== undefined,
  );
  return {
    ...result,
    status: result.data,
    files: result.data?.files ?? [],
    readFile,
    readMemoryFile,
    writeMemory,
  };
}
