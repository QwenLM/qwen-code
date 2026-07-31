/**
 * IPC protocol between the main process (WhatsAppAdapter) and the
 * whatsapp worker subprocess.
 *
 * Transport: newline-delimited JSON (NDJSON) over the worker's stdin/stdout.
 * - Main → Worker: one WorkerCommand per line (stdin).
 * - Worker → Main: one WorkerEvent per line (stdout).
 * - Worker stderr is reserved for free-form logs (not parsed).
 *
 * The protocol is intentionally small — the worker owns all Baileys state;
 * the main process only drives lifecycle and relays incoming/outgoing messages.
 */

// ---------------------------------------------------------------------------
// Commands (main → worker)
// ---------------------------------------------------------------------------

export type WorkerCommand =
  | StartCommand
  | SubmitPairingPhoneCommand
  | SendTextCommand
  | SendFileCommand
  | ShutdownCommand

export interface StartCommand {
  type: 'start'
  /** Absolute path for persisted Baileys multi-file auth state. */
  authStateDir: string
  /** Optional: use pairing-code mode instead of QR mode. */
  pairingMode?: 'qr' | 'code'
  /**
   * When true, messages sent from OTHER devices on this account to the
   * self-JID (user's own number) are treated as incoming user input.
   * Defaults to `false` (preserves the original behaviour of dropping all
   * `fromMe` traffic).
   *
   * The worker filters its own echoes two ways: by tracking the IDs it
   * sent and by checking for the `responsePrefix` in the message text.
   */
  selfChatMode?: boolean
  /**
   * Prefix prepended to outbound messages when self-chat mode is active and
   * the channel is the self-JID. Serves as a visual distinction in the
   * self-chat AND a robust echo filter for cases where the worker restart
   * wiped the sent-ID tracking set. Defaults to 🤖 when
   * self-chat is on. Empty/missing → fall back to default.
   */
  responsePrefix?: string
}

export interface SubmitPairingPhoneCommand {
  type: 'submit_pairing_phone'
  /** E.164 format, digits only (Baileys accepts the number without '+'). */
  phoneNumber: string
}

export interface SendTextCommand {
  id: string
  type: 'send_text'
  channelId: string
  text: string
}

export interface SendFileCommand {
  id: string
  type: 'send_file'
  channelId: string
  /** Base64-encoded file bytes. */
  dataBase64: string
  filename: string
  caption?: string
  mimeType?: string
}

export interface ShutdownCommand {
  type: 'shutdown'
}

// ---------------------------------------------------------------------------
// Events (worker → main)
// ---------------------------------------------------------------------------

export type WorkerEvent =
  | ReadyEvent
  | QrEvent
  | PairingCodeEvent
  | ConnectedEvent
  | DisconnectedEvent
  | IncomingEvent
  | SendResultEvent
  | ErrorEvent
  | UnavailableEvent

export interface ReadyEvent {
  type: 'ready'
  /** Baileys version reported by the worker, informational. */
  baileysVersion?: string
  /** ISO timestamp the worker bundle was produced. Informational. */
  buildId?: string
  /** Short git SHA (or `unknown`/`dev-unbundled`) the bundle was built from. */
  gitSha?: string
}

export interface QrEvent {
  type: 'qr'
  /** The raw QR string as emitted by Baileys (encode to QR code on the UI side). */
  qr: string
}

export interface PairingCodeEvent {
  type: 'pairing_code'
  code: string
}

export interface ConnectedEvent {
  type: 'connected'
  jid?: string
  name?: string
}

export interface DisconnectedEvent {
  type: 'disconnected'
  /** `true` when the session was lost permanently (logged out, banned). */
  loggedOut: boolean
  reason?: string
}

export interface IncomingEvent {
  type: 'incoming'
  channelId: string
  messageId: string
  senderId: string
  senderName?: string
  text: string
  timestamp: number
}

export interface SendResultEvent {
  type: 'send_result'
  /** Correlates with SendTextCommand/SendFileCommand `id`. */
  id: string
  ok: boolean
  messageId?: string
  error?: string
}

export interface ErrorEvent {
  type: 'error'
  /** Non-fatal — the worker is still running. */
  message: string
}

export interface UnavailableEvent {
  type: 'unavailable'
  /**
   * Fatal error — worker can't proceed (either startup or post-connect).
   *
   * `reason`:
   * - `baileys_load_failed`   — bundled Baileys threw during init (rare)
   * - `auth_state_error`      — failed to read/write auth state dir
   * - `reconnect_exhausted`   — repeated non-logout closes hit the retry cap
   * - `unknown`               — check `message`
   */
  reason: 'baileys_load_failed' | 'auth_state_error' | 'reconnect_exhausted' | 'unknown'
  message: string
}

// ---------------------------------------------------------------------------
// NDJSON helpers
// ---------------------------------------------------------------------------

export function encodeMessage(msg: WorkerCommand | WorkerEvent): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Parse a newline-delimited JSON stream incrementally. Returns parsed
 * messages and the residual unparsed tail for the next chunk.
 */
export function parseFrames<T>(buffer: string): { messages: T[]; rest: string } {
  const messages: T[] = []
  let rest = buffer
  while (true) {
    const nl = rest.indexOf('\n')
    if (nl === -1) break
    const line = rest.slice(0, nl).trim()
    rest = rest.slice(nl + 1)
    if (!line) continue
    try {
      messages.push(JSON.parse(line) as T)
    } catch {
      // Skip malformed lines — worker stderr leakage is already filtered,
      // but be defensive so a single bad line doesn't kill the stream.
    }
  }
  return { messages, rest }
}
