import type { TextAnnotationSelection } from './annotation-core'

export type AnnotationIslandView = 'compact' | 'confirm-follow-up'
export type AnnotationIslandMode = 'edit' | 'view'

export type AnchoredSelection = TextAnnotationSelection & {
  anchorX: number
  anchorY: number
}

export type ActiveAnnotationDetail = {
  annotationId: string
  index: number
  anchorX: number
  anchorY: number
}

export type AnnotationInteractionState = {
  pendingSelection: AnchoredSelection | null
  activeAnnotationDetail: ActiveAnnotationDetail | null
  selectionMenuView: AnnotationIslandView
  followUpMode: AnnotationIslandMode
  followUpDraft: string
  selectionMenuAnchor: { x: number; y: number } | null
}

export const initialAnnotationInteractionState: AnnotationInteractionState = {
  pendingSelection: null,
  activeAnnotationDetail: null,
  selectionMenuView: 'compact',
  followUpMode: 'edit',
  followUpDraft: '',
  selectionMenuAnchor: null,
}

type AnnotationInteractionAction =
  | { type: 'SET_DRAFT'; draft: string }
  | { type: 'OPEN_FROM_SELECTION'; selection: AnchoredSelection }
  | { type: 'OPEN_FOLLOW_UP_FROM_SELECTION' }
  | { type: 'OPEN_FROM_ANNOTATION'; detail: ActiveAnnotationDetail; noteText: string; mode: AnnotationIslandMode }
  | { type: 'REQUEST_EDIT' }
  | { type: 'CANCEL_FOLLOW_UP' }
  | { type: 'SUBMIT_SUCCESS' }
  | { type: 'DELETE_SUCCESS' }
  | { type: 'CLOSE_ALL' }

export function annotationInteractionReducer(
  state: AnnotationInteractionState,
  action: AnnotationInteractionAction,
): AnnotationInteractionState {
  switch (action.type) {
    case 'SET_DRAFT':
      return {
        ...state,
        followUpDraft: action.draft,
      }

    case 'OPEN_FROM_SELECTION':
      return {
        pendingSelection: action.selection,
        activeAnnotationDetail: null,
        selectionMenuView: 'compact',
        followUpMode: 'edit',
        followUpDraft: '',
        selectionMenuAnchor: { x: action.selection.anchorX, y: action.selection.anchorY },
      }

    case 'OPEN_FOLLOW_UP_FROM_SELECTION':
      if (!state.pendingSelection) return state
      return {
        ...state,
        selectionMenuView: 'confirm-follow-up',
        followUpMode: 'edit',
      }

    case 'OPEN_FROM_ANNOTATION':
      return {
        pendingSelection: null,
        activeAnnotationDetail: action.detail,
        selectionMenuView: 'confirm-follow-up',
        followUpMode: action.mode,
        followUpDraft: action.noteText,
        selectionMenuAnchor: { x: action.detail.anchorX, y: action.detail.anchorY },
      }

    case 'REQUEST_EDIT':
      return {
        ...state,
        followUpMode: 'edit',
      }

    case 'CANCEL_FOLLOW_UP': {
      if (state.pendingSelection) {
        return {
          ...state,
          selectionMenuView: 'compact',
          followUpMode: 'edit',
          followUpDraft: '',
          activeAnnotationDetail: null,
          selectionMenuAnchor: { x: state.pendingSelection.anchorX, y: state.pendingSelection.anchorY },
        }
      }

      return {
        ...initialAnnotationInteractionState,
      }
    }

    case 'SUBMIT_SUCCESS':
    case 'DELETE_SUCCESS':
    case 'CLOSE_ALL':
      return {
        ...initialAnnotationInteractionState,
      }

    default:
      return state
  }
}

export const annotationInteractionActions = {
  setDraft: (draft: string): AnnotationInteractionAction => ({ type: 'SET_DRAFT', draft }),
  openFromSelection: (selection: AnchoredSelection): AnnotationInteractionAction => ({ type: 'OPEN_FROM_SELECTION', selection }),
  openFollowUpFromSelection: (): AnnotationInteractionAction => ({ type: 'OPEN_FOLLOW_UP_FROM_SELECTION' }),
  openFromAnnotation: (detail: ActiveAnnotationDetail, noteText: string, mode: AnnotationIslandMode): AnnotationInteractionAction => ({
    type: 'OPEN_FROM_ANNOTATION',
    detail,
    noteText,
    mode,
  }),
  requestEdit: (): AnnotationInteractionAction => ({ type: 'REQUEST_EDIT' }),
  cancelFollowUp: (): AnnotationInteractionAction => ({ type: 'CANCEL_FOLLOW_UP' }),
  submitSuccess: (): AnnotationInteractionAction => ({ type: 'SUBMIT_SUCCESS' }),
  deleteSuccess: (): AnnotationInteractionAction => ({ type: 'DELETE_SUCCESS' }),
  closeAll: (): AnnotationInteractionAction => ({ type: 'CLOSE_ALL' }),
}
