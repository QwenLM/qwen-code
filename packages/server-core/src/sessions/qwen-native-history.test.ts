import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import type { Workspace } from '@craft-agent/shared/config'
import { loadSession, saveSession } from '@craft-agent/shared/sessions'
import { saveWorkspaceConfig } from '@craft-agent/shared/workspaces'
import type { Message } from '@craft-agent/core/types'
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

describe('Qwen native history loading', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
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
    expect(imported?.llmConnection).toBe('qwen-code')
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
      model: 'glm-5.1(openai)',
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
      model: 'glm-5.1(openai)',
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
      model: 'glm-5.1(openai)',
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
      model: 'glm-5.1(openai)',
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
    expect(loadSession(workspaceRoot, sessionId)?.messages.map(message => [message.type, message.content])).toEqual([
      ['user', '/insight'],
      ['assistant', output],
    ])
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
      model: 'glm-5.1(openai)',
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
          return nativeMessages
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
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
      model: 'glm-5.1(openai)',
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
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(3)
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
      model: 'glm-5.1(openai)',
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
          return nativeMessages
        },
        destroy: () => {},
        dispose: () => {},
      } as unknown as AgentBackend),
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
      model: 'glm-5.1(openai)',
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
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(4)
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
      model: 'glm-5.1(openai)',
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
      model: 'glm-5.1(openai)',
      thinkingLevel: 'medium',
    }, workspace)
    ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(sessionId, managed)

    const session = await manager.getSession(sessionId)

    expect(resolvedConnectionSlug).toBe('qwen-code')
    expect(session?.messages).toHaveLength(2)
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(2)
  })
})
