import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import type { Workspace } from '@craft-agent/shared/config'
import { loadSession, saveSession } from '@craft-agent/shared/sessions'
import { saveWorkspaceConfig } from '@craft-agent/shared/workspaces'
import type { AgentEvent, Message } from '@craft-agent/core/types'
import { createManagedSession, SessionManager, setSessionPlatform } from './SessionManager.ts'

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

setSessionPlatform({
  appRootPath: process.cwd(),
  resourcesPath: process.cwd(),
  isPackaged: false,
  appVersion: 'test',
  imageProcessor: {
    getMetadata: async () => null,
    process: async (input) => Buffer.isBuffer(input) ? input : Buffer.from(''),
  },
  logger,
  isDebugMode: false,
})

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  expect(condition()).toBe(true)
}

describe('Qwen native history loading', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deduplicates concurrent agent creation for one managed session', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    tempRoots.push(workspaceRoot)

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession({
      id: '260508-concurrent-agent',
      lastMessageAt: Date.now(),
      permissionMode: 'allow-all',
    }, workspace)
    type TestManagedSession = ReturnType<typeof createManagedSession>
    const manager = new SessionManager()
    const fakeAgent = {
      dispose: () => {},
      destroy: () => {},
    } as unknown as AgentBackend
    let createCalls = 0

    const managerInternals = manager as unknown as {
      createAgentForManagedSession: (session: TestManagedSession) => Promise<AgentBackend>
      getOrCreateAgent: (session: TestManagedSession) => Promise<AgentBackend>
    }

    managerInternals.createAgentForManagedSession = async (session) => {
      createCalls += 1
      await Promise.resolve()
      session.agent = fakeAgent
      return fakeAgent
    }

    const getOrCreateAgent = managerInternals.getOrCreateAgent.bind(manager)

    const [firstAgent, secondAgent] = await Promise.all([
      getOrCreateAgent(managed),
      getOrCreateAgent(managed),
    ])

    expect(createCalls).toBe(1)
    expect(firstAgent).toBe(fakeAgent)
    expect(secondAgent).toBe(fakeAgent)
  })

  it('lists provider-native sessions from the workspace default working directory', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'))
    tempRoots.push(workspaceRoot, projectRoot)

    const sessionId = 'fd2803fd-1070-41da-b7c0-10d978f7128c'
    const timestamp = Date.parse('2026-04-26T10:12:13.000Z')
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        permissionMode: 'allow-all',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    let listCalls = 0
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        listSessions: async (options?: { cwd?: string }) => {
          listCalls += 1
          expect(options?.cwd).toBe(projectRoot)
          return {
            sessions: [{
              sessionId,
              cwd: projectRoot,
              title: 'qwen native conversation',
              updatedAt: new Date(timestamp).toISOString(),
            }],
          }
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }

    await (manager as unknown as {
      doRefreshExternalSessionsForWorkspace: (workspace: Workspace) => Promise<void>
    }).doRefreshExternalSessionsForWorkspace(workspace)

    const imported = loadSession(workspaceRoot, sessionId)
    expect(listCalls).toBe(1)
    expect(imported?.workspaceRootPath).toBe(workspaceRoot)
    expect(imported?.sdkCwd).toBe(projectRoot)
    expect(imported?.workingDirectory).toBe(projectRoot)
    expect(imported?.permissionMode).toBe('allow-all')
    expect(imported?.llmConnection).toBe('qwen-code')
  })

  it('removes provider-native mirrors once a Craft session owns the same SDK session ID', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'))
    tempRoots.push(workspaceRoot, projectRoot)

    const craftSessionId = '260429-dynamic-crystal'
    const sdkSessionId = '07db68e4-c974-4720-9a30-b089cd2665d5'
    const olderTimestamp = Date.parse('2026-04-29T01:40:50.344Z')
    const newerTimestamp = Date.parse('2026-04-29T03:41:13.728Z')

    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: olderTimestamp,
      updatedAt: newerTimestamp,
    })

    await saveSession({
      id: craftSessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '无敌',
      createdAt: newerTimestamp - 30_000,
      lastUsedAt: newerTimestamp,
      lastMessageAt: newerTimestamp,
      permissionMode: 'allow-all',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [
        { id: 'local-user', type: 'user', content: '/compact', timestamp: newerTimestamp - 10_000 },
        { id: 'local-info', type: 'info', content: 'Response interrupted', timestamp: newerTimestamp },
      ],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    await saveSession({
      id: sdkSessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '无敌',
      createdAt: olderTimestamp - 30_000,
      lastUsedAt: olderTimestamp,
      lastMessageAt: olderTimestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [
        { id: 'mirror-user', type: 'user', content: '/compact', timestamp: olderTimestamp - 1_000 },
        { id: 'mirror-assistant', type: 'assistant', content: 'done', timestamp: olderTimestamp },
      ],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        listSessions: async () => ({
          sessions: [{
            sessionId: sdkSessionId,
            cwd: projectRoot,
            title: '无敌',
            updatedAt: new Date(olderTimestamp).toISOString(),
          }],
        }),
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: olderTimestamp,
    }
    const craftManaged = createManagedSession({
      id: craftSessionId,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '无敌',
      createdAt: newerTimestamp - 30_000,
      lastUsedAt: newerTimestamp,
      lastMessageAt: newerTimestamp,
      messageCount: 2,
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
    }, workspace)
    const mirrorManaged = createManagedSession({
      id: sdkSessionId,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '无敌',
      createdAt: olderTimestamp - 30_000,
      lastUsedAt: olderTimestamp,
      lastMessageAt: olderTimestamp,
      messageCount: 2,
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
    }, workspace)
    ;(manager as unknown as { sessions: Map<string, typeof craftManaged> }).sessions.set(craftSessionId, craftManaged)
    ;(manager as unknown as { sessions: Map<string, typeof mirrorManaged> }).sessions.set(sdkSessionId, mirrorManaged)

    await (manager as unknown as {
      doRefreshExternalSessionsForWorkspace: (workspace: Workspace) => Promise<void>
    }).doRefreshExternalSessionsForWorkspace(workspace)

    const sessions = manager.getSessions(workspace.id)
    expect(sessions.map(session => session.id)).toContain(craftSessionId)
    expect(sessions.map(session => session.id)).not.toContain(sdkSessionId)
    expect(sessions.filter(session => session.name === '无敌')).toHaveLength(1)
    expect(loadSession(workspaceRoot, sdkSessionId)).toBeNull()
  })

  it('syncs Craft session titles to Qwen custom titles through the provider rename hook', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'))
    tempRoots.push(workspaceRoot, projectRoot)

    const timestamp = Date.parse('2026-04-26T10:12:13.000Z')
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    const renameCalls: Array<{ sessionId: string; title: string; cwd?: string }> = []
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        renameBackendSession: async (sessionId: string, title: string, options?: { cwd?: string }) => {
          renameCalls.push({ sessionId, title, cwd: options?.cwd })
          return true
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }
    const managed = createManagedSession({
      id: '260429-fix-session-names',
      name: 'Fix session names',
      sdkSessionId: 'fd2803fd-1070-41da-b7c0-10d978f7128c',
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      llmConnection: 'qwen-code',
    }, workspace)

    await (manager as unknown as {
      syncExternalBackendTitleIfSupported: (managedSession: unknown, title: string) => Promise<void>
    }).syncExternalBackendTitleIfSupported(managed, managed.name!)

    expect(renameCalls).toEqual([{
      sessionId: 'fd2803fd-1070-41da-b7c0-10d978f7128c',
      title: 'Fix session names',
      cwd: projectRoot,
    }])
  })

  it('skips placeholder provider-native sessions with no renderable history', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'))
    tempRoots.push(workspaceRoot, projectRoot)

    const sessionId = '4b0597de-374c-42c2-a032-58351d825115'
    const timestamp = Date.parse('2026-04-24T05:41:59.862Z')
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    let loadCalls = 0
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        listSessions: async () => ({
          sessions: [{
            sessionId,
            cwd: projectRoot,
            title: null,
            updatedAt: new Date(timestamp).toISOString(),
          }],
        }),
        loadSessionMessages: async (requestedSessionId: string, options?: { cwd?: string }) => {
          loadCalls += 1
          expect(requestedSessionId).toBe(sessionId)
          expect(options?.cwd).toBe(projectRoot)
          return []
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }

    await (manager as unknown as {
      doRefreshExternalSessionsForWorkspace: (workspace: Workspace) => Promise<void>
    }).doRefreshExternalSessionsForWorkspace(workspace)

    expect(loadCalls).toBe(1)
    expect(loadSession(workspaceRoot, sessionId)).toBeNull()
    expect(manager.getSessions(workspace.id).some(session => session.id === sessionId)).toBe(false)
  })

  it('does not repeatedly reload empty Qwen canonical history for the same external timestamp', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'))
    tempRoots.push(workspaceRoot, projectRoot)

    const sessionId = '260510-empty-qwen-native'
    const sdkSessionId = '7b4ffd3f-c8ad-4a6d-9b37-3309335bb12c'
    const timestamp = Date.parse('2026-05-09T17:03:17.731Z')
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: 'empty native history',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'allow-all',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    let loadCalls = 0
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        loadSessionMessages: async (requestedSessionId: string, options?: { cwd?: string }) => {
          loadCalls += 1
          expect(requestedSessionId).toBe(sdkSessionId)
          expect(options?.cwd).toBe(projectRoot)
          return []
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }
    const managed = createManagedSession({
      id: sessionId,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: 'empty native history',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 0,
      llmConnection: 'qwen-code',
      connectionLocked: true,
      thinkingLevel: 'medium',
    }, workspace)
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(sessionId, managed)

    await manager.getSession(sessionId)
    await manager.getSession(sessionId)

    expect(loadCalls).toBe(1)
  })

  it('removes existing empty placeholder mirrors from provider-native sync', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'))
    tempRoots.push(workspaceRoot, projectRoot)

    const sessionId = '5ed6265d-321d-4dc4-b186-8c69de6e20ba'
    const timestamp = Date.parse('2026-04-24T05:41:59.862Z')
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    })

    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '(session)',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        listSessions: async () => ({
          sessions: [{
            sessionId,
            cwd: projectRoot,
            title: '(session)',
            updatedAt: new Date(timestamp).toISOString(),
          }],
        }),
        loadSessionMessages: async () => [],
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }
    const managed = createManagedSession({
      id: sessionId,
      sdkSessionId: sessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '(session)',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 0,
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
    }, workspace)
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(sessionId, managed)

    await (manager as unknown as {
      doRefreshExternalSessionsForWorkspace: (workspace: Workspace) => Promise<void>
    }).doRefreshExternalSessionsForWorkspace(workspace)

    expect(loadSession(workspaceRoot, sessionId)).toBeNull()
    expect(manager.getSessions(workspace.id).some(session => session.id === sessionId)).toBe(false)
  })

  it('repairs placeholder mirrors that only captured slash command output', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-managed-workspace-'))
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'))
    tempRoots.push(workspaceRoot, projectRoot)

    const sessionId = 'b1e2b1a0-8ea5-4af5-85ba-dff6232c9c02'
    const invocationTimestamp = Date.parse('2026-03-25T07:36:47.100Z')
    const resultTimestamp = Date.parse('2026-03-25T07:36:53.143Z')
    const output = 'This may take a couple minutes. Sit tight!Insight report generated successfully!'
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: invocationTimestamp,
      updatedAt: invocationTimestamp,
    })

    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '(session)',
      createdAt: invocationTimestamp,
      lastUsedAt: resultTimestamp,
      lastMessageAt: resultTimestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [{ id: 'old-output', type: 'assistant', content: output, timestamp: resultTimestamp }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const nativeMessages: Message[] = [
      { id: 'qwen-slash-1', role: 'user', content: '/insight', timestamp: invocationTimestamp },
      { id: 'qwen-output-1', role: 'assistant', content: output, timestamp: resultTimestamp },
    ]
    let loadCalls = 0
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        listSessions: async () => ({
          sessions: [{
            sessionId,
            cwd: projectRoot,
            title: '(session)',
            updatedAt: new Date(resultTimestamp).toISOString(),
          }],
        }),
        loadSessionMessages: async (requestedSessionId: string, options?: { cwd?: string }) => {
          loadCalls += 1
          expect(requestedSessionId).toBe(sessionId)
          expect(options?.cwd).toBe(projectRoot)
          return nativeMessages
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: invocationTimestamp,
    }
    const managed = createManagedSession({
      id: sessionId,
      sdkSessionId: sessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '(session)',
      createdAt: invocationTimestamp,
      lastUsedAt: resultTimestamp,
      lastMessageAt: resultTimestamp,
      messageCount: 1,
      lastMessageRole: 'assistant',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
    }, workspace)
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(sessionId, managed)

    await (manager as unknown as {
      doRefreshExternalSessionsForWorkspace: (workspace: Workspace) => Promise<void>
    }).doRefreshExternalSessionsForWorkspace(workspace)

    const repaired = await manager.getSession(sessionId)
    await manager.flushSession(sessionId)

    expect(loadCalls).toBe(1)
    expect(repaired?.messages.map(message => [message.role, message.content])).toEqual([
      ['user', '/insight'],
      ['assistant', output],
    ])
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(0)
  })

  it('backfills an already-loaded empty local session from provider-native history', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-history-'))
    tempRoots.push(workspaceRoot)

    const sessionId = '43a34475-6e06-4a79-8536-84eb354f6584'
    const timestamp = Date.parse('2026-04-25T05:31:09.794Z')
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'hi again, please reply with pong',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const nativeMessages: Message[] = [
      { id: 'qwen-1', role: 'user', content: 'hi again, please reply with pong', timestamp },
      {
        id: 'qwen-2',
        role: 'assistant',
        content: 'The user is just saying hi and asking me to reply with "pong". Simple greeting-like interaction.',
        timestamp: timestamp + 1,
        isIntermediate: true,
      },
      { id: 'qwen-3', role: 'assistant', content: 'pong', timestamp: timestamp + 2 },
    ]

    let loadCalls = 0
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        loadSessionMessages: async (requestedSessionId: string, options?: { cwd?: string }) => {
          loadCalls += 1
          expect(requestedSessionId).toBe(sessionId)
          expect(options?.cwd).toBe(workspaceRoot)
          return {
            messages: nativeMessages,
            availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
            availableSkills: ['commit'],
          }
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })
    const events: unknown[] = []
    manager.setEventSink((_channel, _target, event) => {
      events.push(event)
    })

    const workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }
    const managed = createManagedSession({
      id: sessionId,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'hi again, please reply with pong',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 0,
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
    }, workspace, {
      messagesLoaded: true,
    })
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(sessionId, managed)

    const session = await manager.getSession(sessionId)

    expect(loadCalls).toBe(1)
    expect(session?.messages.map(message => [message.role, message.content, message.isIntermediate ?? false])).toEqual([
      ['user', 'hi again, please reply with pong', false],
      ['assistant', 'The user is just saying hi and asking me to reply with "pong". Simple greeting-like interaction.', true],
      ['assistant', 'pong', false],
    ])
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(0)
  })

  it('backfills a lazy-loaded empty local session from provider-native history', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-history-'))
    tempRoots.push(workspaceRoot)

    const sessionId = 'd0dec6b6-5565-42df-a667-9fdb2c1d8893'
    const timestamp = Date.parse('2026-04-24T09:24:14.927Z')
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: '# Commit and Push...',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const nativeMessages: Message[] = [
      { id: 'qwen-1', role: 'user', content: '# Commit and Push', timestamp },
      { id: 'qwen-2', role: 'assistant', content: '按照 `/commit` 流程开始执行。先检查仓库状态。', timestamp: timestamp + 1 },
      {
        id: 'qwen-3',
        role: 'tool',
        content: 'Running Bash...',
        timestamp: timestamp + 2,
        toolName: 'Bash',
        toolUseId: 'tool-status',
        toolStatus: 'completed',
        toolResult: 'On branch main',
      },
      { id: 'qwen-4', role: 'assistant', content: 'PR 已创建：https://github.com/QwenLM/qwen-code/pull/3593', timestamp: timestamp + 3 },
    ]

    let loadCalls = 0
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        loadSessionMessages: async (requestedSessionId: string, options?: { cwd?: string }) => {
          loadCalls += 1
          expect(requestedSessionId).toBe(sessionId)
          expect(options?.cwd).toBe(workspaceRoot)
          return {
            messages: nativeMessages,
            availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
            availableSkills: ['commit'],
          }
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })
    const events: unknown[] = []
    manager.setEventSink((_channel, _target, event) => {
      events.push(event)
    })

    const workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }
    const managed = createManagedSession({
      id: sessionId,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: '# Commit and Push...',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 0,
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
    }, workspace)
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(sessionId, managed)

    const session = await manager.getSession(sessionId)

    expect(loadCalls).toBe(1)
    expect(session?.messages.map(message => [message.role, message.content, message.toolName ?? ''])).toEqual([
      ['user', '# Commit and Push', ''],
      ['assistant', '按照 `/commit` 流程开始执行。先检查仓库状态。', ''],
      ['tool', 'Running Bash...', 'Bash'],
      ['assistant', 'PR 已创建：https://github.com/QwenLM/qwen-code/pull/3593', ''],
    ])
    expect(session?.availableCommands).toEqual([{ name: 'project:fix', description: 'Run project fix' }])
    expect(session?.availableSkills).toEqual(['commit'])
    expect(events).toContainEqual({
      type: 'available_commands_update',
      sessionId,
      availableCommands: [{ name: 'project:fix', description: 'Run project fix' }],
      availableSkills: ['commit'],
    })
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(0)
  })

  it('does not reload Qwen native history between repeated edits of the latest user message', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-edit-'))
    tempRoots.push(workspaceRoot)

    const sessionId = '1d537f0f-330f-48fc-bfbb-2b9e4c3b5e00'
    const timestamp = Date.parse('2026-05-09T09:00:00.000Z')
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'editable qwen session',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const nativeMessages: Message[] = [
      { id: `qwen-${sessionId}-1`, role: 'user', content: 'first prompt', timestamp },
      { id: `qwen-${sessionId}-2`, role: 'assistant', content: 'first answer', timestamp: timestamp + 1 },
      { id: `qwen-${sessionId}-7`, role: 'user', content: 'second prompt', timestamp: timestamp + 2 },
    ]

    let loadCalls = 0
    const manager = new SessionManager({
      createExternalSessionAgent: () => ({
        loadSessionMessages: async () => {
          loadCalls += 1
          return nativeMessages
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
    })

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }
    const managed = createManagedSession({
      id: sessionId,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'editable qwen session',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 0,
      llmConnection: 'qwen-code',
      connectionLocked: true,
    }, workspace)

    let rewindCalls = 0
    let chatCalls = 0
    const activeAgent = {
      rewindToUserTurn: async (targetTurnIndex: number) => {
        rewindCalls += 1
        expect(targetTurnIndex).toBe(1)
      },
      async *chat(): AsyncGenerator<AgentEvent> {
        chatCalls += 1
        yield { type: 'complete' } as AgentEvent
      },
      getModel: () => 'qwen3-coder-flash',
      setAllSources: () => {},
      getSessionId: () => sessionId,
      destroy: () => {},
      dispose: () => {},
    } as unknown as AgentBackend

    const managerInternals = manager as unknown as {
      sessions: Map<string, typeof managed>
      getOrCreateAgent: (session: typeof managed) => Promise<AgentBackend>
    }
    managerInternals.sessions.set(sessionId, managed)
    managerInternals.getOrCreateAgent = async (session) => {
      session.agent = activeAgent
      return activeAgent
    }

    await manager.updateMessageContent(sessionId, `qwen-${sessionId}-7`, 'second prompt edited once')
    await waitUntil(() => chatCalls === 1 && !managed.isProcessing)
    const firstEditedTimestamp = managed.messages.findLast(message => message.role === 'user')?.timestamp
    expect(firstEditedTimestamp).toBeGreaterThan(timestamp + 2)

    await manager.updateMessageContent(sessionId, `qwen-${sessionId}-7`, 'second prompt edited twice')
    await waitUntil(() => chatCalls === 2 && !managed.isProcessing)
    const secondEditedTimestamp = managed.messages.findLast(message => message.role === 'user')?.timestamp

    expect(loadCalls).toBe(1)
    expect(rewindCalls).toBe(2)
    expect(secondEditedTimestamp).toBeGreaterThan(firstEditedTimestamp ?? 0)
    expect(managed.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'first prompt'],
      ['assistant', 'first answer'],
      ['user', 'second prompt edited twice'],
    ])
  })

  it('uses the built-in Qwen Code connection for provider-native sessions missing llmConnection', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-history-'))
    tempRoots.push(workspaceRoot)

    const sessionId = '9c451e20-8efe-477b-8f88-928990b29e2c'
    const timestamp = Date.parse('2026-04-24T09:24:14.927Z')
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'legacy qwen session',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const nativeMessages: Message[] = [
      { id: 'qwen-1', role: 'user', content: 'legacy qwen session', timestamp },
      { id: 'qwen-2', role: 'assistant', content: 'loaded through built-in qwen-code', timestamp: timestamp + 1 },
    ]

    let resolvedConnectionSlug: string | undefined
    const manager = new SessionManager({
      createExternalSessionAgent: (_workspace, backendContext) => {
        resolvedConnectionSlug = backendContext.connection?.slug
        return {
          loadSessionMessages: async () => nativeMessages,
          destroy: () => {},
          dispose: () => {},
        } as unknown as AgentBackend
      },
    })

    const workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    }
    const managed = createManagedSession({
      id: sessionId,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'legacy qwen session',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      messageCount: 0,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
    }, workspace)
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(sessionId, managed)

    const session = await manager.getSession(sessionId)

    expect(resolvedConnectionSlug).toBe('qwen-code')
    expect(session?.messages).toHaveLength(2)
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(0)
  })
})
