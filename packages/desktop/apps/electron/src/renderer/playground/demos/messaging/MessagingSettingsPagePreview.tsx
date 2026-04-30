/**
 * MessagingSettingsPagePreview
 *
 * Thin playground wrapper around the real MessagingSettingsPage that drives
 * the mock messaging state via `window.__playgroundMessaging` based on
 * variant props. Lets you toggle Telegram/WhatsApp connection status and
 * seed bindings without the component needing playground-specific props.
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import MessagingSettingsPage from '../../../pages/settings/MessagingSettingsPage'
import { setMessagingBindingsAtom, type MessagingBinding } from '../../../atoms/messaging'
import { sessionMetaMapAtom, type SessionMeta } from '../../../atoms/sessions'
import { playgroundMessagingHandle } from '../../mock-utils'

type BindingsPreset = 'none' | 'one' | 'many'

const PLAYGROUND_WORKSPACE_ID = 'playground-workspace'

function buildBindings(preset: BindingsPreset): MessagingBinding[] {
  const base = {
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    enabled: true,
    createdAt: Date.now(),
  }
  switch (preset) {
    case 'none':
      return []
    case 'one':
      return [
        {
          ...base,
          id: 'binding-1',
          sessionId: 'session-aaa',
          platform: 'telegram',
          channelId: '123456',
          channelName: 'Gyula (DM)',
        },
      ]
    case 'many':
      return [
        {
          ...base,
          id: 'binding-1',
          sessionId: 'session-aaa',
          platform: 'telegram',
          channelId: '123456',
          channelName: 'Gyula (DM)',
        },
        {
          ...base,
          id: 'binding-2',
          sessionId: 'session-bbb',
          platform: 'whatsapp',
          channelId: '36201234567@s.whatsapp.net',
          channelName: 'Standup Bot',
          createdAt: Date.now() - 86_400_000,
        },
        {
          ...base,
          id: 'binding-3',
          sessionId: 'session-ccc',
          platform: 'telegram',
          channelId: '-10098765',
          channelName: 'Team Inbox',
          createdAt: Date.now() - 2 * 86_400_000,
        },
      ]
  }
}

/**
 * Mock SessionMeta entries matching the mock bindings so `getSessionTitle`
 * resolves to a real-looking title in the playground (instead of the
 * sessionId-slice fallback).
 */
const MOCK_SESSION_META: Record<string, SessionMeta> = {
  'session-aaa': {
    id: 'session-aaa',
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    name: 'Gyula DM — Telegram chat',
  },
  'session-bbb': {
    id: 'session-bbb',
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    name: 'Standup Bot — WhatsApp workflow',
  },
  'session-ccc': {
    id: 'session-ccc',
    workspaceId: PLAYGROUND_WORKSPACE_ID,
    name: 'Team Inbox — Telegram group',
  },
}

export interface MessagingSettingsPagePreviewProps {
  telegramConnected: boolean
  whatsappConnected: boolean
  bindings: BindingsPreset
}

export function MessagingSettingsPagePreview({
  telegramConnected,
  whatsappConnected,
  bindings,
}: MessagingSettingsPagePreviewProps) {
  const setBindingsAtom = useSetAtom(setMessagingBindingsAtom)
  const setSessionMetaMap = useSetAtom(sessionMetaMapAtom)

  // Seed session metadata once so `getSessionTitle` resolves to a real name
  // for the mock bindings. Runs on mount; cleared on unmount to avoid leaking
  // fake sessions into other playground demos.
  React.useEffect(() => {
    setSessionMetaMap((prev) => {
      const next = new Map(prev)
      for (const meta of Object.values(MOCK_SESSION_META)) next.set(meta.id, meta)
      return next
    })
    return () => {
      setSessionMetaMap((prev) => {
        const next = new Map(prev)
        for (const id of Object.keys(MOCK_SESSION_META)) next.delete(id)
        return next
      })
    }
  }, [setSessionMetaMap])

  React.useEffect(() => {
    playgroundMessagingHandle.setTelegramConnected(
      telegramConnected,
      telegramConnected ? 'Playground Bot' : undefined,
    )
  }, [telegramConnected])

  React.useEffect(() => {
    playgroundMessagingHandle.setWhatsAppConnected(
      whatsappConnected,
      whatsappConnected ? 'Gyula' : undefined,
    )
  }, [whatsappConnected])

  React.useEffect(() => {
    const seeded = buildBindings(bindings)
    playgroundMessagingHandle.setBindings(seeded)
    // Also seed the atom directly so the first render of BindingsTable shows
    // the seeded rows even before the effect fires.
    setBindingsAtom(seeded)
  }, [bindings, setBindingsAtom])

  return <MessagingSettingsPage />
}
