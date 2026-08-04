import type {
  DaemonCapabilities,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  useWorkspace,
  useWorkspaceActions,
  type DaemonFileStat,
  type DaemonWorkspaceActions,
} from '@qwen-code/webui/daemon-react-sdk';
import { useEffect, useMemo, useRef } from 'react';

export type ArtifactWorkspaceActions = Pick<
  DaemonWorkspaceActions,
  | 'readWorkspaceFile'
  | 'readFileBytes'
  | 'stat'
  | 'listScheduledTasks'
  | 'updateScheduledTask'
  | 'deleteScheduledTask'
>;

interface ArtifactWorkspaceOwner {
  cwd: string;
  id?: string;
  primary: boolean;
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

export function useArtifactWorkspaceTarget(
  workspaceCwd: string | undefined,
): ArtifactWorkspaceTarget | undefined {
  const workspace = useWorkspace();
  const primaryActions = useWorkspaceActions();
  const owner = useMemo(
    () => resolveArtifactWorkspaceOwner(workspace.capabilities, workspaceCwd),
    [workspace.capabilities, workspaceCwd],
  );
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  useEffect(() => {
    ownerRef.current = owner;
    return () => {
      if (ownerRef.current === owner) ownerRef.current = undefined;
    };
  }, [owner]);

  const actions = useMemo<ArtifactWorkspaceActions | undefined>(() => {
    if (!owner) return undefined;
    const expectedOwner = owner;
    const requireOwner = () => {
      const current = ownerRef.current;
      if (current !== expectedOwner) {
        throw new Error('Workspace artifact owner is no longer available');
      }
      return current;
    };
    const requireScheduledTaskOwner = (workspaceId: string | undefined) => {
      const current = requireOwner();
      if (current.id !== workspaceId) {
        throw new Error('Scheduled task workspace owner no longer matches');
      }
      return current;
    };
    return {
      async readWorkspaceFile(filePath) {
        const current = requireOwner();
        const result = await (current.primary
          ? primaryActions.readWorkspaceFile(filePath)
          : workspace.client
              .workspaceByCwd(current.cwd)
              .readWorkspaceFile(filePath));
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
  }, [owner, primaryActions, workspace.client]);

  if (!owner || !actions) return undefined;
  return {
    workspaceCwd: owner.cwd,
    ...(owner.id ? { workspaceId: owner.id } : {}),
    actions,
  };
}
