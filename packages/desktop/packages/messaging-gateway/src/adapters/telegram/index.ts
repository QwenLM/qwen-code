/**
 * TelegramAdapter — in-process adapter using grammY.
 *
 * Phase 1: polling mode, text-only, DM-only.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Bot, InputFile, type Context } from 'grammy'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingAttachment,
  IncomingMessage,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
} from '../../types'
import { formatForTelegram } from './format'

/**
 * Hard cap for downloaded attachment size. Matches `MAX_FILE_SIZE` in
 * `@craft-agent/shared/utils/files` — files larger than this would be
 * rejected by `readFileAttachment` anyway, so we fail fast in the adapter
 * with a user-visible reply instead of silently dropping.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Minimal mime → extension fallback used when Telegram's `file_path` is
 * missing or extension-less. Kept intentionally small — anything unknown
 * becomes `.bin` and `readFileAttachment` will classify it as 'unknown'.
 */
const MIME_EXT_FALLBACK: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
}

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Race a promise against a timeout. If `ms` elapses before `p` settles, reject
 * with a labelled error. Used to surface grammY's silent-retry hangs on
 * `bot.init()` / `deleteWebhook()` as real, actionable errors.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[telegram] ${label} timed out after ${ms}ms`)),
      ms,
    )
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Unwrap an error for structured logging. grammY's HttpError wraps the real
 * fetch/undici cause in an `.error` field; electron-log's JSON serializer
 * otherwise sees an empty object because Error's own fields are non-enumerable.
 * Walks up to 3 levels of wrapping (HttpError -> cause -> cause).
 */
function describeError(err: unknown, depth = 0): Record<string, unknown> {
  if (depth > 3) return { truncated: true }
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    }
    const code = (err as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const grammyInner = (err as { error?: unknown }).error
    if (grammyInner !== undefined) out.error = describeError(grammyInner, depth + 1)
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = describeError(cause, depth + 1)
    if (err.stack) out.stack = err.stack.split('\n').slice(0, 4).join('\n')
    return out
  }
  if (err && typeof err === 'object') return { value: String(err), raw: err as object }
  return { value: String(err) }
}

/**
 * DM-only guard for Phase 1. Groups/supergroups/channels are ignored because
 * the current trust model treats `channelId` as the authorization boundary —
 * in a DM, the chat IS the authorized party. Opening to groups requires
 * per-sender authorization keyed by `(channelId, senderId)` everywhere
 * (bind, /pair consume, permission/plan callbacks), which doesn't exist yet.
 */
export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === 'private'
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: 10,
    maxMessageLength: 4096,
    markdown: 'v2',
    // This adapter uses polling (grammY Bot#start). A webhook path is not
    // wired through the Electron main process, so advertising webhookSupport
    // would mislead the headless server bootstrap. Keep false until a proper
    // webhook handler exists.
    webhookSupport: false,
  }

  /** Fetch bot profile (username, display name). Used for UI hints. */
  async getBotInfo(): Promise<{ id: number; username?: string; firstName?: string } | null> {
    if (!this.bot) return null
    try {
      const me = await this.bot.api.getMe()
      return { id: me.id, username: me.username, firstName: me.first_name }
    } catch {
      return null
    }
  }

  private bot: Bot | null = null
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private connected = false
  private log: MessagingLogger = NOOP_LOGGER

  /**
   * Emit one structured log line per dropped non-private update. Deliberately
   * `info` (not `debug`) so a user who notices "bot isn't responding in my
   * group" can confirm via logs without toggling levels.
   */
  private logNonPrivateDropped(handler: string, ctx: Context): void {
    this.log.info('[telegram] ignored non-private chat update', {
      event: 'telegram_non_private_dropped',
      handler,
      chatType: ctx.chat?.type,
      chatId: ctx.chat?.id,
    })
  }

  async initialize(config: PlatformConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Telegram bot token is required')
    }

    this.log = config.logger ?? NOOP_LOGGER
    this.bot = new Bot(config.token)

    // Handle incoming text messages
    this.bot.on('message:text', async (ctx: Context) => {
      if (!this.messageHandler || !ctx.message || !ctx.chat) return
      if (!isPrivateChat(ctx)) {
        this.logNonPrivateDropped('message:text', ctx)
        return
      }

      const msg: IncomingMessage = {
        platform: 'telegram',
        channelId: String(ctx.chat.id),
        messageId: String(ctx.message.message_id),
        senderId: String(ctx.from?.id ?? ''),
        senderName: ctx.from?.first_name ?? undefined,
        text: ctx.message.text ?? '',
        timestamp: ctx.message.date * 1000,
        raw: ctx.message,
      }

      await this.messageHandler(msg)
    })

    // Attachment handlers — photos, documents, voice, video, audio.
    // Each maps Telegram's source field onto a single helper that
    // downloads the blob to a temp file, then emits one IncomingMessage
    // with `attachments[0].localPath` set. The router resolves the path
    // via readFileAttachment() and forwards a FileAttachment to the session.
    this.bot.on('message:photo', async (ctx: Context) => {
      if (!isPrivateChat(ctx)) {
        this.logNonPrivateDropped('message:photo', ctx)
        return
      }
      const photos = ctx.message?.photo
      // Telegram returns multiple sizes; last one is the largest original.
      const largest = photos?.[photos.length - 1]
      if (!largest) return
      await this.emitAttachmentMessage(ctx, {
        type: 'photo',
        fileId: largest.file_id,
        fileSize: largest.file_size,
        mimeType: 'image/jpeg', // Telegram re-encodes photos to JPEG
      })
    })

    this.bot.on('message:document', async (ctx: Context) => {
      if (!isPrivateChat(ctx)) {
        this.logNonPrivateDropped('message:document', ctx)
        return
      }
      const doc = ctx.message?.document
      if (!doc) return
      await this.emitAttachmentMessage(ctx, {
        type: 'document',
        fileId: doc.file_id,
        fileName: doc.file_name,
        fileSize: doc.file_size,
        mimeType: doc.mime_type,
      })
    })

    this.bot.on('message:voice', async (ctx: Context) => {
      if (!isPrivateChat(ctx)) {
        this.logNonPrivateDropped('message:voice', ctx)
        return
      }
      const voice = ctx.message?.voice
      if (!voice) return
      await this.emitAttachmentMessage(ctx, {
        type: 'voice',
        fileId: voice.file_id,
        fileSize: voice.file_size,
        mimeType: voice.mime_type ?? 'audio/ogg',
      })
    })

    this.bot.on('message:video', async (ctx: Context) => {
      if (!isPrivateChat(ctx)) {
        this.logNonPrivateDropped('message:video', ctx)
        return
      }
      const video = ctx.message?.video
      if (!video) return
      await this.emitAttachmentMessage(ctx, {
        type: 'video',
        fileId: video.file_id,
        fileName: video.file_name,
        fileSize: video.file_size,
        mimeType: video.mime_type ?? 'video/mp4',
      })
    })

    this.bot.on('message:audio', async (ctx: Context) => {
      if (!isPrivateChat(ctx)) {
        this.logNonPrivateDropped('message:audio', ctx)
        return
      }
      const audio = ctx.message?.audio
      if (!audio) return
      await this.emitAttachmentMessage(ctx, {
        type: 'audio',
        fileId: audio.file_id,
        fileName: audio.file_name,
        fileSize: audio.file_size,
        mimeType: audio.mime_type ?? 'audio/mpeg',
      })
    })

    // Handle callback queries (button presses)
    this.bot.on('callback_query:data', async (ctx: Context) => {
      if (!this.buttonHandler || !ctx.callbackQuery) return
      if (!isPrivateChat(ctx)) {
        this.logNonPrivateDropped('callback_query:data', ctx)
        // Answer the callback so Telegram stops showing the spinner, but
        // don't route it — same rationale as message handlers.
        await ctx.answerCallbackQuery().catch(() => {})
        return
      }

      await ctx.answerCallbackQuery().catch(() => {})

      const press: ButtonPress = {
        platform: 'telegram',
        channelId: String(ctx.chat?.id ?? ''),
        messageId: String(ctx.callbackQuery.message?.message_id ?? ''),
        senderId: String(ctx.from?.id ?? ''),
        buttonId: ctx.callbackQuery.data ?? '',
        data: ctx.callbackQuery.data ?? undefined,
      }

      await this.buttonHandler(press)
    })

    this.log.info('[telegram] initializing')

    // Clear any pre-existing webhook BEFORE bot.init(). grammY's Api client
    // works without init() (which only caches getMe), and if a webhook is set
    // (by a previous app run, another app, or BotFather), getUpdates returns
    // nothing and polling silently receives no messages. Doing this first
    // means even a slow/stuck init() can't prevent webhook cleanup.
    // drop_pending_updates=false preserves messages queued before the user
    // saved the token.
    try {
      await withTimeout(
        this.bot.api.deleteWebhook({ drop_pending_updates: false }),
        10_000,
        'deleteWebhook',
      )
      this.log.info('[telegram] deleteWebhook ok')
    } catch (err) {
      this.log.warn('[telegram] deleteWebhook failed (non-fatal):', describeError(err))
    }

    // Surface token/network errors up-front (getMe). Without the timeout,
    // grammY retries transient errors indefinitely with no logs, which looks
    // identical to a deadlock from the outside.
    try {
      await withTimeout(this.bot.init(), 10_000, 'bot.init')
      this.log.info('[telegram] bot.init ok', {
        username: this.bot.botInfo?.username,
      })
    } catch (err) {
      this.log.error('[telegram] bot.init failed:', describeError(err))
      throw err
    }

    // Launch polling in the background. grammY's bot.start() returns a
    // long-lived Promise that only resolves on stop() and rejects on fatal
    // polling errors (most commonly 409 Conflict from overlapping pollers
    // sharing the same token). We MUST catch it so the rejection doesn't
    // become an unhandled promise and so `connected` reflects reality.
    this.bot.start({
      onStart: () => {
        this.connected = true
        this.log.info('[telegram] polling started')
        // Diagnostic: confirm webhook is really gone + show backlog once.
        // Fire-and-forget; errors here are not fatal to polling.
        this.bot?.api.getWebhookInfo().then(
          (info) => this.log.info('[telegram] webhook state after start:', {
            url: info.url || null,
            pending_update_count: info.pending_update_count,
          }),
          () => {},
        )
      },
    }).catch((err: unknown) => {
      this.connected = false
      this.log.error('[telegram] polling stopped with error:', describeError(err))
    })
    // Do NOT set this.connected = true here — wait for onStart.
  }

  /**
   * Download a Telegram file to a temp path and invoke the message handler
   * with the resulting IncomingMessage. Centralised here so the five
   * `bot.on(...)` handlers only need to pick the right source fields.
   *
   * Failures (oversize, 404, network) are reported back to the sender via
   * `ctx.reply()` and logged. The message is NOT forwarded in that case —
   * the session should not be woken for an attachment we couldn't deliver.
   */
  private async emitAttachmentMessage(
    ctx: Context,
    meta: {
      type: IncomingAttachment['type']
      fileId: string
      fileName?: string
      fileSize?: number
      mimeType?: string
    },
  ): Promise<void> {
    if (!this.messageHandler || !ctx.message || !ctx.chat || !this.bot) return

    // Size guard BEFORE hitting the file API — avoids the round-trip when
    // Telegram already told us the size up-front.
    if (meta.fileSize !== undefined && meta.fileSize > MAX_ATTACHMENT_BYTES) {
      this.log.warn('[telegram] attachment too large, dropping', {
        type: meta.type,
        fileSize: meta.fileSize,
      })
      await ctx.reply(
        `Attachment too large (>${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB). Not forwarded.`,
      ).catch(() => {})
      return
    }

    let downloaded: { localPath: string; fileName: string; fileSize: number }
    try {
      downloaded = await this.downloadToTemp(
        meta.fileId,
        meta.fileName ?? `${meta.type}-${Date.now()}`,
        meta.mimeType,
      )
    } catch (err) {
      this.log.error('[telegram] attachment download failed:', describeError(err))
      await ctx.reply(
        'Failed to download your attachment. Please try again.',
      ).catch(() => {})
      return
    }

    const attachment: IncomingAttachment = {
      type: meta.type,
      fileId: meta.fileId,
      fileName: downloaded.fileName,
      mimeType: meta.mimeType,
      fileSize: downloaded.fileSize,
      localPath: downloaded.localPath,
    }

    const msg: IncomingMessage = {
      platform: 'telegram',
      channelId: String(ctx.chat.id),
      messageId: String(ctx.message.message_id),
      senderId: String(ctx.from?.id ?? ''),
      senderName: ctx.from?.first_name ?? undefined,
      text: ctx.message.caption ?? '',
      attachments: [attachment],
      timestamp: ctx.message.date * 1000,
      raw: ctx.message,
    }

    await this.messageHandler(msg)
  }

  /**
   * Resolve a Telegram `file_id` to a local path by calling `getFile()` to
   * obtain the remote path, then fetching the blob from the Bot API file
   * host and writing it to the OS temp dir. Enforces `MAX_ATTACHMENT_BYTES`
   * against the actual downloaded size in case `getFile` reported no size.
   */
  private async downloadToTemp(
    fileId: string,
    fallbackName: string,
    mimeType: string | undefined,
  ): Promise<{ localPath: string; fileName: string; fileSize: number }> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) {
      throw new Error(`getFile returned no file_path for ${fileId}`)
    }
    if (file.file_size !== undefined && file.file_size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${file.file_size} bytes`)
    }

    // Extension: prefer whatever Telegram's file_path carries (it's normally
    // `photos/file_123.jpg` or similar), fall back to mime map, else `.bin`.
    let ext = extname(file.file_path)
    if (!ext && mimeType && MIME_EXT_FALLBACK[mimeType]) {
      ext = MIME_EXT_FALLBACK[mimeType]
    }
    if (!ext) ext = '.bin'

    // Normalise fileName — ensure it has the resolved extension so
    // readFileAttachment's extension-based type detection works.
    let fileName = fallbackName
    if (!extname(fileName)) fileName = `${fileName}${ext}`

    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large after download: ${buf.byteLength} bytes`)
    }

    const localPath = join(
      tmpdir(),
      `craft-agent-messaging-${randomBytes(8).toString('hex')}${ext}`,
    )
    writeFileSync(localPath, buf)
    return { localPath, fileName, fileSize: buf.byteLength }
  }

  async destroy(): Promise<void> {
    this.connected = false
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onButtonPress(handler: (press: ButtonPress) => Promise<void>): void {
    this.buttonHandler = handler
  }

  async sendText(channelId: string, text: string): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = formatForTelegram(text)
    const sent = await this.bot.api.sendMessage(Number(channelId), formatted)
    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')
    const formatted = formatForTelegram(text)
    await this.bot.api.editMessageText(Number(channelId), Number(messageId), formatted)
  }

  async sendButtons(channelId: string, text: string, buttons: InlineButton[]): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const keyboard = {
      inline_keyboard: buttons.map((b) => [{
        text: b.label,
        callback_data: b.id,
      }]),
    }

    const sent = await this.bot.api.sendMessage(Number(channelId), text, {
      reply_markup: keyboard,
    })

    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.bot) return
    await this.bot.api.sendChatAction(Number(channelId), 'typing').catch(() => {})
  }

  async sendFile(channelId: string, file: Buffer, filename: string, caption?: string): Promise<SentMessage> {
    if (!this.bot) throw new Error('Telegram adapter not initialized')

    const inputFile = new InputFile(file, filename)
    const sent = await this.bot.api.sendDocument(Number(channelId), inputFile, { caption })

    return {
      platform: 'telegram',
      channelId,
      messageId: String(sent.message_id),
    }
  }

  async clearButtons(channelId: string, messageId: string): Promise<void> {
    if (!this.bot) return
    try {
      await this.bot.api.editMessageReplyMarkup(Number(channelId), Number(messageId), {
        reply_markup: { inline_keyboard: [] },
      })
    } catch {
      // Non-fatal: message may have been deleted by the user or already cleared.
    }
  }
}
