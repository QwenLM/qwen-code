/**
 * Tests for turn grouping stability across persist → reload.
 *
 * Verifies that messages run through the persistence pipeline
 * (centralized messageToStored → filter intermediate → centralized storedToMessage)
 * produce the same turn structure when grouped.
 *
 * Imports groupMessagesByTurn (pure function) from turn-utils.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '@craft-agent/ui/chat/turn-utils'
import { messageToStored, storedToMessage } from '@craft-agent/core'
import type { Message, MessageRole } from '@craft-agent/core'

// ============================================================================
// Mirror: persistence pipeline (two-stage filter)
// ============================================================================

function simulatePersistAndReload(messages: Message[]): Message[] {
  // Stage 1: persistSession filters status messages
  const afterStatusFilter = messages.filter(m => m.role !== 'status')
  // Stage 2: convert to stored
  const stored = afterStatusFilter.map(messageToStored)
  // Stage 3: persistence-queue filters intermediate messages
  const persistable = stored.filter(m => !m.isIntermediate)
  // Stage 4: reload — convert back to runtime messages
  return persistable.map(storedToMessage)
}

// ============================================================================
// Test Helpers
// ============================================================================

let idCounter = 0
function resetCounters() { idCounter = 0 }

function createMessage(role: MessageRole, overrides: Partial<Message> = {}): Message {
  const id = `msg-${++idCounter}`
  return {
    id,
    role,
    content: overrides.content ?? `Content ${id}`,
    timestamp: Date.now() + idCounter * 100,
    ...overrides,
  }
}

function getAssistantTurns(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn[] {
  return turns.filter(t => t.type === 'assistant') as AssistantTurn[]
}

// ============================================================================
// Tests
// ============================================================================

describe('turn grouping stability across reload', () => {
  beforeEach(resetCounters)

  it('simple conversation: user + assistant', () => {
    const turnId = 'turn-1'
    const messages: Message[] = [
      createMessage('user', { content: 'Hello' }),
      createMessage('assistant', { content: 'Hi there!', turnId }),
    ]

    const liveGrouping = groupMessagesByTurn(messages)
    const reloaded = simulatePersistAndReload(messages)
    const reloadGrouping = groupMessagesByTurn(reloaded)

    // Same number of turns
    expect(reloadGrouping).toHaveLength(liveGrouping.length)

    // Same turn types
    expect(reloadGrouping.map(t => t.type)).toEqual(liveGrouping.map(t => t.type))

    // Assistant response text preserved
    const liveAssistant = getAssistantTurns(liveGrouping)[0]
    const reloadAssistant = getAssistantTurns(reloadGrouping)[0]
    expect(reloadAssistant?.response?.text).toBe(liveAssistant?.response?.text)
  })

  it('multi-tool turn: tools appear as activities, assistant as response', () => {
    const turnId = 'turn-2'
    const messages: Message[] = [
      createMessage('user', { content: 'Read two files' }),
      createMessage('tool', {
        toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed',
        toolResult: 'File 1', turnId,
      }),
      createMessage('assistant', {
        content: 'Let me read the second file', isIntermediate: true, turnId,
      }),
      createMessage('tool', {
        toolName: 'Read', toolUseId: 'tu-2', toolStatus: 'completed',
        toolResult: 'File 2', turnId,
      }),
      createMessage('assistant', { content: 'Here are both files.', turnId }),
    ]

    const liveGrouping = groupMessagesByTurn(messages)
    const reloaded = simulatePersistAndReload(messages)
    const reloadGrouping = groupMessagesByTurn(reloaded)

    // After reload, intermediate text is filtered out but turns should still work
    const liveAssistants = getAssistantTurns(liveGrouping)
    const reloadAssistants = getAssistantTurns(reloadGrouping)

    // Should have at least one assistant turn with the final response
    expect(reloadAssistants.length).toBeGreaterThan(0)

    // Final response text preserved
    const lastLive = liveAssistants[liveAssistants.length - 1]
    const lastReload = reloadAssistants[reloadAssistants.length - 1]
    expect(lastReload?.response?.text).toBe(lastLive?.response?.text)
  })

  it('background task turn: taskId, shellId, isBackground survive', () => {
    const turnId = 'turn-3'
    const messages: Message[] = [
      createMessage('user', { content: 'Run in background' }),
      createMessage('tool', {
        toolName: 'Task', toolUseId: 'tu-task-1', toolStatus: 'backgrounded',
        taskId: 'agent-123', isBackground: true, turnId,
      }),
      createMessage('assistant', { content: 'Task running in background.', turnId }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const bgTool = reloaded.find(m => m.role === 'tool')

    expect(bgTool?.taskId).toBe('agent-123')
    expect(bgTool?.isBackground).toBe(true)
    expect(bgTool?.toolStatus).toBe('backgrounded')
  })

  it('nested subagent tools: parentToolUseId survives and groups correctly', () => {
    const turnId = 'turn-4'
    const messages: Message[] = [
      createMessage('user', { content: 'Use subagent' }),
      createMessage('tool', {
        toolName: 'Task', toolUseId: 'tu-parent', toolStatus: 'completed',
        toolResult: 'Agent result', turnId,
      }),
      createMessage('tool', {
        toolName: 'Read', toolUseId: 'tu-child-1', toolStatus: 'completed',
        toolResult: 'File contents', parentToolUseId: 'tu-parent',
        isIntermediate: true, turnId,
      }),
      createMessage('assistant', { content: 'Done with subagent.', turnId }),
    ]

    const reloaded = simulatePersistAndReload(messages)

    // Parent tool survives
    const parentTool = reloaded.find(m => m.toolUseId === 'tu-parent')
    expect(parentTool).toBeDefined()
    expect(parentTool?.parentToolUseId).toBeUndefined()

    // Child tool is intermediate → filtered out by persistence pipeline
    const childTool = reloaded.find(m => m.toolUseId === 'tu-child-1')
    expect(childTool).toBeUndefined()

    // Grouping still produces valid turns
    const reloadGrouping = groupMessagesByTurn(reloaded)
    const assistantTurns = getAssistantTurns(reloadGrouping)
    expect(assistantTurns.length).toBeGreaterThan(0)
  })

  it('intermediate text is filtered but turns remain valid', () => {
    const turnId = 'turn-5'
    const messages: Message[] = [
      createMessage('user', { content: 'Do something' }),
      createMessage('assistant', {
        content: 'Let me think...', isIntermediate: true, turnId,
      }),
      createMessage('tool', {
        toolName: 'Grep', toolUseId: 'tu-grep', toolStatus: 'completed',
        toolResult: 'Found matches', turnId,
      }),
      createMessage('assistant', {
        content: 'Here are the results.', isIntermediate: false, turnId,
      }),
    ]

    const liveGrouping = groupMessagesByTurn(messages)
    const reloaded = simulatePersistAndReload(messages)
    const reloadGrouping = groupMessagesByTurn(reloaded)

    // Intermediate text is gone
    expect(reloaded.find(m => m.isIntermediate)).toBeUndefined()

    // But turn structure is still valid
    const reloadAssistants = getAssistantTurns(reloadGrouping)
    expect(reloadAssistants.length).toBeGreaterThan(0)

    // Final response preserved
    const lastReload = reloadAssistants[reloadAssistants.length - 1]
    expect(lastReload?.response?.text).toBe('Here are the results.')
  })

  it('plan message turn: planPath survives reload', () => {
    const messages: Message[] = [
      createMessage('user', { content: 'Plan it' }),
      createMessage('plan', {
        content: '# Implementation Plan\n\n1. Do thing',
        planPath: '/sessions/123/plans/plan.md',
      }),
      createMessage('user', { content: 'Looks good, execute' }),
      createMessage('assistant', { content: 'Done.', turnId: 'turn-6' }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const planMsg = reloaded.find(m => m.role === 'plan')

    expect(planMsg).toBeDefined()
    expect(planMsg?.planPath).toBe('/sessions/123/plans/plan.md')
  })

  it('error turn: typed error fields survive reload', () => {
    const messages: Message[] = [
      createMessage('user', { content: 'Do something' }),
      createMessage('error', {
        content: 'Connection Failed: Could not connect',
        errorCode: 'network_error',
        errorTitle: 'Connection Failed',
        errorDetails: ['DNS lookup failed'],
        errorOriginal: 'ENOTFOUND',
        errorCanRetry: true,
      }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const errorMsg = reloaded.find(m => m.role === 'error')

    expect(errorMsg).toBeDefined()
    expect(errorMsg?.errorCode).toBe('network_error')
    expect(errorMsg?.errorTitle).toBe('Connection Failed')
    expect(errorMsg?.errorDetails).toEqual(['DNS lookup failed'])
    expect(errorMsg?.errorOriginal).toBe('ENOTFOUND')
    expect(errorMsg?.errorCanRetry).toBe(true)
  })

  it('auth-request turn: all auth fields survive reload', () => {
    const messages: Message[] = [
      createMessage('user', { content: 'Use linear' }),
      createMessage('auth-request', {
        content: 'Authentication required',
        authRequestId: 'req-1',
        authRequestType: 'credential',
        authSourceSlug: 'linear',
        authSourceName: 'Linear',
        authStatus: 'completed',
        authCredentialMode: 'bearer',
        authHeaderName: 'Authorization',
        authHeaderNames: ['DD-API-KEY'],
        authLabels: { credential: 'API Token' },
        authDescription: 'Enter your key',
        authHint: 'Settings > API',
        authSourceUrl: 'https://linear.app',
        authPasswordRequired: false,
        authEmail: 'user@test.com',
        authWorkspace: 'my-workspace',
      }),
      createMessage('assistant', { content: 'Connected!', turnId: 'turn-7' }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const authMsg = reloaded.find(m => m.role === 'auth-request')

    expect(authMsg).toBeDefined()
    expect(authMsg?.authRequestId).toBe('req-1')
    expect(authMsg?.authRequestType).toBe('credential')
    expect(authMsg?.authSourceSlug).toBe('linear')
    expect(authMsg?.authSourceName).toBe('Linear')
    expect(authMsg?.authStatus).toBe('completed')
    expect(authMsg?.authCredentialMode).toBe('bearer')
    expect(authMsg?.authHeaderName).toBe('Authorization')
    expect(authMsg?.authHeaderNames).toEqual(['DD-API-KEY'])
    expect(authMsg?.authLabels).toEqual({ credential: 'API Token' })
    expect(authMsg?.authDescription).toBe('Enter your key')
    expect(authMsg?.authHint).toBe('Settings > API')
    expect(authMsg?.authSourceUrl).toBe('https://linear.app')
    expect(authMsg?.authPasswordRequired).toBe(false)
    expect(authMsg?.authEmail).toBe('user@test.com')
    expect(authMsg?.authWorkspace).toBe('my-workspace')
  })
})
