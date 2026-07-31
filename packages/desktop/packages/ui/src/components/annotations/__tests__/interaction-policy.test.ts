import { describe, expect, it } from 'bun:test'
import { createTextSelectionAnnotation } from '../annotation-core'
import {
  getAnnotationChipInteraction,
  isAnnotationChipClickable,
} from '../interaction-policy'

function createAnnotation(note = 'Follow-up note') {
  return createTextSelectionAnnotation(
    'msg-1',
    {
      start: 0,
      end: 4,
      selectedText: 'test',
      prefix: '',
      suffix: 'ing',
    },
    note,
    'session-1',
  )
}

describe('annotation interaction policy', () => {
  it('treats sent annotations as tooltip-only and non-clickable', () => {
    const annotation = createAnnotation('Already sent')
    const meta = (annotation.meta ?? {}) as Record<string, unknown>
    meta.followUp = {
      text: 'Already sent',
      sentAt: Date.now(),
      sentText: 'Already sent',
    }
    annotation.meta = meta

    const policy = getAnnotationChipInteraction(annotation)

    expect(policy.state).toBe('sent')
    expect(policy.openMode).toBe('view')
    expect(policy.clickable).toBe(false)
    expect(policy.tooltipOnly).toBe(true)
    expect(isAnnotationChipClickable(annotation)).toBe(false)
  })

  it('keeps pending annotations clickable in view mode', () => {
    const annotation = createAnnotation('Needs follow-up')

    const policy = getAnnotationChipInteraction(annotation)

    expect(policy.state).toBe('pending')
    expect(policy.openMode).toBe('view')
    expect(policy.clickable).toBe(true)
    expect(policy.tooltipOnly).toBe(false)
    expect(isAnnotationChipClickable(annotation)).toBe(true)
  })

  it('keeps note-less annotations clickable', () => {
    const annotation = createTextSelectionAnnotation(
      'msg-1',
      {
        start: 5,
        end: 9,
        selectedText: 'none',
        prefix: 'a ',
        suffix: ' b',
      },
      '',
      'session-1',
    )

    const policy = getAnnotationChipInteraction(annotation)

    expect(policy.state).toBe('none')
    expect(policy.clickable).toBe(true)
    expect(policy.tooltipOnly).toBe(false)
  })
})
