import { atom } from 'jotai'
import type { ContentBadge, CreateSessionOptions } from '../../shared/types'

export const NEW_SESSION_DRAFT_ID = '__new_session_draft__'

export interface NewSessionDraftState {
  nonce: number
  input: string
  createOptions: CreateSessionOptions
  badges?: ContentBadge[]
}

export const newSessionDraftAtom = atom<NewSessionDraftState>({
  nonce: 0,
  input: '',
  createOptions: {},
})
