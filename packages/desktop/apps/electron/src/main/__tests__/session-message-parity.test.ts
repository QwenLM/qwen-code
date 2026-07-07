/**
 * Tests for session message persistence ↔ UI parity.
 *
 * Ensures messageToStored/storedToMessage round-trip is complete,
 * parentToolUseId passes through unconditionally, and the persistence
 * pipeline filters the correct message types.
 *
 * Uses centralized core mappers (single source of truth, no Electron imports needed).
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { messageToStored, storedToMessage } from '@craft-agent/core'
import type { Message, StoredMessage, MessageRole } from '@craft-agent/core'

// ============================================================================
// Test Helpers
// ============================================================================

/** Create a Message with EVERY optional field populated to a truthy value */
function createFullMessage(): Message {
  return {
    id: 'msg-full-test',
    role: 'tool',
    content: 'Tool output',
    timestamp: 1700000000000,
    toolName: 'Read',
    toolUseId: 'tu-123',
    toolInput: { file_path: '/test.ts' },
    toolResult: 'File contents...',
    toolStatus: 'completed',
    toolDuration: 1500,
    toolIntent: 'Reading test file',
    toolDisplayName: 'Read File',
    toolDisplayMeta: { displayName: 'Read', category: 'native' },
    parentToolUseId: 'tu-parent-456',
    taskId: 'task-789',
    shellId: 'shell-012',
    elapsedSeconds: 42,
    isBackground: true,
    isError: false,
    attachments: [{ id: 'att-1', type: 'text', name: 'file.txt', mimeType: 'text/plain', size: 100, storedPath: '/path' }],
    textElements: [{
      type: 'source',
      byte_range: { start: 0, end: 7 },
      placeholder: '@linear',
      label: 'Linear',
      target: 'linear',
    }],
    annotations: [{
      id: 'ann-1',
      schemaVersion: 1,
      createdAt: 1700000000100,
      intent: 'highlight',
      body: [{ type: 'highlight' }],
      target: {
        source: { sessionId: 'session-1', messageId: 'msg-full-test' },
        selectors: [
          { type: 'text-position', start: 0, end: 4 },
          { type: 'text-quote', exact: 'Tool', prefix: '', suffix: ' output' },
        ],
      },
      style: { color: 'yellow' },
    }],
    isStreaming: false,
    isPending: false,
    isIntermediate: false,
    turnId: 'turn-abc',
    infoLevel: 'warning',
    errorCode: 'network_error',
    errorTitle: 'Connection Failed',
    errorDetails: ['DNS lookup failed'],
    errorOriginal: 'ENOTFOUND',
    errorCanRetry: true,
    planPath: '/plans/plan.md',
    authRequestId: 'auth-req-1',
    authRequestType: 'credential',
    authSourceSlug: 'linear',
    authSourceName: 'Linear',
    authStatus: 'pending',
    authCredentialMode: 'bearer',
    authHeaderName: 'Authorization',
    authHeaderNames: ['DD-API-KEY', 'DD-APP-KEY'],
    authLabels: { credential: 'API Token' },
    authDescription: 'Enter your Linear API key',
    authHint: 'Found in Settings > API',
    authSourceUrl: 'https://linear.app',
    authPasswordRequired: false,
    authError: 'Invalid token',
    authEmail: 'user@test.com',
    authWorkspace: 'test-workspace',
    isQueued: false,
  }
}

/** Create a minimal Message with only required fields */
function createMinimalMessage(role: MessageRole = 'user'): Message {
  return {
    id: 'msg-minimal',
    role,
    content: 'Hello',
    timestamp: 1700000000000,
  }
}

// ============================================================================
// 1a. StoredMessage ↔ Message Round-Trip
// ============================================================================

