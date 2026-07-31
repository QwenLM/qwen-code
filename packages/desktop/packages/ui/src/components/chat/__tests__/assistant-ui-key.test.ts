import { describe, expect, it } from 'bun:test'
import { getAssistantTurnUiKey, type AssistantTurn } from '../turn-utils'

function makeAssistantTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    type: 'assistant',
    turnId: 'pi-turn-1',
    activities: [],
    response: undefined,
    intent: undefined,
    isStreaming: false,
    isComplete: true,
    timestamp: 123,
    ...overrides,
  }
}

describe('getAssistantTurnUiKey', () => {
  it('uses response message id when available', () => {
    const turn = makeAssistantTurn({
      response: {
        text: 'Done',
        isStreaming: false,
        messageId: 'msg-final-1',
      },
    })

    expect(getAssistantTurnUiKey(turn, 0)).toBe('assistant:msg:msg-final-1')
  })

  it('disambiguates split cards with same turnId/timestamp via index fallback', () => {
    const turnA = makeAssistantTurn({ turnId: 'pi-turn-1', timestamp: 555 })
    const turnB = makeAssistantTurn({ turnId: 'pi-turn-1', timestamp: 555 })

    const keyA = getAssistantTurnUiKey(turnA, 2)
    const keyB = getAssistantTurnUiKey(turnB, 3)

    expect(keyA).not.toBe(keyB)
    expect(keyA).toBe('assistant:turn:pi-turn-1:555:2')
    expect(keyB).toBe('assistant:turn:pi-turn-1:555:3')
  })
})
