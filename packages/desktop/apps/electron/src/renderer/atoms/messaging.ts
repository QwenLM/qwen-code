/**
 * Messaging Gateway Atoms
 *
 * Workspace-level state for messaging bindings.
 * Populated by subscribing to messaging:bindingChanged push events.
 */

import { atom } from 'jotai'

export interface MessagingBinding {
  id: string
  workspaceId: string
  sessionId: string
  platform: string
  channelId: string
  channelName?: string
  enabled: boolean
  createdAt: number
}

export const messagingBindingsAtom = atom<MessagingBinding[]>([])

export const messagingBindingsBySessionAtom = atom((get) => {
  const map = new Map<string, MessagingBinding[]>()
  for (const binding of get(messagingBindingsAtom)) {
    if (!binding.enabled) continue
    const list = map.get(binding.sessionId)
    if (list) {
      list.push(binding)
    } else {
      map.set(binding.sessionId, [binding])
    }
  }
  return map
})

export const setMessagingBindingsAtom = atom(
  null,
  (_get, set, bindings: MessagingBinding[]) => {
    set(messagingBindingsAtom, bindings.filter((binding) => binding.enabled))
  },
)

/**
 * Global messaging dialog state.
 *
 * Hoisted out of SessionMenu so dialogs survive context-menu / dropdown close.
 * Rendered by <MessagingDialogHost /> mounted at AppShell level.
 */
export type MessagingDialogState =
  | { kind: 'closed' }
  | {
      kind: 'pairing'
      platform: 'telegram' | 'whatsapp'
      sessionId: string
      code: string | null
      expiresAt: number | null
      botUsername?: string
      error?: string
    }
  | {
      kind: 'wa_connect'
      continueToPairingSessionId?: string
    }

export const messagingDialogAtom = atom<MessagingDialogState>({ kind: 'closed' })