describe('messageToStored/storedToMessage round-trip', () => {
  it('exhaustive StoredMessage key coverage — catches missing fields', () => {
    // Build a fully-populated StoredMessage to enumerate all its keys
    const fullMsg = createFullMessage()
    const stored = messageToStored(fullMsg)

    // Every key of the StoredMessage interface that has a value should be present
    // This is the "alarm" — if someone adds a field to StoredMessage but not
    // to messageToStored, the field won't appear here and can be caught by
    // comparing against a known set.
    const storedKeys = Object.keys(stored).sort()

    // Known StoredMessage keys (update this list when adding fields)
    const expectedKeys = [
      'id', 'type', 'content', 'timestamp',
      'toolName', 'toolUseId', 'toolInput', 'toolResult', 'toolStatus',
      'toolDuration', 'toolIntent', 'toolDisplayName', 'toolDisplayMeta',
      'parentToolUseId',
      'taskId', 'shellId', 'elapsedSeconds', 'isBackground',
      'isError', 'attachments', 'textElements', 'annotations',
      'isIntermediate', 'turnId', 'infoLevel',
      'errorCode', 'errorTitle', 'errorDetails', 'errorOriginal', 'errorCanRetry',
      'planPath',
      'authRequestId', 'authRequestType', 'authSourceSlug', 'authSourceName',
      'authStatus', 'authCredentialMode', 'authHeaderName', 'authHeaderNames',
      'authLabels', 'authDescription', 'authHint', 'authSourceUrl',
      'authPasswordRequired', 'authError', 'authEmail', 'authWorkspace',
      'isQueued',
    ].sort()

    expect(storedKeys).toEqual(expectedKeys)
  })

  it('full round-trip preserves all persisted fields', () => {
    const original = createFullMessage()
    const stored = messageToStored(original)
    const restored = storedToMessage(stored)

    // role ↔ type
    expect(restored.role).toBe(original.role)
    // All persisted fields should match
    expect(restored.id).toBe(original.id)
    expect(restored.content).toBe(original.content)
    expect(restored.timestamp).toBe(original.timestamp)
    expect(restored.toolName).toBe(original.toolName)
    expect(restored.toolUseId).toBe(original.toolUseId)
    expect(restored.toolInput).toEqual(original.toolInput)
    expect(restored.toolResult).toBe(original.toolResult)
    expect(restored.toolStatus).toBe(original.toolStatus)
    expect(restored.toolDuration).toBe(original.toolDuration)
    expect(restored.toolIntent).toBe(original.toolIntent)
    expect(restored.toolDisplayName).toBe(original.toolDisplayName)
    expect(restored.toolDisplayMeta).toEqual(original.toolDisplayMeta)
    expect(restored.parentToolUseId).toBe(original.parentToolUseId)
    expect(restored.taskId).toBe(original.taskId)
    expect(restored.shellId).toBe(original.shellId)
    expect(restored.elapsedSeconds).toBe(original.elapsedSeconds)
    expect(restored.isBackground).toBe(original.isBackground)
    expect(restored.isError).toBe(original.isError)
    expect(restored.attachments).toEqual(original.attachments)
    expect(restored.textElements).toEqual(original.textElements)
    expect(restored.annotations).toEqual(original.annotations)
    expect(restored.isIntermediate).toBe(original.isIntermediate)
    expect(restored.turnId).toBe(original.turnId)
    expect(restored.infoLevel).toBe(original.infoLevel)
    expect(restored.errorCode).toBe(original.errorCode)
    expect(restored.errorTitle).toBe(original.errorTitle)
    expect(restored.errorDetails).toEqual(original.errorDetails)
    expect(restored.errorOriginal).toBe(original.errorOriginal)
    expect(restored.errorCanRetry).toBe(original.errorCanRetry)
    expect(restored.planPath).toBe(original.planPath)
    expect(restored.authRequestId).toBe(original.authRequestId)
    expect(restored.authRequestType).toBe(original.authRequestType)
    expect(restored.authSourceSlug).toBe(original.authSourceSlug)
    expect(restored.authSourceName).toBe(original.authSourceName)
    expect(restored.authStatus).toBe(original.authStatus)
    expect(restored.authCredentialMode).toBe(original.authCredentialMode)
    expect(restored.authHeaderName).toBe(original.authHeaderName)
    expect(restored.authHeaderNames).toEqual(original.authHeaderNames)
    expect(restored.authLabels).toEqual(original.authLabels)
    expect(restored.authDescription).toBe(original.authDescription)
    expect(restored.authHint).toBe(original.authHint)
    expect(restored.authSourceUrl).toBe(original.authSourceUrl)
    expect(restored.authPasswordRequired).toBe(original.authPasswordRequired)
    expect(restored.authError).toBe(original.authError)
    expect(restored.authEmail).toBe(original.authEmail)
    expect(restored.authWorkspace).toBe(original.authWorkspace)
    expect(restored.isQueued).toBe(original.isQueued)
  })

  it('role ↔ type mapping works for each MessageRole', () => {
    const roles: MessageRole[] = ['user', 'assistant', 'tool', 'error', 'info', 'warning', 'plan', 'auth-request']

    for (const role of roles) {
      const msg = createMinimalMessage(role)
      const stored = messageToStored(msg)
      expect(stored.type).toBe(role)

      const restored = storedToMessage(stored)
      expect(restored.role).toBe(role)
    }
  })

  it('transient fields are excluded from StoredMessage', () => {
    const msg = createFullMessage()
    const stored = messageToStored(msg)

    // These are intentionally transient — NOT persisted
    expect(stored).not.toHaveProperty('isStreaming')
    expect(stored).not.toHaveProperty('isPending')

    // infoLevel IS persisted for info-message severity restoration after reload
    expect(stored.infoLevel).toBe(msg.infoLevel)

    const storedKeys = Object.keys(stored)
    expect(storedKeys).not.toContain('isStreaming')
    expect(storedKeys).not.toContain('isPending')
    expect(storedKeys).toContain('infoLevel')
  })

  it('minimal message round-trips cleanly', () => {
    const msg = createMinimalMessage()
    const stored = messageToStored(msg)
    const restored = storedToMessage(stored)

    expect(restored.id).toBe(msg.id)
    expect(restored.role).toBe(msg.role)
    expect(restored.content).toBe(msg.content)
    expect(restored.timestamp).toBe(msg.timestamp)
  })

  it('storedToMessage defaults timestamp when undefined', () => {
    const stored: StoredMessage = {
      id: 'msg-1',
      type: 'assistant',
      content: 'Hello',
      // timestamp intentionally omitted
    }
    const before = Date.now()
    const restored = storedToMessage(stored)
    const after = Date.now()

    expect(restored.timestamp).toBeGreaterThanOrEqual(before)
    expect(restored.timestamp).toBeLessThanOrEqual(after)
  })
})

