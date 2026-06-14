import { describe, test, expect } from 'bun:test'
import {
  bareJid,
  classifyInbound,
  extractText,
  rememberSentId,
  MAX_SENT_IDS,
  type ClassifyContext,
} from '../filter'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SELF_BARE = '3612345678@s.whatsapp.net'
const SELF_WITH_DEVICE = '3612345678:10@s.whatsapp.net'
const SELF_LID = '176278359535753@lid'
const SELF_LID_WITH_DEVICE = '176278359535753:10@lid'
const OTHER = '4412345678@s.whatsapp.net'

function ctx(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    selfChatMode: true,
    responsePrefix: '🤖',
    selfJid: SELF_BARE,
    selfLid: null,
    sentIds: new Set<string>(),
    ...overrides,
  }
}

function makeMsg(opts: {
  id?: string
  jid?: string
  fromMe?: boolean
  text?: string
  caption?: string
  captionField?: 'imageMessage' | 'documentMessage' | 'videoMessage'
}): Record<string, unknown> {
  const key = {
    id: opts.id ?? 'MID1',
    remoteJid: opts.jid ?? OTHER,
    fromMe: opts.fromMe ?? false,
  }
  const message: Record<string, unknown> = {}
  if (opts.text !== undefined) message.conversation = opts.text
  if (opts.caption !== undefined) {
    const field = opts.captionField ?? 'imageMessage'
    message[field] = { caption: opts.caption }
  }
  return {
    key,
    message,
    messageTimestamp: 1_700_000_000,
    pushName: 'tester',
  }
}

// ---------------------------------------------------------------------------
// bareJid
// ---------------------------------------------------------------------------

describe('bareJid', () => {
  test('returns null for nullish', () => {
    expect(bareJid(null)).toBeNull()
    expect(bareJid(undefined)).toBeNull()
  })

  test('passes through bare JID unchanged', () => {
    expect(bareJid(SELF_BARE)).toBe(SELF_BARE)
  })

  test('strips the :device suffix', () => {
    expect(bareJid(SELF_WITH_DEVICE)).toBe(SELF_BARE)
  })

  test('returns input unchanged when no @', () => {
    expect(bareJid('malformed')).toBe('malformed')
  })
})

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------

