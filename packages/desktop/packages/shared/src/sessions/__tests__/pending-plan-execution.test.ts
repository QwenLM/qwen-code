import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredSession } from '../types.ts'
import {
  getPendingPlanExecution,
  markCompactionComplete,
  markPendingPlanExecutionDispatched,
  saveSession,
  setPendingPlanExecution,
} from '../storage.ts'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `pending-plan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStoredSession(workspaceRootPath: string): StoredSession {
  return {
    id: 'session-1',
    workspaceRootPath,
    createdAt: 1000,
    lastUsedAt: 1000,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  } as StoredSession
}

describe('pending plan execution persistence', () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = makeTmpDir()
    await saveSession(makeStoredSession(workspaceRoot))
  })

  afterEach(() => {
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('defaults executionDispatched to false and persists transitions', async () => {
    await setPendingPlanExecution(workspaceRoot, 'session-1', '/tmp/plan.md', 'draft snapshot')

    expect(getPendingPlanExecution(workspaceRoot, 'session-1')).toEqual({
      planPath: '/tmp/plan.md',
      draftInputSnapshot: 'draft snapshot',
      awaitingCompaction: true,
      executionDispatched: false,
    })

    await markCompactionComplete(workspaceRoot, 'session-1')
    await markPendingPlanExecutionDispatched(workspaceRoot, 'session-1')

    expect(getPendingPlanExecution(workspaceRoot, 'session-1')).toEqual({
      planPath: '/tmp/plan.md',
      draftInputSnapshot: 'draft snapshot',
      awaitingCompaction: false,
      executionDispatched: true,
    })
  })
})
