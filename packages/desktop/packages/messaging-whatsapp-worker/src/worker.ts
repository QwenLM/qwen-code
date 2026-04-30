/**
 * WhatsApp worker subprocess entry.
 *
 * Owns all Baileys state. Communicates with the main process over
 * newline-delimited JSON on stdin/stdout (see protocol.ts).
 *
 * Baileys is bundled into worker.cjs by esbuild at build time, so the
 * dynamic import below always resolves. The try/catch stays as a runtime
 * safety net — e.g. if a future Baileys version throws during module init
 * on an unsupported Node runtime we want a clean `unavailable` event
 * instead of a subprocess crash.
 *
 * Runs under Node (not Bun) when packaged with Electron so Baileys'
 * crypto deps (libsignal, curve25519) resolve correctly.
 */

import { mkdirSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import {
  encodeMessage,
  parseFrames,
  type WorkerCommand,
  type WorkerEvent,
} from './protocol'
import { bareJid, classifyInbound, rememberSentId } from './filter'

/**
 * Build-time constants injected by `scripts/build-wa-worker.ts`
 * via esbuild `--define`. At dev-time (no bundle) they fall back to the
 * `dev-*` values so typechecking and ad-hoc runs still work.
 */
declare const __WA_WORKER_BUILD_ID__: string
declare const __WA_WORKER_GIT_SHA__: string
const WORKER_BUILD_ID =
  typeof __WA_WORKER_BUILD_ID__ !== 'undefined' ? __WA_WORKER_BUILD_ID__ : 'dev-unbundled'
const WORKER_GIT_SHA =
  typeof __WA_WORKER_GIT_SHA__ !== 'undefined' ? __WA_WORKER_GIT_SHA__ : 'dev-unbundled'

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

function emit(event: WorkerEvent): void {
  process.stdout.write(encodeMessage(event))
}

function log(...args: unknown[]): void {
  // stderr is reserved for logs so the main process parser doesn't confuse them.
  process.stderr.write('[wa-worker] ' + args.map(String).join(' ') + '\n')
}

// ---------------------------------------------------------------------------
// Silent logger for Baileys
//
// Baileys uses pino and by default writes to stdout — which collides with our
// NDJSON protocol. This no-op logger implements the subset of the pino API
// that Baileys actually calls, keeping the protocol stream clean.
// ---------------------------------------------------------------------------

interface SilentLogger {
  level: string
  fatal: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
  child: () => SilentLogger
}

const silentLogger: SilentLogger = {
  level: 'silent',
  fatal: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => silentLogger,
}

// ---------------------------------------------------------------------------
// Baileys lifecycle (isolated — only referenced after dynamic import succeeds)
// ---------------------------------------------------------------------------

interface BaileysModule {
  /**
   * Factory exported as both `default` and `makeWASocket`. We prefer the
   * named export because CJS→ESM interop via esbuild's `await import()` does
   * not always expose `.default` as the callable function.
   */
  default?: (config: unknown) => unknown
  makeWASocket: (config: unknown) => unknown
  useMultiFileAuthState: (dir: string) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>
  DisconnectReason: Record<string, number>
  Browsers: { macOS: (name: string) => [string, string, string] }
  fetchLatestBaileysVersion: () => Promise<{ version: number[]; isLatest: boolean }>
}

type BaileysSock = {
  ev: {
    on(event: 'creds.update', fn: () => void): void
    on(event: 'connection.update', fn: (u: Record<string, unknown>) => void): void
    on(event: 'messages.upsert', fn: (u: { messages: unknown[]; type: string }) => void): void
  }
  user?: { id?: string; name?: string; lid?: string }
  requestPairingCode(phoneNumber: string): Promise<string>
  sendMessage(jid: string, content: unknown): Promise<{ key?: { id?: string } } | undefined>
  logout(): Promise<void>
  end(err?: Error): void
}

interface SessionState {
  baileys: BaileysModule
  sock: BaileysSock
  saveCreds: () => Promise<void>
  pairingMode: 'qr' | 'code'
  authStateDir: string
  /** Set when `shutdown` command arrives so any pending reconnect is cancelled. */
  shuttingDown: boolean
  /** Consecutive reconnect attempts; reset on successful `connection=open`. */
  reconnectAttempts: number
  /** Handle for a scheduled reconnect, so shutdown can clear it. */
  reconnectTimer: NodeJS.Timeout | null
  /** See `StartCommand.selfChatMode`. */
  selfChatMode: boolean
  /** Prefix prepended to outbound self-chat messages (non-empty). */
  responsePrefix: string
  /**
   * Bounded LRU of recently-sent message IDs. Used to filter the agent's
   * own echoes from `messages.upsert` — primary defence; the prefix check
   * is the backup for IDs lost across worker restarts.
   */
  sentIds: Set<string>
  /**
   * Unix seconds at which the socket most recently transitioned to
   * `connection: 'open'`. Used to skip history-sync messages that arrive
   * as `upsert.type === 'append'` right after connect — we only route
   * messages newer than this wall-clock cutoff (minus a small grace).
   */
  connectedAtSec: number
}

let session: SessionState | null = null

/** Cap retries so a permanently-broken credential set doesn't loop forever. */
const MAX_RECONNECT_ATTEMPTS = 10

/** Fallback prefix when selfChatMode is on but caller didn't specify one. */
const DEFAULT_RESPONSE_PREFIX = '🤖'

/**
 * Exponential backoff with a 30s ceiling: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
 * Called with attempts>=1.
 */
function reconnectDelayMs(attempts: number): number {
  const exp = Math.min(attempts - 1, 5)
  return Math.min(1_000 * 2 ** exp, 30_000)
}

/**
 * Prepend `responsePrefix` to `text` when `selfChatMode` is on AND the
 * target channel is the self-JID. Idempotent: if the text already starts
 * with the prefix (e.g. relay/edit paths that re-send), leave it alone.
 */
function applyPrefixIfSelfChat(state: SessionState, channelId: string, text: string): string {
  if (!state.selfChatMode) return text
  const selfJid = bareJid(state.sock.user?.id)
  const selfLid = bareJid(state.sock.user?.lid)
  const bareChannel = bareJid(channelId)
  if (!bareChannel) return text
  const isSelfChat =
    (selfJid !== null && bareChannel === selfJid) ||
    (selfLid !== null && bareChannel === selfLid)
  if (!isSelfChat) return text
  if (text.startsWith(state.responsePrefix)) return text
  return `${state.responsePrefix} ${text}`
}

async function loadBaileys(): Promise<BaileysModule | null> {
  try {
    // Baileys is bundled into worker.cjs at build time; the dynamic form
    // keeps this site isolated behind a try/catch for runtime init failures.
    const mod = (await import('@whiskeysockets/baileys')) as unknown as BaileysModule
    return mod
  } catch (err) {
    log('baileys load failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function startSession(
  authStateDir: string,
  pairingMode: 'qr' | 'code',
  selfChatMode: boolean,
  responsePrefix: string,
): Promise<void> {
  if (session) {
    emit({ type: 'error', message: 'Session already started' })
    return
  }
  // Build provenance — first line the main process sees on stderr so an
  // operator can confirm which bundle is actually running. Also included
  // in the `ready` event for structured logging.
  log(
    `starting — build=${WORKER_BUILD_ID} sha=${WORKER_GIT_SHA} selfChatMode=${selfChatMode} pairingMode=${pairingMode}`,
  )
  const baileys = await loadBaileys()
  if (!baileys) {
    emit({
      type: 'unavailable',
      reason: 'baileys_load_failed',
      message: 'WhatsApp library failed to initialize. Check the logs for details.',
    })
    process.exit(0)
  }

  try {
    mkdirSync(authStateDir, { recursive: true })
  } catch (err) {
    emit({
      type: 'unavailable',
      reason: 'auth_state_error',
      message: `Cannot create auth state dir: ${err instanceof Error ? err.message : String(err)}`,
    })
    process.exit(0)
  }

  const { state, saveCreds } = await baileys.useMultiFileAuthState(authStateDir)
  const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

  emit({
    type: 'ready',
    baileysVersion: version?.join('.'),
    buildId: WORKER_BUILD_ID,
    gitSha: WORKER_GIT_SHA,
  })

  const makeWASocket = baileys.makeWASocket ?? baileys.default
  if (typeof makeWASocket !== 'function') {
    emit({
      type: 'unavailable',
      reason: 'baileys_load_failed',
      message: 'Baileys export shape unexpected: makeWASocket not callable',
    })
    process.exit(0)
  }

  /**
   * Build a fresh Baileys socket bound to the persisted `state`. Called
   * once at startup and again on every non-loggedOut reconnect. `creds.update`
   * persistence keeps `state` current, so each new socket authenticates
   * against the latest credentials on disk.
   */
  const bootSock = (): BaileysSock => {
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: baileys.Browsers.macOS('Craft Agent'),
      version,
      logger: silentLogger,
    }) as BaileysSock

    sock.ev.on('creds.update', () => void saveCreds())

    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u as {
        connection?: string
        lastDisconnect?: { error?: { output?: { statusCode?: number } } }
        qr?: string
      }
      if (qr && pairingMode === 'qr') {
        emit({ type: 'qr', qr })
      }
      if (connection === 'open') {
        if (session) {
          session.reconnectAttempts = 0
          session.connectedAtSec = Math.floor(Date.now() / 1000)
        }
        emit({ type: 'connected', jid: sock.user?.id, name: sock.user?.name })
        return
      }
      if (connection !== 'close') return

      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === baileys.DisconnectReason.loggedOut
      emit({
        type: 'disconnected',
        loggedOut,
        reason: loggedOut ? 'Logged out' : `statusCode=${statusCode ?? 'unknown'}`,
      })

      if (loggedOut) {
        session = null
        process.exit(0)
        return
      }

      // Non-logout close — this includes Baileys' 515 "Stream Errored
      // (restart required)" emitted right after QR pairing, and any
      // transient network failure later on. Rebuild the socket with the
      // same persisted credentials. Honour shutdown, and cap retries
      // so a permanently-broken state doesn't loop forever.
      if (!session || session.shuttingDown) return

      session.reconnectAttempts++
      if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        emit({
          type: 'unavailable',
          reason: 'reconnect_exhausted',
          message: `WhatsApp reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts (last statusCode=${statusCode ?? 'unknown'})`,
        })
        session = null
        process.exit(0)
        return
      }

      const delay = reconnectDelayMs(session.reconnectAttempts)
      log(
        `reconnecting in ${delay}ms (attempt ${session.reconnectAttempts}, statusCode=${statusCode ?? 'unknown'})`,
      )
      session.reconnectTimer = setTimeout(() => {
        if (!session || session.shuttingDown) return
        session.reconnectTimer = null
        try {
          session.sock = bootSock()
        } catch (err) {
          log('bootSock threw during reconnect:', err instanceof Error ? err.message : String(err))
          // Let the next close event drive the backoff — or if the
          // throw is synchronous and terminal, the attempts cap will
          // stop the loop.
        }
      }, delay)
    })

    sock.ev.on('messages.upsert', (upsert) => {
      // Accept 'notify' (new inbound from other accounts) AND 'append'
      // (server sync — includes messages the user typed on another device
      // into the self-chat, which is how self-chat arrives on this linked
      // device). Reject unknown types (e.g. 'prepend' for pagination).
      if (upsert.type !== 'notify' && upsert.type !== 'append') return
      if (!session) return

      // Visible at debug-level so `upsert.type`/batch-size anomalies are
      // easy to spot in the main log when diagnosing routing issues.
      log(`upsert type=${upsert.type} count=${upsert.messages.length}`)

      // History-sync guard: Baileys re-emits old messages as 'append' on
      // every connect. Only route messages newer than the last open
      // timestamp, with a 5s grace for clock skew.
      const cutoff = session.connectedAtSec - 5
      const selfJid = bareJid(sock.user?.id)
      const selfLid = bareJid(sock.user?.lid)

      for (const msg of upsert.messages as Array<Record<string, unknown>>) {
        const ts = Number((msg as { messageTimestamp?: unknown }).messageTimestamp)
        if (Number.isFinite(ts) && ts > 0 && ts < cutoff) {
          log(`upsert skip: history (ts=${ts} cutoff=${cutoff})`)
          continue
        }

        // Debug context: surface the exact signals classifyInbound uses so
        // silent-skip cases ('own_outbound', 'empty') are visible.
        const dbgKey = (msg.key ?? {}) as {
          remoteJid?: string
          fromMe?: boolean
          id?: string
        }
        const msgKeys = msg.message
          ? Object.keys(msg.message as Record<string, unknown>).join(',')
          : '<no message>'
        log(
          `upsert msg fromMe=${!!dbgKey.fromMe} remoteJid=${dbgKey.remoteJid ?? '?'} ` +
            `selfJid=${selfJid ?? '?'} selfLid=${selfLid ?? '?'} ` +
            `bareRemote=${bareJid(dbgKey.remoteJid) ?? '?'} msgKeys=${msgKeys}`,
        )

        const decision = classifyInbound(msg, {
          selfChatMode: session.selfChatMode,
          responsePrefix: session.responsePrefix,
          selfJid,
          selfLid,
          sentIds: session.sentIds,
        })
        if (decision.action === 'skip') {
          log(`upsert skip: ${decision.reason}`)
          continue
        }
        const key = msg.key as { remoteJid?: string; id?: string }
        log(`upsert emit: channelId=${key.remoteJid} textLen=${decision.text.length}`)
        emit({
          type: 'incoming',
          channelId: key.remoteJid!,
          messageId: key.id!,
          senderId: key.remoteJid!,
          senderName: (msg.pushName as string | undefined) ?? undefined,
          text: decision.text,
          timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
        })
      }
    })

    return sock
  }

  const effectivePrefix =
    selfChatMode && responsePrefix.trim().length > 0 ? responsePrefix : DEFAULT_RESPONSE_PREFIX

  const sock = bootSock()
  session = {
    baileys,
    sock,
    saveCreds,
    pairingMode,
    authStateDir,
    shuttingDown: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    selfChatMode,
    responsePrefix: effectivePrefix,
    sentIds: new Set<string>(),
    connectedAtSec: 0,
  }
}

