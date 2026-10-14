import type {
  DaemonCapabilities,
  DaemonWorkspaceCapability,
  WorkspaceDaemonClient,
} from '@qwen-code/sdk/daemon';
import {
  useWorkspace,
  useWorkspaceActions,
  type DaemonDirectoryListing,
  type DaemonFileStat,
  type DaemonWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useEffect, useMemo, useRef } from 'react';

export type ArtifactWorkspaceActions = Pick<
  DaemonWorkspaceActions,
  | 'readWorkspaceFile'
  | 'readFileBytes'
  | 'stat'
  | 'listDirectory'
  | 'listScheduledTasks'
  | 'updateScheduledTask'
  | 'deleteScheduledTask'
> &
  Partial<Pick<WorkspaceDaemonClient, 'deleteWorkspaceFile'>>;

interface ArtifactWorkspaceOwner {
  cwd: string;
  id?: string;
  primary: boolean;
}

interface ArtifactWorkspaceAuthority {
  owner: ArtifactWorkspaceOwner;
}

export interface ArtifactWorkspaceTarget {
  workspaceCwd: string;
  workspaceId?: string;
  actions: ArtifactWorkspaceActions;
}

export function resolveArtifactWorkspaceOwner(
  capabilities: DaemonCapabilities | undefined,
  workspaceCwd: string | undefined,
): ArtifactWorkspaceOwner | undefined {
  if (!capabilities || !workspaceCwd) return undefined;
  const advertised = capabilities.workspaces;
  if (advertised) {
    const matches = advertised.filter((entry) => entry.cwd === workspaceCwd);
    const match = matches[0];
    if (matches.length !== 1 || !match?.id || match.trusted !== true) {
      return undefined;
    }
    if (advertised.filter((entry) => entry.id === match.id).length !== 1) {
      return undefined;
    }
    if (match.primary !== (match.cwd === capabilities.workspaceCwd)) {
      return undefined;
    }
    return workspaceOwner(match);
  }
  if (capabilities.workspaceCwd !== workspaceCwd) return undefined;
  return {
    cwd: workspaceCwd,
    primary: true,
  };
}

function workspaceOwner(
  workspace: DaemonWorkspaceCapability,
): ArtifactWorkspaceOwner {
  return {
    cwd: workspace.cwd,
    id: workspace.id,
    primary: workspace.primary,
  };
}

function isSameWorkspaceOwner(
  current: ArtifactWorkspaceOwner | undefined,
  expected: ArtifactWorkspaceOwner,
): current is ArtifactWorkspaceOwner {
  return (
    current?.cwd === expected.cwd &&
    current.id === expected.id &&
    current.primary === expected.primary
  );
}

