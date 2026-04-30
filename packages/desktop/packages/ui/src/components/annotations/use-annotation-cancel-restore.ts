import * as React from 'react'
import type { AnchoredSelection } from './interaction-state-machine'
import { scheduleDomSelectionRestore } from './selection-restore'

export interface UseAnnotationCancelRestoreOptions<T extends HTMLElement> {
  contentRootRef: React.RefObject<T | null>
  cancelFollowUp: () => { pendingSelection: AnchoredSelection | null }
}

export function useAnnotationCancelRestore<T extends HTMLElement>({
  contentRootRef,
  cancelFollowUp,
}: UseAnnotationCancelRestoreOptions<T>) {
  return React.useCallback(() => {
    const { pendingSelection } = cancelFollowUp()
    scheduleDomSelectionRestore(contentRootRef as { current: HTMLElement | null }, pendingSelection)
  }, [cancelFollowUp, contentRootRef])
}
