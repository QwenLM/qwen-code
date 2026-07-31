import { describe, expect, it } from 'bun:test'
import { rollbackFailedBranchCreation } from '@craft-agent/server-core/domain'

describe('rollbackFailedBranchCreation', () => {
  it('cleans runtime + storage and tears down agent/pool on preflight failure', async () => {
    let destroyed = false
    let stopped = false
    let runtimeDeleted: string | null = null
    let storageDeleted: string | null = null

    const managed = {
      agent: {
        destroy: () => {
          destroyed = true
        },
      },
      poolServer: {
        stop: () => {
          stopped = true
        },
      },
    }

    await rollbackFailedBranchCreation({
      managed,
      workspaceRootPath: '/tmp/ws',
      sessionId: 'child-1',
      deleteFromRuntimeSessions: (id) => {
        runtimeDeleted = id
      },
      deleteStoredSession: async (_root, id) => {
        storageDeleted = id
      },
    })

    expect(destroyed).toBe(true)
    expect(stopped).toBe(true)
    expect(runtimeDeleted as string | null).toBe('child-1')
    expect(storageDeleted as string | null).toBe('child-1')
    expect(managed.agent).toBeNull()
    expect(managed.poolServer).toBeUndefined()
  })

  it('still deletes sessions when destroy/stop throw (best-effort)', async () => {
    let runtimeDeleted = false
    let storageDeleted = false

    const managed = {
      agent: {
        destroy: () => {
          throw new Error('destroy failed')
        },
      },
      poolServer: {
        stop: () => {
          throw new Error('stop failed')
        },
      },
    }

    await rollbackFailedBranchCreation({
      managed,
      workspaceRootPath: '/tmp/ws',
      sessionId: 'child-2',
      deleteFromRuntimeSessions: () => {
        runtimeDeleted = true
      },
      deleteStoredSession: async () => {
        storageDeleted = true
      },
    })

    expect(runtimeDeleted).toBe(true)
    expect(storageDeleted).toBe(true)
    expect(managed.agent).toBeNull()
    expect(managed.poolServer).toBeUndefined()
  })

  it('does not throw when storage deletion fails', async () => {
    let runtimeDeleted = false

    const managed = {
      agent: null,
      poolServer: undefined,
    }

    await rollbackFailedBranchCreation({
      managed,
      workspaceRootPath: '/tmp/ws',
      sessionId: 'child-3',
      deleteFromRuntimeSessions: () => {
        runtimeDeleted = true
      },
      deleteStoredSession: async () => {
        throw new Error('storage delete failed')
      },
    })

    expect(runtimeDeleted).toBe(true)
  })
})
