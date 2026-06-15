import log from 'electron-log/main'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  MessagingLogContext,
  MessagingLogMeta,
  MessagingLogger,
} from '@craft-agent/messaging-gateway'

const ANSI_RESET = '\x1b[0m'
const ANSI_DIM = '\x1b[2m'
const ANSI_CYAN = '\x1b[36m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_YELLOW = '\x1b[33m'
const ANSI_RED = '\x1b[31m'
const ANSI_MAGENTA = '\x1b[35m'

function shouldColorConsole(): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true
  return process.stdout.isTTY === true || process.stderr.isTTY === true
}

const colorConsole = shouldColorConsole()

function colorize(value: string, color: string): string {
  return colorConsole ? `${color}${value}${ANSI_RESET}` : value
}

function colorizeLevel(level: string): string {
  switch (level.trim().toLowerCase()) {
    case 'error':
      return colorize(level, ANSI_RED)
    case 'warn':
      return colorize(level, ANSI_YELLOW)
    case 'debug':
      return colorize(level, ANSI_MAGENTA)
    case 'info':
      return colorize(level, ANSI_GREEN)
    default:
      return colorize(level, ANSI_CYAN)
  }
}

/**
 * Resolve debug mode deterministically across runtimes.
 *
 * Priority:
 * 1) --debug flag always enables debug mode
 * 2) CRAFT_IS_PACKAGED env (when explicitly set)
 * 3) Electron runtime heuristic (defaultApp => dev, otherwise packaged)
 * 4) Non-Electron runtimes default to debug mode (headless Bun / node --check)
 */
function resolveDebugMode(): boolean {
  if (process.argv.includes('--debug')) return true

  const packagedEnv = process.env.CRAFT_IS_PACKAGED
  if (packagedEnv === 'true') return false
  if (packagedEnv === 'false') return true

  const isElectronRuntime = typeof process.versions?.electron === 'string'
  if (isElectronRuntime) {
    if (process.defaultApp) return true
    return false
  }

  return true
}

export const isDebugMode = resolveDebugMode()

// Always keep a local file log for support/debugging. Capture every
// electron-log level so packaged builds retain the same diagnostic detail as
// dev/debug runs.
log.transports.file.format = ({ message }) => [
  JSON.stringify({
    timestamp: message.date.toISOString(),
    level: message.level,
    scope: message.scope,
    message: message.data,
  }),
]
log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB
log.transports.file.level = 'silly'

// Console output is useful in dev/debug mode. Packaged production keeps the
// terminal clean and relies on the file log above.
if (isDebugMode) {
  // Note: format must return an array - electron-log's transformStyles calls .reduce() on it
  log.transports.console.format = ({ message }) => {
    const timestamp = colorize(message.date.toISOString(), ANSI_DIM)
    const scope = message.scope ? colorize(`[${message.scope}]`, ANSI_CYAN) : ''
    const level = colorizeLevel(message.level.toUpperCase().padEnd(5))
    const data = message.data
      .map((d: unknown) => (typeof d === 'object' ? JSON.stringify(d) : String(d)))
      .join(' ')
    return [`${timestamp} ${level} ${scope} ${data}`]
  }
  log.transports.console.level = 'debug'
} else {
  log.transports.console.level = false
}

// Export scoped loggers for different modules
export const mainLog = log.scope('main')
export const sessionLog = log.scope('session')
export const handlerLog = log.scope('handler')
export const windowLog = log.scope('window')
export const agentLog = log.scope('agent')
export const searchLog = log.scope('search')

/**
 * Dedicated messaging gateway log.
 *
 * Kept outside the Electron-managed logs folder so messaging issues can be
 * inspected independently at a stable path across debug and production builds.
 */
export const messagingGatewayLogPath = join(homedir(), '.craft-agent', 'logs', 'messaging-gateway.log')
const messagingGatewayBackupPath = `${messagingGatewayLogPath}.1`
const MESSAGING_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5MB

function ensureMessagingLogDir(): void {
  mkdirSync(dirname(messagingGatewayLogPath), { recursive: true })
}

function rotateMessagingLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(messagingGatewayLogPath)) return
  try {
    const currentSize = statSync(messagingGatewayLogPath).size
    if (currentSize + nextLineBytes <= MESSAGING_LOG_MAX_BYTES) return
    if (existsSync(messagingGatewayBackupPath)) {
      rmSync(messagingGatewayBackupPath, { force: true })
    }
    renameSync(messagingGatewayLogPath, messagingGatewayBackupPath)
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to rotate dedicated log file', normalizeLogValue(error))
  }
}

function normalizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = normalizeLogValue(cause, depth + 1)
    if (value.stack) out.stack = value.stack
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeLogValue(inner, depth + 1)
    }
    return out
  }
  return value
}

function normalizeMeta(meta?: MessagingLogMeta): Record<string, unknown> {
  if (!meta) return {}
  const normalized = normalizeLogValue(meta)
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { meta: normalized }
}

function writeMessagingGatewayLog(
  level: 'info' | 'warn' | 'error',
  context: MessagingLogContext,
  message: string,
  meta?: MessagingLogMeta,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'messaging-gateway',
    ...context,
    ...normalizeMeta(meta),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  try {
    ensureMessagingLogDir()
    rotateMessagingLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(messagingGatewayLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[messaging-gateway] failed to write dedicated log entry', {
      error: normalizeLogValue(error),
      attemptedEntry: entry,
    })
  }

  if (level === 'error') {
    mainLog.error('[messaging-gateway]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[messaging-gateway]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[messaging-gateway]', message, entry)
  }
}

class StructuredMessagingGatewayLogger implements MessagingLogger {
  constructor(private readonly context: MessagingLogContext = {}) {}

  child(context: MessagingLogContext): MessagingLogger {
    return new StructuredMessagingGatewayLogger({
      ...this.context,
      ...context,
    })
  }

  info(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('info', this.context, message, meta)
  }

  warn(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('warn', this.context, message, meta)
  }

  error(message: string, meta?: MessagingLogMeta): void {
    writeMessagingGatewayLog('error', this.context, message, meta)
  }
}

export const messagingGatewayLog: MessagingLogger = new StructuredMessagingGatewayLogger({
  component: 'root',
})

/**
 * Get the path to the current Electron main log file.
 * Returns undefined if file logging is disabled.
 */
export function getLogFilePath(): string | undefined {
  return log.transports.file.getFile()?.path
}

export function getMessagingGatewayLogFilePath(): string {
  return messagingGatewayLogPath
}

export default log
