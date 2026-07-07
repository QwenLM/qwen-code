// Check CRAFT_DEBUG env var at module load (for SDK subprocess)
// Guard against browser/renderer contexts where process is undefined
let debugEnabled = typeof process !== 'undefined' && process.env?.CRAFT_DEBUG === '1';

function isCliJsonOnlyMode(): boolean {
  return typeof process !== 'undefined' && process.env?.CRAFT_CLI_JSON_ONLY === '1';
}

/**
 * Runtime environment detection
 */
type Environment = 'electron-main' | 'electron-renderer' | 'cli';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ANSI_RESET = '\x1b[0m';
const ANSI_DIM = '\x1b[2m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_RED = '\x1b[31m';
const ANSI_MAGENTA = '\x1b[35m';

function detectEnvironment(): Environment {
  // No process object means we're in a browser/renderer context
  if (typeof process === 'undefined') {
    return 'electron-renderer';
  }
  // Electron main process
  if ((process as any).type === 'browser') {
    return 'electron-main';
  }
  // Electron renderer process (with nodeIntegration)
  if ((process as any).type === 'renderer') {
    return 'electron-renderer';
  }
  // Default: CLI/scripts
  return 'cli';
}

let electronLog: unknown | null = null;
let electronLogChecked = false;

function getElectronLog(): { info?: (message: string) => void } | null {
  if (electronLogChecked) {
    return (electronLog as { info?: (message: string) => void } | null) ?? null;
  }
  electronLogChecked = true;
  try {
    // Optional dependency - only available in Electron main process.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require('electron-log/main');
    electronLog = loaded?.default ?? loaded ?? null;
  } catch {
    electronLog = null;
  }
  return (electronLog as { info?: (message: string) => void } | null) ?? null;
}

/**
 * Enable debug logging. Call this when --debug flag is passed.
 */
export function enableDebug(): void {
  debugEnabled = true;
}

/**
 * Check if debug mode is enabled.
 */
export function isDebugEnabled(): boolean {
  if (isCliJsonOnlyMode()) return false;
  return debugEnabled;
}

/**
 * Safely stringify an object, handling circular references.
 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    // Handle circular references by using a replacer that tracks seen objects
    const seen = new WeakSet();
    return JSON.stringify(obj, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  }
}

function shouldColorDebugOutput(): boolean {
  if (typeof process === 'undefined') return false;
  if (detectEnvironment() === 'electron-renderer') return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return process.stderr?.isTTY === true;
}

function colorize(value: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${value}${ANSI_RESET}` : value;
}

function colorizeLevel(level: LogLevel, levelStr: string, enabled: boolean): string {
  switch (level) {
    case 'error':
      return colorize(levelStr, ANSI_RED, enabled);
    case 'warn':
      return colorize(levelStr, ANSI_YELLOW, enabled);
    case 'debug':
      return colorize(levelStr, ANSI_MAGENTA, enabled);
    case 'info':
    default:
      return colorize(levelStr, ANSI_GREEN, enabled);
  }
}

/**
 * Format a log message with timestamp and optional scope.
 */
function formatMessage(
  scope: string | undefined,
  message: string,
  args: unknown[],
  options?: { color?: boolean; level?: LogLevel; date?: Date },
): string {
  const useColor = options?.color === true && shouldColorDebugOutput();
  const timestamp = colorize((options?.date ?? new Date()).toISOString(), ANSI_DIM, useColor);
  const scopeStr = scope ? `${colorize(`[${scope}]`, ANSI_CYAN, useColor)} ` : '';
  const messageStr = options?.level
    ? `${colorizeLevel(options.level, options.level.toUpperCase().padEnd(5), useColor)} ${message}`
    : colorize(message, ANSI_MAGENTA, useColor);
  const argsStr = args.length > 0
    ? ' ' + args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ')
    : '';
  return `${timestamp} ${scopeStr}${messageStr}${argsStr}\n`;
}

/**
 * Output log based on environment.
 *
 * All environments output to console.error (or console.log for renderer).
 * In Electron main process, logs also go to electron-log via the main process logger.
 */
function output(formatted: string, consoleFormatted = formatted): void {
  const env = detectEnvironment();

  // Mirror debug logs into electron-log when available so they appear in main.log.
  if (env === 'electron-main') {
    const log = getElectronLog();
    log?.info?.(formatted.trim());
  }

  if (env === 'electron-renderer') {
    // Use console.log in renderer for DevTools
    console.log(consoleFormatted.trim());
  } else if (typeof process !== 'undefined' && process.stderr) {
    // Use stderr in main/cli to avoid stdout interference
    process.stderr.write(consoleFormatted);
  } else {
    // Fallback to console for unexpected environments
    console.log(consoleFormatted.trim());
  }
}

/**
 * Debug logging utility that auto-routes based on environment.
 * Only logs when debug mode is enabled via --debug flag.
 *
 * Output routing:
 * - Electron main: console + file
 * - Electron renderer: console (DevTools)
 * - CLI/scripts: console only
 *
 * @example
 * debug('Processing request')
 * debug('User data', { id: 123 })
 */
export function debug(message: string, ...args: unknown[]): void {
  if (!isDebugEnabled()) return;
  const date = new Date();
  output(
    formatMessage(undefined, message, args, { date }),
    formatMessage(undefined, message, args, { color: true, date }),
  );
}

/**
 * Create a scoped logger for a specific module.
 * Scope appears in brackets: [scope] message
 *
 * @example
 * const log = createLogger('agent');
 * log.debug('Starting session');
 * log.info('Connected to MCP');
 * log.error('Failed to connect', error);
 */
export function createLogger(scope: string) {
  const logWithLevel = (level: LogLevel, message: string, args: unknown[]) => {
    if (!isDebugEnabled()) return;
    const date = new Date();
    output(
      formatMessage(scope, message, args, { date, level }),
      formatMessage(scope, message, args, { color: true, date, level }),
    );
  };

  return {
    debug: (message: string, ...args: unknown[]) => logWithLevel('debug', message, args),
    info: (message: string, ...args: unknown[]) => logWithLevel('info', message, args),
    warn: (message: string, ...args: unknown[]) => logWithLevel('warn', message, args),
    error: (message: string, ...args: unknown[]) => logWithLevel('error', message, args),
  };
}
