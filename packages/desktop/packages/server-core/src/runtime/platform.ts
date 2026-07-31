/**
 * Platform services — dependency injection seam.
 *
 * SessionManager and core handlers receive this instead of importing
 * directly from 'electron'. On Electron, the implementations wrap
 * app/shell/nativeImage. On headless Node, they use sharp/pino/etc.
 */

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export interface ImageProcessor {
  /** Get image dimensions. Returns null if buffer is not a valid image. */
  getMetadata(buffer: Buffer): Promise<{ width: number; height: number } | null>

  /**
   * Process an image: resize and/or re-encode.
   * @param input - Buffer or file path
   * @param opts.resize - target dimensions (default: no resize)
   * @param opts.fit - 'inside' to maintain aspect ratio (default: 'inside')
   * @param opts.format - output format (default: 'png')
   * @param opts.quality - JPEG quality 0-100 (default: 90)
   */
  process(
    input: Buffer | string,
    opts?: {
      resize?: { width: number; height: number }
      fit?: 'inside' | 'cover' | 'fill'
      format?: 'png' | 'jpeg'
      quality?: number
    },
  ): Promise<Buffer>
}

export interface PlatformServices {
  // -- Path resolution --
  appRootPath: string
  resourcesPath: string
  isPackaged: boolean

  // -- App metadata --
  appVersion: string

  // -- Image processing (nativeImage on Electron, sharp on headless) --
  imageProcessor: ImageProcessor

  // -- OS integration (no-ops on headless) --
  openPath?(path: string): Promise<void>
  openExternal?(url: string): Promise<void>
  showItemInFolder?(path: string): void

  // -- App lifecycle (no-ops on headless) --
  quit?(): void
  systemDarkMode?(): boolean

  // -- Observability --
  logger: Logger
  isDebugMode: boolean
  getLogFilePath?(): string | undefined
  captureError?(error: Error): void
}

// ── Logger helpers ──────────────────────────────────────────────────────────

const ANSI_RESET = '\x1b[0m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_YELLOW = '\x1b[33m'
const ANSI_RED = '\x1b[31m'
const ANSI_MAGENTA = '\x1b[35m'

type TtyLikeStream = { isTTY?: boolean }

function shouldColor(stream?: TtyLikeStream): boolean {
  if (typeof process === 'undefined') return false
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true
  return stream?.isTTY === true
}

function levelColor(level: keyof Logger): string {
  switch (level) {
    case 'error':
      return ANSI_RED
    case 'warn':
      return ANSI_YELLOW
    case 'debug':
      return ANSI_MAGENTA
    case 'info':
    default:
      return ANSI_GREEN
  }
}

function colorizeArgs(level: keyof Logger, args: unknown[], stream?: TtyLikeStream): unknown[] {
  if (!shouldColor(stream)) return args
  const color = levelColor(level)
  return args.map((arg) => typeof arg === 'string' ? `${color}${arg}${ANSI_RESET}` : arg)
}

function stdout(): TtyLikeStream | undefined {
  return typeof process === 'undefined' ? undefined : process.stdout
}

function stderr(): TtyLikeStream | undefined {
  return typeof process === 'undefined' ? undefined : process.stderr
}

/** Console-based Logger for use before platform initialization. */
export const CONSOLE_LOGGER: Logger = {
  info: (...args: unknown[]) => console.log(...colorizeArgs('info', args, stdout())),
  warn: (...args: unknown[]) => console.warn(...colorizeArgs('warn', args, stderr())),
  error: (...args: unknown[]) => console.error(...colorizeArgs('error', args, stderr())),
  debug: (...args: unknown[]) => console.debug(...colorizeArgs('debug', args, stderr())),
}

/** Create a Logger that prefixes every message with [scope]. */
export function createScopedLogger(base: Logger, scope: string): Logger {
  return {
    info: (...args: unknown[]) => base.info(`[${scope}]`, ...args),
    warn: (...args: unknown[]) => base.warn(`[${scope}]`, ...args),
    error: (...args: unknown[]) => base.error(`[${scope}]`, ...args),
    debug: (...args: unknown[]) => base.debug(`[${scope}]`, ...args),
  }
}