async function handleCommand(cmd: WorkerCommand): Promise<void> {
  switch (cmd.type) {
    case 'start': {
      await startSession(
        cmd.authStateDir,
        cmd.pairingMode ?? 'code',
        cmd.selfChatMode ?? false,
        cmd.responsePrefix ?? DEFAULT_RESPONSE_PREFIX,
      ).catch((err) => {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      })
      return
    }
    case 'submit_pairing_phone': {
      if (!session) {
        emit({ type: 'error', message: 'Not started' })
        return
      }
      try {
        const code = await session.sock.requestPairingCode(cmd.phoneNumber)
        emit({ type: 'pairing_code', code })
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    case 'send_text': {
      if (!session) {
        emit({ type: 'send_result', id: cmd.id, ok: false, error: 'Not connected' })
        return
      }
      try {
        const text = applyPrefixIfSelfChat(session, cmd.channelId, cmd.text)
        const res = await session.sock.sendMessage(cmd.channelId, { text })
        if (res?.key?.id) rememberSentId(session.sentIds, res.key.id)
        emit({ type: 'send_result', id: cmd.id, ok: true, messageId: res?.key?.id })
      } catch (err) {
        emit({
          type: 'send_result',
          id: cmd.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'send_file': {
      if (!session) {
        emit({ type: 'send_result', id: cmd.id, ok: false, error: 'Not connected' })
        return
      }
      try {
        const buf = Buffer.from(cmd.dataBase64, 'base64')
        const caption = cmd.caption !== undefined
          ? applyPrefixIfSelfChat(session, cmd.channelId, cmd.caption)
          : undefined
        const res = await session.sock.sendMessage(cmd.channelId, {
          document: buf,
          fileName: cmd.filename,
          mimetype: cmd.mimeType ?? 'application/octet-stream',
          caption,
        })
        if (res?.key?.id) rememberSentId(session.sentIds, res.key.id)
        emit({ type: 'send_result', id: cmd.id, ok: true, messageId: res?.key?.id })
      } catch (err) {
        emit({
          type: 'send_result',
          id: cmd.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return
    }
    case 'shutdown': {
      if (session) {
        session.shuttingDown = true
        if (session.reconnectTimer) {
          clearTimeout(session.reconnectTimer)
          session.reconnectTimer = null
        }
        try {
          session.sock.end()
        } catch {
          // ignore
        }
        session = null
      }
      process.exit(0)
      return
    }
  }
}

// ---------------------------------------------------------------------------
// stdin reader
// ---------------------------------------------------------------------------

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  const { messages, rest } = parseFrames<WorkerCommand>(stdinBuffer)
  stdinBuffer = rest
  for (const msg of messages) {
    void handleCommand(msg)
  }
})

process.stdin.on('end', () => {
  if (session) {
    session.shuttingDown = true
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer)
      session.reconnectTimer = null
    }
    try {
      session.sock.end()
    } catch {
      // ignore
    }
  }
  process.exit(0)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
