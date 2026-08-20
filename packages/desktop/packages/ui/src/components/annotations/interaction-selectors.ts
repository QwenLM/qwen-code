import type { AnnotationInteractionState } from './interaction-state-machine'

export function getAnnotationInteractionSourceKey(state: AnnotationInteractionState, messageId?: string): string {
  const messageScope = messageId ?? 'no-message'

  if (state.pendingSelection) {
    return `selection:${messageScope}:${state.pendingSelection.start}:${state.pendingSelection.end}`
  }

  if (state.activeAnnotationDetail) {
    return `annotation:${messageScope}:${state.activeAnnotationDetail.annotationId}`
  }

  return `none:${messageScope}`
}

export function getAnnotationInteractionAnchor(state: AnnotationInteractionState): { x: number; y: number } | null {
  return state.selectionMenuAnchor
}

export function hasAnnotationInteraction(state: AnnotationInteractionState): boolean {
  return Boolean(state.pendingSelection || state.activeAnnotationDetail)
}
