/**
 * Pure filter helpers used by the WA worker's `messages.upsert` handler.
 *
 * Extracted from `worker.ts` so the classification logic can be unit
 * tested without importing the worker entry (which installs stdin and
 * signal handlers on module load).
 */

/**
 * Normalize a Baileys JID so `sock.user.id` (which may carry a device
 * suffix like `num:10@s.whatsapp.net`) compares equal to the plain
 * `num@s.whatsapp.net` form used in `key.remoteJid` for the self-chat.
 */
export function bareJid(jid: string | undefined | null): string | null {
  if (!jid) return null
  const at = jid.indexOf('@')
  if (at === -1) return jid
  const localPart = jid.slice(0, at)
  const colon = localPart.indexOf(':')
  if (colon === -1) return jid
  return localPart.slice(0, colon) + jid.slice(at)
}

/**
 * Extract the visible text from a Baileys message. Covers the subset of
 * content types we care about: plain conversation, extended text,
 * captions on image/doc/video.
 */
export function extractText(msg: Record<string, unknown>): string {
  const m = msg.message as Record<string, unknown> | undefined
  if (!m) return ''
  const conv = m.conversation as string | undefined
  if (conv) return conv
  const ext = m.extendedTextMessage as Record<string, unknown> | undefined
  if (typeof ext?.text === 'string') return ext.text as string
  const img = m.imageMessage as Record<string, unknown> | undefined
  if (typeof img?.caption === 'string') return img.caption as string
  const doc = m.documentMessage as Record<string, unknown> | undefined
  if (typeof doc?.caption === 'string') return doc.caption as string
  const vid = m.videoMessage as Record<string, unknown> | undefined
  if (typeof vid?.caption === 'string') return vid.caption as string
  return ''
}

export interface ClassifyContext {
  selfChatMode: boolean
  responsePrefix: string
  /** Bare phone-number JID of the account (no device suffix), e.g. `num@s.whatsapp.net`. */
  selfJid: string | null
  /**
   * Bare LID form of the account (no device suffix), e.g. `lid@lid`.
   * WhatsApp's newer clients may deliver the self-chat `key.remoteJid`
   * in LID form even when `sock.user.id` is still the phone-number JID,
   * so the self-chat check must accept either.
   */
  selfLid: string | null
  sentIds: Set<string>
}

export type InboundDecision =
  | { action: 'emit'; text: string }
  | {
      action: 'skip'
      reason:
        | 'malformed'
        | 'own_echo_id'
        | 'own_echo_prefix'
        | 'own_outbound'
        | 'non_self_chat_inbound'
        | 'empty'
    }

/**
 * True when `remoteJid` is the account's self-chat (compared against the
 * phone-number JID and the LID form, both stripped of device suffix).
 */
function isSelfChatJid(
  remoteJid: string,
  selfJid: string | null,
  selfLid: string | null,
): boolean {
  const bareRemote = bareJid(remoteJid)
  if (bareRemote === null) return false
  if (selfJid !== null && bareRemote === selfJid) return true
  if (selfLid !== null && bareRemote === selfLid) return true
  return false
}

/**
 * Decide what to do with a single upsert message.
 *
 * Semantics of `selfChatMode`: "only operate in the account's self-chat."
 * Both directions are gated symmetrically — outbound from other devices AND
 * inbound from contacts are dropped when they are not in the self-chat.
 *
 * Precedence for `fromMe=true`:
 *   1. id in sentIds         → skip (our own echo, primary defence)
 *   2. not self-chat          → skip (user's outbound in normal chats)
 *   3. prefix match           → skip (echo backup defence)
 *   4. empty                  → skip
 *   5. otherwise              → emit (phone/desktop typing in self-chat)
 *
 * For `fromMe=false`:
 *   1. selfChatMode on AND not self-chat → skip (contacts/groups DMing us)
 *   2. empty                              → skip
 *   3. otherwise                          → emit
 */
export function classifyInbound(
  msg: Record<string, unknown>,
  ctx: ClassifyContext,
): InboundDecision {
  const key = msg.key as { remoteJid?: string; fromMe?: boolean; id?: string } | undefined
  if (!key || !key.remoteJid || !key.id) return { action: 'skip', reason: 'malformed' }

  const text = extractText(msg)
  const inSelfChat = isSelfChatJid(key.remoteJid, ctx.selfJid, ctx.selfLid)

  if (key.fromMe) {
    if (ctx.sentIds.has(key.id)) return { action: 'skip', reason: 'own_echo_id' }

    if (!ctx.selfChatMode || !inSelfChat) return { action: 'skip', reason: 'own_outbound' }

    if (ctx.responsePrefix && text.startsWith(ctx.responsePrefix)) {
      return { action: 'skip', reason: 'own_echo_prefix' }
    }

    if (!text) return { action: 'skip', reason: 'empty' }
    return { action: 'emit', text }
  }

  if (ctx.selfChatMode && !inSelfChat) {
    return { action: 'skip', reason: 'non_self_chat_inbound' }
  }

  if (!text) return { action: 'skip', reason: 'empty' }
  return { action: 'emit', text }
}

/** Cap the sent-ID set so long-running sessions don't leak memory. */
export const MAX_SENT_IDS = 500

/**
 * Insert `id` into the bounded sent-ID set. `Set` preserves insertion order
 * so the oldest entry is `values().next().value` — evict it when we
 * overflow.
 */
export function rememberSentId(sentIds: Set<string>, id: string): void {
  sentIds.add(id)
  if (sentIds.size > MAX_SENT_IDS) {
    const oldest = sentIds.values().next().value
    if (oldest !== undefined) sentIds.delete(oldest)
  }
}
