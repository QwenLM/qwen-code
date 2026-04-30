import { describe, expect, it } from 'vitest'
import {
  annotationInteractionActions,
  annotationInteractionReducer,
  initialAnnotationInteractionState,
} from '../interaction-state-machine'

describe('annotation interaction state machine', () => {
  it('opens selection into compact view and then confirm follow-up', () => {
    const withSelection = annotationInteractionReducer(
      initialAnnotationInteractionState,
      annotationInteractionActions.openFromSelection({
        start: 1,
        end: 4,
        selectedText: 'abc',
        prefix: 'x',
        suffix: 'y',
        anchorX: 120,
        anchorY: 240,
      }),
    )

    expect(withSelection.pendingSelection?.start).toBe(1)
    expect(withSelection.selectionMenuView).toBe('compact')
    expect(withSelection.followUpMode).toBe('edit')
    expect(withSelection.selectionMenuAnchor).toEqual({ x: 120, y: 240 })

    const confirm = annotationInteractionReducer(
      withSelection,
      annotationInteractionActions.openFollowUpFromSelection(),
    )

    expect(confirm.selectionMenuView).toBe('confirm-follow-up')
    expect(confirm.followUpMode).toBe('edit')
  })

  it('opens annotation detail in view mode and keeps anchor', () => {
    const next = annotationInteractionReducer(
      initialAnnotationInteractionState,
      annotationInteractionActions.openFromAnnotation(
        { annotationId: 'ann-1', index: 2, anchorX: 300, anchorY: 160 },
        'Existing note',
        'view',
      ),
    )

    expect(next.pendingSelection).toBeNull()
    expect(next.activeAnnotationDetail?.annotationId).toBe('ann-1')
    expect(next.selectionMenuView).toBe('confirm-follow-up')
    expect(next.followUpMode).toBe('view')
    expect(next.followUpDraft).toBe('Existing note')
    expect(next.selectionMenuAnchor).toEqual({ x: 300, y: 160 })
  })

  it('cancel from annotation detail closes fully', () => {
    const opened = annotationInteractionReducer(
      initialAnnotationInteractionState,
      annotationInteractionActions.openFromAnnotation(
        { annotationId: 'ann-2', index: 1, anchorX: 220, anchorY: 120 },
        'note',
        'view',
      ),
    )

    const cancelled = annotationInteractionReducer(opened, annotationInteractionActions.cancelFollowUp())

    expect(cancelled).toEqual(initialAnnotationInteractionState)
  })

  it('cancel from pending selection returns to compact while preserving pending selection', () => {
    const selectionState = annotationInteractionReducer(
      initialAnnotationInteractionState,
      annotationInteractionActions.openFromSelection({
        start: 2,
        end: 7,
        selectedText: 'pending',
        prefix: 'p',
        suffix: 's',
        anchorX: 140,
        anchorY: 210,
      }),
    )

    const confirm = annotationInteractionReducer(selectionState, annotationInteractionActions.openFollowUpFromSelection())
    const cancelled = annotationInteractionReducer(confirm, annotationInteractionActions.cancelFollowUp())

    expect(cancelled.pendingSelection?.selectedText).toBe('pending')
    expect(cancelled.selectionMenuView).toBe('compact')
    expect(cancelled.activeAnnotationDetail).toBeNull()
    expect(cancelled.followUpDraft).toBe('')
  })
})