// ============================================================================
// 1b. parentToolUseId Pass-Through
// ============================================================================

describe('parentToolUseId pass-through', () => {
  it('non-intermediate message preserves parentToolUseId', () => {
    const msg: Message = {
      ...createMinimalMessage('assistant'),
      isIntermediate: false,
      parentToolUseId: 'task-123',
    }
    const stored = messageToStored(msg)
    expect(stored.parentToolUseId).toBe('task-123')

    const restored = storedToMessage(stored)
    expect(restored.parentToolUseId).toBe('task-123')
  })

  it('intermediate message preserves parentToolUseId', () => {
    const msg: Message = {
      ...createMinimalMessage('assistant'),
      isIntermediate: true,
      parentToolUseId: 'task-456',
    }
    const stored = messageToStored(msg)
    expect(stored.parentToolUseId).toBe('task-456')

    const restored = storedToMessage(stored)
    expect(restored.parentToolUseId).toBe('task-456')
  })

  it('absent parentToolUseId stays absent', () => {
    const msg = createMinimalMessage('assistant')
    const stored = messageToStored(msg)
    expect(stored.parentToolUseId).toBeUndefined()

    const restored = storedToMessage(stored)
    expect(restored.parentToolUseId).toBeUndefined()
  })
})

// ============================================================================
// 1c. Persistence Pipeline Filtering
// ============================================================================

describe('persistence pipeline filtering', () => {
  function createMessageWithRole(role: MessageRole, extra: Partial<Message> = {}): Message {
    return { id: `msg-${role}`, role, content: `${role} content`, timestamp: Date.now(), ...extra }
  }

  it('status messages are filtered before storage', () => {
    const messages: Message[] = [
      createMessageWithRole('user'),
      createMessageWithRole('assistant'),
      createMessageWithRole('tool'),
      createMessageWithRole('status'),
      createMessageWithRole('info'),
      createMessageWithRole('error'),
      createMessageWithRole('plan'),
      createMessageWithRole('auth-request'),
    ]

    // Mirror: persistSession filter
    const filtered = messages.filter(m => m.role !== 'status')

    expect(filtered).toHaveLength(7)
    expect(filtered.map(m => m.role)).not.toContain('status')
    expect(filtered.map(m => m.role)).toContain('user')
    expect(filtered.map(m => m.role)).toContain('assistant')
    expect(filtered.map(m => m.role)).toContain('tool')
    expect(filtered.map(m => m.role)).toContain('info')
    expect(filtered.map(m => m.role)).toContain('error')
    expect(filtered.map(m => m.role)).toContain('plan')
    expect(filtered.map(m => m.role)).toContain('auth-request')
  })

  it('intermediate messages are filtered at write time', () => {
    const stored: StoredMessage[] = [
      { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1 },
      { id: 'msg-2', type: 'assistant', content: 'Thinking...', timestamp: 2, isIntermediate: true },
      { id: 'msg-3', type: 'assistant', content: 'Final answer', timestamp: 3, isIntermediate: false },
      { id: 'msg-4', type: 'tool', content: 'Read result', timestamp: 4 },
    ]

    // Mirror: persistence-queue.ts write() filter
    const persistable = stored.filter(m => !m.isIntermediate)

    expect(persistable).toHaveLength(3)
    expect(persistable.map(m => m.id)).toEqual(['msg-1', 'msg-3', 'msg-4'])
  })

  it('combined pipeline filters correctly', () => {
    const messages: Message[] = [
      createMessageWithRole('user'),
      createMessageWithRole('status', { statusType: 'compacting' }),
      createMessageWithRole('assistant', { isIntermediate: true, id: 'msg-intermediate' }),
      createMessageWithRole('tool', { toolName: 'Read', toolUseId: 'tu-1' }),
      createMessageWithRole('assistant', { isIntermediate: false, id: 'msg-final' }),
      createMessageWithRole('info', { infoLevel: 'success' }),
    ]

    // Stage 1: persistSession filters status
    const afterStatusFilter = messages.filter(m => m.role !== 'status')
    // Stage 2: convert to stored
    const stored = afterStatusFilter.map(messageToStored)
    // Stage 3: persistence-queue filters intermediate
    const final = stored.filter(m => !m.isIntermediate)

    expect(final).toHaveLength(4)
    expect(final.map(m => m.type)).toEqual(['user', 'tool', 'assistant', 'info'])
    expect(final.find(m => m.type === 'assistant')?.id).toBe('msg-final')
  })
})