export function useArtifactWorkspaceTarget(
  workspaceCwd: string | undefined,
): ArtifactWorkspaceTarget | undefined {
  const workspace = useWorkspace();
  const primaryActions = useWorkspaceActions();
  const owner = useMemo(
    () => resolveArtifactWorkspaceOwner(workspace.capabilities, workspaceCwd),
    [workspace.capabilities, workspaceCwd],
  );
  const canDelete = Boolean(
    owner?.id &&
      workspace.capabilities?.features?.includes('workspace_file_delete') &&
      workspace.capabilities?.features?.includes(
        'workspace_qualified_rest_core',
      ) &&
      !workspace.capabilities?.workspaces?.find(
        (entry) => entry.id === owner.id,
      )?.ssh,
  );
  const deleteAllowedRef = useRef(canDelete);
  deleteAllowedRef.current = canDelete;
  const authorityRef = useRef<ArtifactWorkspaceAuthority | undefined>(
    undefined,
  );
  if (!owner) {
    authorityRef.current = undefined;
  } else if (!isSameWorkspaceOwner(authorityRef.current?.owner, owner)) {
    authorityRef.current = { owner };
  }
  const authority = authorityRef.current;
  const authorityLifetimeRef = useRef<object | undefined>(undefined);
  useEffect(() => {
    if (!authority) {
      authorityLifetimeRef.current = undefined;
      return undefined;
    }
    const lifetime = {};
    authorityLifetimeRef.current = lifetime;
    return () => {
      // StrictMode immediately replays setup after cleanup. Defer revocation so
      // that replay can replace the lifetime token; a real unmount still
      // revokes the authority as soon as that replay window closes.
      queueMicrotask(() => {
        if (
          authorityLifetimeRef.current === lifetime &&
          authorityRef.current === authority
        ) {
          authorityRef.current = undefined;
        }
      });
    };
  }, [authority]);

  const actions = useMemo<ArtifactWorkspaceActions | undefined>(() => {
    if (!authority) return undefined;
    const expectedAuthority = authority;
    const requireOwner = () => {
      const current = authorityRef.current;
      if (current !== expectedAuthority) {
        throw new Error('Workspace artifact owner is no longer available');
      }
      return current.owner;
    };
    const requireScheduledTaskOwner = (workspaceId: string | undefined) => {
      const current = requireOwner();
      if (current.id !== workspaceId) {
        throw new Error('Scheduled task workspace owner no longer matches');
      }
      return current;
    };
    return {
      ...(canDelete
        ? {
            async deleteWorkspaceFile(path: string) {
              const current = requireOwner();
              if (!deleteAllowedRef.current)
                throw new Error(
                  'Workspace file deletion is no longer available',
                );
              await workspace.client
                .workspaceByCwd(current.cwd)
                .deleteWorkspaceFile(path);
              requireOwner();
              if (!deleteAllowedRef.current)
                throw new Error(
                  'Workspace file deletion is no longer available',
                );
            },
          }
        : {}),
      async listDirectory(path) {
        const current = requireOwner();
        const result = await (current.id
          ? (workspace.client
              .workspaceByCwd(current.cwd)
              .dirList(path) as Promise<DaemonDirectoryListing>)
          : primaryActions.listDirectory(path));
        requireOwner();
        return result;
      },
      async readWorkspaceFile(filePath, opts) {
        const current = requireOwner();
        const result = await (current.primary
          ? primaryActions.readWorkspaceFile(filePath, opts)
          : workspace.client
              .workspaceByCwd(current.cwd)
              .readWorkspaceFile(filePath, opts));
        requireOwner();
        return result;
      },
      async readFileBytes(filePath, options) {
        const current = requireOwner();
        const result = await (current.primary
          ? primaryActions.readFileBytes(filePath, options)
          : workspace.client
              .workspaceByCwd(current.cwd)
              .readWorkspaceFileBytes(filePath, options));
        requireOwner();
        return result;
      },
      async stat(filePath) {
        const current = requireOwner();
        const result = await (current.primary
          ? primaryActions.stat(filePath)
          : (workspace.client
              .workspaceByCwd(current.cwd)
              .fileStat(filePath) as Promise<DaemonFileStat>));
        requireOwner();
        return result;
      },
      async listScheduledTasks(workspaceId) {
        requireScheduledTaskOwner(workspaceId);
        const result = await primaryActions.listScheduledTasks(workspaceId);
        requireScheduledTaskOwner(workspaceId);
        return result;
      },
      async updateScheduledTask(id, update, workspaceId) {
        requireScheduledTaskOwner(workspaceId);
        const result = await primaryActions.updateScheduledTask(
          id,
          update,
          workspaceId,
        );
        requireScheduledTaskOwner(workspaceId);
        return result;
      },
      async deleteScheduledTask(id, workspaceId) {
        requireScheduledTaskOwner(workspaceId);
        await primaryActions.deleteScheduledTask(id, workspaceId);
        requireScheduledTaskOwner(workspaceId);
      },
    };
  }, [authority, primaryActions, workspace.client, canDelete]);

  if (!authority || !actions) return undefined;
  return {
    workspaceCwd: authority.owner.cwd,
    ...(authority.owner.id ? { workspaceId: authority.owner.id } : {}),
    actions,
  };
}
