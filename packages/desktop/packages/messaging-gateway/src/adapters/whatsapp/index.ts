/**
 * WhatsAppAdapter — out-of-process adapter that spawns the
 * `@craft-agent/messaging-whatsapp-worker` subprocess.
 *
 * WhatsApp has no official bot API usable by us. Baileys reimplements the
 * WA multi-device protocol — it runs in a child process so that:
 *   (a) a Baileys crash/segfault can't take down the Electron main process,
 *   (b) Baileys can run under Node even when the host runtime is Bun,
 *   (c) memory isolation: auth state, signal ratchets, etc.
 *
 * The worker contract is defined in @craft-agent/messaging-whatsapp-worker.
 * This adapter owns the process lifecycle + translates events to the
 * PlatformAdapter interface.
 *
 * Unofficial API disclaimer: Baileys is not endorsed by WhatsApp/Meta and
 * may stop working at any time. Account bans are possible.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import {
  encodeMessage,
  parseFrames,
  type WorkerCommand,
  type WorkerEvent,
} from '@craft-agent/messaging-whatsapp-worker'
import type {
  PlatformAdapter,
  PlatformConfig,
  AdapterCapabilities,
  IncomingMessage,
  SentMessage,
  InlineButton,
  ButtonPress,
  MessagingLogger,
} from '../../types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

/**
 * Hard ceiling for `sendText`/`sendFile` awaits. If the worker wedges
 * between command dispatch and `send_result` (Baileys deadlock, infinite
 * retry, stalled socket) we surface a real error to the caller instead
 * of letting the renderer's `text_complete` path hang indefinitely and
 * freeze the chat. Chosen to comfortably exceed the worst-case Baileys
 * round-trip on a slow network; shorter would starve legitimate sends.
 * Tests pass a much smaller value via `WhatsAppConfig.sendTimeoutMs`.
 */
const DEFAULT_SEND_TIMEOUT_MS = 30_000

