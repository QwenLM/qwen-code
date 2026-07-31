import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

describe('groupMessagesByTurn plan annotations', () => {
  it('keeps plan message id and annotations on plan activity payload', () => {
    const annotations: NonNullable<Message['annotations']> = [{
      id: 'ann-plan-1',
      schemaVersion: 1,
      createdAt: 1700000000000,
      intent: 'highlight',
      body: [{ type: 'highlight' }],
      target: {
        source: { sessionId: 'session-1', messageId: 'plan-msg-1' },
        selectors: [
          { type: 'text-position', start: 0, end: 4 },
          { type: 'text-quote', exact: 'Plan', prefix: '', suffix: ' details' },
        ],
      },
      style: { color: 'yellow' },
    }]

    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Create a plan',
        timestamp: 1000,
      },
      {
        id: 'tool-1',
        role: 'tool',
        content: 'Submitting plan',
        timestamp: 1100,
        toolName: 'mcp__session__SubmitPlan',
        toolUseId: 'tu-1',
        toolStatus: 'completed',
      },
      {
        id: 'plan-msg-1',
        role: 'plan',
        content: '# Plan\n- Step 1',
        timestamp: 1200,
        annotations,
      },
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurn = turns.find((turn) => turn.type === 'assistant')

    expect(assistantTurn).toBeDefined()
    if (!assistantTurn || assistantTurn.type !== 'assistant') return

    const planActivity = assistantTurn.activities.find((activity) => activity.type === 'plan')
    expect(planActivity).toBeDefined()
    expect(planActivity?.messageId).toBe('plan-msg-1')
    expect(planActivity?.annotations).toEqual(annotations)
  })
})
