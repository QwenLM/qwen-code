import type { Session, Workspace } from '../../shared/types'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { extractSessionMeta, type SessionMeta } from '@/atoms/sessions'

interface ProjectSessionSnapshotApi {
  getSessionsForWorkspace(workspaceId: string, options?: { refreshExternal?: boolean }): Promise<Session[]>
  invokeOnServer(url: string, token: string, channel: string, ...args: unknown[]): Promise<unknown>
}

export async function loadProjectWorkspaceSessionSnapshot(
  workspace: Workspace,
  api: ProjectSessionSnapshotApi = window.electronAPI,
): Promise<SessionMeta[]> {
  const sessions = workspace.remoteServer
    ? await api.invokeOnServer(
        workspace.remoteServer.url,
        workspace.remoteServer.token,
        RPC_CHANNELS.sessions.GET_FOR_WORKSPACE,
        workspace.remoteServer.remoteWorkspaceId,
        { refreshExternal: true },
      ) as Session[]
    : await api.getSessionsForWorkspace(workspace.id, { refreshExternal: true })

  return sessions.map(extractSessionMeta)
}