type PendingEntry = {
  resolve: (r: { ok: boolean; messageId?: string; error?: string }) => void
  timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WhatsAppConfig extends PlatformConfig {
  /** Directory Baileys persists multi-file auth state into. Required. */
  authStateDir: string
  /** Absolute path to the worker entry script. Required. */
  workerEntry: string
  /** Node binary path. Defaults to 'node'. */
  nodeBin?: string
  /** Pairing flow: 'qr' (default) or 'code' (phone-number based 8-char code). */
  pairingMode?: 'qr' | 'code'
  /**
   * Accept messages sent from this account's other devices (phone/WA
   * Desktop/WA Web) in the self-chat. Agent echoes are filtered by
   * sent-ID tracking + the response prefix. See `WorkerCommand.StartCommand`
   * for mechanics.
   */
  selfChatMode?: boolean
  /** Prefix tagged onto outbound self-chat messages. Defaults to 🤖. */
  responsePrefix?: string
  /**
   * Override the default per-send timeout (30s). Used by tests; not
   * exposed through the registry or UI. Shorter values help surface
   * worker deadlocks faster but risk rejecting legitimate sends on
   * slow networks.
   */
  sendTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Event bus (adapter-level, surfaced via registry)
// ---------------------------------------------------------------------------

export type WhatsAppEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }

type EventHandler = (event: WhatsAppEvent) => void

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const
  readonly capabilities: AdapterCapabilities = {
    messageEditing: false,
    inlineButtons: false,
    maxButtons: 0,
    maxMessageLength: 4096,
    markdown: 'whatsapp',
    webhookSupport: false,
  }

  private proc: ChildProcess | null = null
  private stdoutBuffer = ''
  private connected = false
  private started = false
  private log: MessagingLogger = NOOP_LOGGER
  private messageHandler: ((msg: IncomingMessage) => Promise<void>) | null = null
  private buttonHandler: ((press: ButtonPress) => Promise<void>) | null = null
  private eventHandlers = new Set<EventHandler>()
  private pending = new Map<string, PendingEntry>()
  private nextCmdId = 1
  private sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS

  async initialize(config: PlatformConfig): Promise<void> {
    const cfg = config as WhatsAppConfig
    if (!cfg.workerEntry) throw new Error('WhatsApp: workerEntry path is required')
    if (!cfg.authStateDir) throw new Error('WhatsApp: authStateDir is required')

    if (this.proc) {
      throw new Error('WhatsApp adapter already initialized')
    }

    this.log = (cfg.logger ?? NOOP_LOGGER).child({
      component: 'whatsapp-adapter',
      platform: 'whatsapp',
    })

    if (cfg.sendTimeoutMs !== undefined && cfg.sendTimeoutMs > 0) {
      this.sendTimeoutMs = cfg.sendTimeoutMs
    }

    const nodeBin = cfg.nodeBin ?? process.execPath
    this.log.info('starting WhatsApp worker', {
      event: 'whatsapp_worker_starting',
      workerEntry: cfg.workerEntry,
      authStateDir: cfg.authStateDir,
      pairingMode: cfg.pairingMode ?? 'qr',
      nodeBin,
    })

    this.proc = spawn(nodeBin, [cfg.workerEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stdout?.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk
      const { messages, rest } = parseFrames<WorkerEvent>(this.stdoutBuffer)
      this.stdoutBuffer = rest
      for (const ev of messages) this.onWorkerEvent(ev)
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        this.log.warn('WhatsApp worker stderr', {
          event: 'whatsapp_worker_stderr',
          line,
        })
      }
    })

    this.proc.on('exit', (code, signal) => {
      this.connected = false
      this.started = false
      this.proc = null
      this.drainPending(
        `worker exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`,
      )
      this.log.warn('WhatsApp worker exited', {
        event: 'whatsapp_worker_exited',
        code,
        signal,
      })
      if (code !== 0) {
        this.fireEvent({
          type: 'error',
          message: `Worker exited with code ${code ?? 'null'}`,
        })
      }
    })

    const startCmd: WorkerCommand = {
      type: 'start',
      authStateDir: cfg.authStateDir,
      pairingMode: cfg.pairingMode ?? 'qr',
      selfChatMode: cfg.selfChatMode ?? false,
      responsePrefix: cfg.responsePrefix,
    }
    this.sendCommand(startCmd)
    this.started = true
  }

  async destroy(): Promise<void> {
    if (!this.proc) return
    this.log.info('shutting down WhatsApp worker', { event: 'whatsapp_worker_shutdown' })
    try {
      this.sendCommand({ type: 'shutdown' })
    } catch (err) {
      this.log.warn('failed to send shutdown to WhatsApp worker', {
        event: 'whatsapp_worker_shutdown_signal_failed',
        error: err,
      })
    }
    const proc = this.proc
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, 2000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    // Defensive: `proc.on('exit')` normally drains first, but if the exit
    // event is delayed or was set up after a race, the promise above can
    // resolve via the SIGKILL timer before `exit` fires. Drain again here
    // so no caller is left hanging.
    this.drainPending('adapter destroyed')
    this.proc = null
    this.started = false
    this.connected = false
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

  /** Subscribe to adapter-level events (QR, pairing code, unavailable, errors). */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** Submit a phone number to obtain an 8-char pairing code (pairingMode=code). */
  async requestPairingCode(phoneNumber: string): Promise<void> {
    if (!this.started) throw new Error('WhatsApp adapter not started')
    this.log.info('requesting WhatsApp pairing code', {
      event: 'whatsapp_pairing_code_requested',
    })
    this.sendCommand({ type: 'submit_pairing_phone', phoneNumber })
  }

  async sendText(channelId: string, text: string): Promise<SentMessage> {
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({ id, type: 'send_text', channelId, text })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'whatsapp',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {
    throw new Error('WhatsApp edit not supported in this adapter')
  }

  async sendButtons(
    channelId: string,
    text: string,
    buttons: InlineButton[],
  ): Promise<SentMessage> {
    const numbered = buttons
      .map((b, i) => `${i + 1}. ${b.label}`)
      .join('\n')
    const combined = numbered ? `${text}\n\n${numbered}` : text
    return this.sendText(channelId, combined)
  }

  async sendTyping(_channelId: string): Promise<void> {
    // No-op — omitting "typing" presence updates avoids an extra round-trip
    // through the worker; UX remains acceptable without it.
  }

  async sendFile(
    channelId: string,
    file: Buffer,
    filename: string,
    caption?: string,
  ): Promise<SentMessage> {
    const id = String(this.nextCmdId++)
    const result = await this.sendWithResult({
      id,
      type: 'send_file',
      channelId,
      dataBase64: file.toString('base64'),
      filename,
      caption,
    })
    if (!result.ok) throw new Error(result.error ?? 'Send failed')
    return {
      platform: 'whatsapp',
      channelId,
      messageId: result.messageId ?? id,
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sendCommand(cmd: WorkerCommand): void {
    if (!this.proc || !this.proc.stdin?.writable) {
      throw new Error('WhatsApp worker is not running')
    }
    this.proc.stdin.write(encodeMessage(cmd))
  }

  private sendWithResult(
    cmd: Extract<WorkerCommand, { id: string }>,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // `delete` returns false if `send_result` already arrived and cleared
        // the entry; in that race we've already resolved and must not do it
        // again.
        if (this.pending.delete(cmd.id)) {
          this.log.warn('WhatsApp send timed out', {
            event: 'whatsapp_send_timeout',
            commandId: cmd.id,
            commandType: cmd.type,
            timeoutMs: this.sendTimeoutMs,
          })
          resolve({ ok: false, error: `send timed out after ${this.sendTimeoutMs}ms` })
        }
      }, this.sendTimeoutMs)
      this.pending.set(cmd.id, { resolve, timer })
      try {
        this.sendCommand(cmd)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(cmd.id)
        this.log.error('failed to send command to WhatsApp worker', {
          event: 'whatsapp_worker_command_failed',
          commandType: cmd.type,
          error: err,
        })
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  /**
   * Resolve all pending sends with a failure. Called from `proc.on('exit')`
   * (worker crashed/quit) and from `destroy()` (orderly shutdown) so callers
   * never hang waiting for a worker that will never respond.
   */
  private drainPending(reason: string): void {
    if (this.pending.size === 0) return
    this.log.warn('draining pending WhatsApp sends', {
      event: 'whatsapp_pending_drain',
      count: this.pending.size,
      reason,
    })
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({ ok: false, error: reason })
    }
    this.pending.clear()
  }

  private fireEvent(event: WhatsAppEvent): void {
    for (const h of this.eventHandlers) {
      try {
        h(event)
      } catch {
        // isolate handler errors
      }
    }
  }

  private onWorkerEvent(ev: WorkerEvent): void {
    switch (ev.type) {
      case 'ready':
        this.log.info('WhatsApp worker ready', {
          event: 'whatsapp_worker_ready',
          baileysVersion: ev.baileysVersion,
          buildId: ev.buildId,
          gitSha: ev.gitSha,
        })
        return
      case 'qr':
        this.log.info('WhatsApp QR received', { event: 'whatsapp_qr_received' })
        this.fireEvent({ type: 'qr', qr: ev.qr })
        return
      case 'pairing_code':
        this.log.info('WhatsApp pairing code received', { event: 'whatsapp_pairing_code_received' })
        this.fireEvent({ type: 'pairing_code', code: ev.code })
        return
      case 'connected':
        this.connected = true
        this.log.info('WhatsApp connected', {
          event: 'whatsapp_connected',
          jid: ev.jid,
          name: ev.name,
        })
        this.fireEvent({ type: 'connected', jid: ev.jid, name: ev.name })
        return
      case 'disconnected':
        this.connected = false
        this.log.warn('WhatsApp disconnected', {
          event: 'whatsapp_disconnected',
          loggedOut: ev.loggedOut,
          reason: ev.reason,
        })
        this.fireEvent({ type: 'disconnected', loggedOut: ev.loggedOut, reason: ev.reason })
        return
      case 'incoming':
        if (this.messageHandler) {
          const msg: IncomingMessage = {
            platform: 'whatsapp',
            channelId: ev.channelId,
            messageId: ev.messageId,
            senderId: ev.senderId,
            senderName: ev.senderName,
            text: ev.text,
            timestamp: ev.timestamp,
            raw: ev,
          }
          void this.messageHandler(msg)
        }
        return
      case 'send_result': {
        const entry = this.pending.get(ev.id)
        if (entry) {
          clearTimeout(entry.timer)
          this.pending.delete(ev.id)
          entry.resolve({ ok: ev.ok, messageId: ev.messageId, error: ev.error })
        }
        if (!ev.ok) {
          this.log.error('WhatsApp send failed', {
            event: 'whatsapp_send_failed',
            commandId: ev.id,
            error: ev.error,
          })
        }
        return
      }
      case 'error':
        this.log.error('WhatsApp worker reported error', {
          event: 'whatsapp_worker_error',
          error: ev.message,
        })
        this.fireEvent({ type: 'error', message: ev.message })
        return
      case 'unavailable':
        this.log.error('WhatsApp unavailable', {
          event: 'whatsapp_unavailable',
          reason: ev.reason,
          error: ev.message,
        })
        this.fireEvent({ type: 'unavailable', reason: ev.reason, message: ev.message })
        return
    }
  }
}
