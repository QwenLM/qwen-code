export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  debug?: boolean;
  stderr?: (message: string) => void;
  logLevel?: LogLevel;
}

export interface ScopedLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class SdkLogger {
  private static config: LoggerConfig = {};
  private static effectiveLevel: LogLevel = 'error';

  static configure(config: LoggerConfig): void {
    this.config = config;
    this.effectiveLevel = this.determineLogLevel();
  }

  private static determineLogLevel(): LogLevel {
    if (this.config.logLevel) {
      return this.config.logLevel;
    }

    if (this.config.debug) {
      return 'debug';
    }

    const envLevel = process.env['DEBUG_QWEN_CODE_SDK_LEVEL'];
    if (envLevel && this.isValidLogLevel(envLevel)) {
      return envLevel as LogLevel;
    }

    if (process.env['DEBUG_QWEN_CODE_SDK']) {
      return 'debug';
    }

    return 'error';
  }

  private static isValidLogLevel(level: string): boolean {
    return ['debug', 'info', 'warn', 'error'].includes(level);
  }

  private static shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.effectiveLevel];
  }

  private static formatTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  private static formatMessage(
    level: LogLevel,
    scope: string,
    message: string,
    args: unknown[],
  ): string {
    const timestamp = this.formatTimestamp();
    const levelStr = `[${level.toUpperCase()}]`.padEnd(7);
    let fullMessage = `${timestamp} ${levelStr} [${scope}] ${message}`;

    if (args.length > 0) {
      const argsStr = args
        .map((arg) => {
          if (typeof arg === 'string') {
            return arg;
          }
          if (arg instanceof Error) {
            return arg.message;
          }
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(' ');
      fullMessage += ` ${argsStr}`;
    }

    return fullMessage;
  }

  private static log(
    level: LogLevel,
    scope: string,
    message: string,
    args: unknown[],
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const formattedMessage = this.formatMessage(level, scope, message, args);

    if (this.config.stderr) {
      this.config.stderr(formattedMessage);
    } else {
      if (level === 'warn' || level === 'error') {
        process.stderr.write(formattedMessage + '\n');
      } else {
        process.stdout.write(formattedMessage + '\n');
      }
    }
  }

  static createLogger(scope: string): ScopedLogger {
    return {
      debug: (message: string, ...args: unknown[]) => {
        this.log('debug', scope, message, args);
      },
      info: (message: string, ...args: unknown[]) => {
        this.log('info', scope, message, args);
      },
      warn: (message: string, ...args: unknown[]) => {
        this.log('warn', scope, message, args);
      },
      error: (message: string, ...args: unknown[]) => {
        this.log('error', scope, message, args);
      },
    };
  }

  static getEffectiveLevel(): LogLevel {
    return this.effectiveLevel;
  }
}
