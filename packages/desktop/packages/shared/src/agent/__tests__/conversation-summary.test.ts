import { describe, expect, it, mock } from 'bun:test'

import {
  buildConversationSummaryPrompt,
  buildConversationSummaryTranscript,
  buildTransferredSessionContext,
  generateConversationSummary,
} from '../conversation-summary.ts'

describe('conversation-summary helpers', () => {
  it('bounds individual messages and total transcript length', () => {
    const transcript = buildConversationSummaryTranscript(
      Array.from({ length: 40 }, (_, index) => ({
        type: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: String(index).repeat(700),
      }))
    )

    expect(transcript).toStartWith(`User: ${'0'.repeat(500)}`)
    expect(transcript).toContain(`Assistant: ${'1'.repeat(500)}`)
    expect(transcript.length).toBe(12_000)
  })

  it('builds the same reusable summary prompt used by branch fallback', () => {
    const prompt = buildConversationSummaryPrompt([
      { type: 'user', content: 'Need to ship the mobile fix.' },
      { type: 'assistant', content: 'Working through the remaining edge cases.' },
    ])

    expect(prompt).toContain('Summarize this conversation concisely. Preserve: key decisions, ongoing tasks, technical context, and the user\'s current goal. Be specific, not generic.')
    expect(prompt).toContain('User: Need to ship the mobile fix.')
    expect(prompt).toContain('Assistant: Working through the remaining edge cases.')
  })

  it('delegates summary generation to the provided mini completion callback', async () => {
    const runMiniCompletion = mock(async (prompt: string) => {
      expect(prompt).toContain('User: First message')
      return 'condensed summary'
    })

    const result = await generateConversationSummary([
      { type: 'user', content: 'First message' },
    ], runMiniCompletion)

    expect(result).toBe('condensed summary')
    expect(runMiniCompletion).toHaveBeenCalledTimes(1)
  })

  it('formats transferred-session context as a hidden one-shot block', () => {
    expect(buildTransferredSessionContext('Keep the remote workspace aligned.')).toBe(`<session_transfer_summary>
This session was transferred from another workspace. The original conversation was summarized before transfer.
Use the summary below as prior context for the next turn.

Keep the remote workspace aligned.
</session_transfer_summary>`)
  })
})
