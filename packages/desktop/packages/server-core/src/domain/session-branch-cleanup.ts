export interface BranchRollbackManagedSession {
  agent?: { destroy?: () => void } | null
  poolServer?: { stop?: () => void }
}

interface RollbackParams {
  managed: BranchRollbackManagedSession
  workspaceRootPath: string
  sessionId: string
  deleteFromRuntimeSessions: (sessionId: string) => void
  deleteStoredSession: (workspaceRootPath: string, sessionId: string) => void | boolean | Promise<void | boolean>
}

/**
 * Best-effort rollback when branch creation fails during backend preflight.
 * Ensures no orphan child session remains in memory or persistent storage.
 */
export async function rollbackFailedBranchCreation(params: RollbackParams): Promise<void> {
  const { managed, workspaceRootPath, sessionId, deleteFromRuntimeSessions, deleteStoredSession } = params

  try {
    managed.agent?.destroy?.()
  } catch {
    // Best-effort cleanup
  }
  managed.agent = null

  if (managed.poolServer) {
    try {
      managed.poolServer.stop?.()
    } catch {
      // Best-effort cleanup
    }
    managed.poolServer = undefined
  }

  deleteFromRuntimeSessions(sessionId)

  try {
    await deleteStoredSession(workspaceRootPath, sessionId)
  } catch {
    // Best-effort rollback: runtime cleanup is the critical path.
  }
}