describe('extractText', () => {
  test('reads plain conversation', () => {
    expect(extractText(makeMsg({ text: 'hello' }))).toBe('hello')
  })

  test('reads extendedTextMessage.text', () => {
    const msg = {
      key: { id: 'x', remoteJid: OTHER, fromMe: false },
      message: { extendedTextMessage: { text: 'quoted reply' } },
    }
    expect(extractText(msg)).toBe('quoted reply')
  })

  test('reads image caption', () => {
    expect(
      extractText(
        makeMsg({ caption: 'look at this', captionField: 'imageMessage' }),
      ),
    ).toBe('look at this')
  })

  test('returns empty string for message objects without text', () => {
    const msg = { key: { id: 'x', remoteJid: OTHER, fromMe: false }, message: {} }
    expect(extractText(msg)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// classifyInbound
// ---------------------------------------------------------------------------

describe('classifyInbound — fromMe=false in selfChatMode (gated)', () => {
  test('drops contact DM when selfChatMode is on and chat is not self-chat', () => {
    const d = classifyInbound(makeMsg({ text: 'hi', jid: OTHER }), ctx())
    expect(d).toEqual({ action: 'skip', reason: 'non_self_chat_inbound' })
  })

  test('drops group message (group JID is not self-chat)', () => {
    const d = classifyInbound(
      makeMsg({ text: 'hi all', jid: '1203630012345@g.us' }),
      ctx(),
    )
    expect(d).toEqual({ action: 'skip', reason: 'non_self_chat_inbound' })
  })

  test('skips malformed messages missing the key', () => {
    const d = classifyInbound({}, ctx())
    expect(d).toEqual({ action: 'skip', reason: 'malformed' })
  })
})

describe('classifyInbound — fromMe=true echo filtering', () => {
  test('skips when id is in sentIds (primary echo defence)', () => {
    const sentIds = new Set(['MID-echo'])
    const d = classifyInbound(
      makeMsg({ id: 'MID-echo', jid: SELF_BARE, fromMe: true, text: 'plain' }),
      ctx({ sentIds }),
    )
    expect(d).toEqual({ action: 'skip', reason: 'own_echo_id' })
  })

  test('skips prefix-matching text in self-chat (backup defence)', () => {
    const d = classifyInbound(
      makeMsg({
        jid: SELF_BARE,
        fromMe: true,
        text: '🤖 boot complete',
      }),
      ctx(),
    )
    expect(d).toEqual({ action: 'skip', reason: 'own_echo_prefix' })
  })

  test('emits plain fromMe message in the self-chat', () => {
    const d = classifyInbound(
      makeMsg({ jid: SELF_BARE, fromMe: true, text: 'hello me' }),
      ctx(),
    )
    expect(d).toEqual({ action: 'emit', text: 'hello me' })
  })

  test('matches self-chat even when remoteJid carries a device suffix', () => {
    const d = classifyInbound(
      makeMsg({ jid: SELF_WITH_DEVICE, fromMe: true, text: 'hi' }),
      ctx(),
    )
    expect(d).toEqual({ action: 'emit', text: 'hi' })
  })
})

describe('classifyInbound — fromMe=true in LID-form self-chat', () => {
  test('emits when remoteJid matches selfLid (bare @lid)', () => {
    const d = classifyInbound(
      makeMsg({ jid: SELF_LID, fromMe: true, text: 'hello me via LID' }),
      ctx({ selfLid: SELF_LID }),
    )
    expect(d).toEqual({ action: 'emit', text: 'hello me via LID' })
  })

  test('matches selfLid even when remoteJid carries a device suffix', () => {
    const d = classifyInbound(
      makeMsg({ jid: SELF_LID_WITH_DEVICE, fromMe: true, text: 'hi' }),
      ctx({ selfLid: SELF_LID }),
    )
    expect(d).toEqual({ action: 'emit', text: 'hi' })
  })

  test('does not match LID remoteJid when selfLid is null', () => {
    const d = classifyInbound(
      makeMsg({ jid: SELF_LID, fromMe: true, text: 'hello me via LID' }),
      ctx({ selfLid: null }),
    )
    expect(d).toEqual({ action: 'skip', reason: 'own_outbound' })
  })

  test('matches when the account has both JID and LID and remote is LID', () => {
    const d = classifyInbound(
      makeMsg({ jid: SELF_LID, fromMe: true, text: 'hi' }),
      ctx({ selfJid: SELF_BARE, selfLid: SELF_LID }),
    )
    expect(d).toEqual({ action: 'emit', text: 'hi' })
  })
})

describe('classifyInbound — fromMe=true in non-self chats', () => {
  test('drops user-sent outbound to a contact', () => {
    const d = classifyInbound(
      makeMsg({ jid: OTHER, fromMe: true, text: 'replying to friend' }),
      ctx(),
    )
    expect(d).toEqual({ action: 'skip', reason: 'own_outbound' })
  })
})

describe('classifyInbound — selfChatMode disabled (back-compat)', () => {
  test('drops even self-JID fromMe traffic', () => {
    const d = classifyInbound(
      makeMsg({ jid: SELF_BARE, fromMe: true, text: 'hello me' }),
      ctx({ selfChatMode: false }),
    )
    expect(d).toEqual({ action: 'skip', reason: 'own_outbound' })
  })

  test('accepts normal incoming from contacts when selfChatMode is off', () => {
    const d = classifyInbound(
      makeMsg({ jid: OTHER, text: 'hi from contact' }),
      ctx({ selfChatMode: false }),
    )
    expect(d).toEqual({ action: 'emit', text: 'hi from contact' })
  })

  test('still drops empty contact messages when selfChatMode is off', () => {
    const d = classifyInbound(
      makeMsg({ jid: OTHER }),
      ctx({ selfChatMode: false }),
    )
    expect(d).toEqual({ action: 'skip', reason: 'empty' })
  })
})

// ---------------------------------------------------------------------------
// rememberSentId
// ---------------------------------------------------------------------------

describe('rememberSentId', () => {
  test('adds ids and allows lookup', () => {
    const s = new Set<string>()
    rememberSentId(s, 'a')
    rememberSentId(s, 'b')
    expect(s.has('a')).toBe(true)
    expect(s.has('b')).toBe(true)
  })

  test('evicts the oldest entry when it exceeds MAX_SENT_IDS', () => {
    const s = new Set<string>()
    for (let i = 0; i < MAX_SENT_IDS; i++) rememberSentId(s, `id-${i}`)
    expect(s.size).toBe(MAX_SENT_IDS)
    expect(s.has('id-0')).toBe(true)

    rememberSentId(s, 'overflow')
    expect(s.size).toBe(MAX_SENT_IDS)
    expect(s.has('id-0')).toBe(false)
    expect(s.has('overflow')).toBe(true)
  })
})
