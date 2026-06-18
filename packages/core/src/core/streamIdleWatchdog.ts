import { createDebugLogger } from '../utils/debugLogger.js';
import { InvalidStreamError } from './geminiChat.js';

const debugLogger = createDebugLogger('QWEN_CODE_WATCHDOG');

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;
const STREAM_IDLE_WARNING_FRACTION = 0.5;

export type InvalidStreamErrorType =
  | 'NO_FINISH_REASON'
  | 'NO_RESPONSE_TEXT'
  | 'STREAM_IDLE_TIMEOUT';

export interface StreamIdleWatchdog {
  next<T>(nextPromise: Promise<IteratorResult<T>>): Promise<IteratorResult<T>>;
  cleanup(): void;
}

export function isStreamWatchdogDisabled(): boolean {
  const value = process.env['QWEN_CODE_DISABLE_STREAM_WATCHDOG'];
  return value === '1' || value === 'true';
}

export function getStreamIdleTimeoutMs(): number | undefined {
  if (isStreamWatchdogDisabled()) return undefined;
  const value = process.env['QWEN_CODE_STREAM_IDLE_TIMEOUT_MS'];
  if (!value) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    debugLogger.warn('Ignoring invalid STREAM_IDLE_TIMEOUT_MS: ' + value);
    return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

export function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) { controller.abort(signal.reason); return () => {}; }
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export function createStreamIdleWatchdog(
  model: string,
  abortController: AbortController,
): StreamIdleWatchdog | undefined {
  const timeoutMs = getStreamIdleTimeoutMs();
  if (timeoutMs === undefined) return undefined;
  const warningMs = Math.max(1, Math.floor(timeoutMs * STREAM_IDLE_WARNING_FRACTION));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let warningId: ReturnType<typeof setTimeout> | undefined;
  const clearTimers = () => {
    if (timeoutId !== undefined) { clearTimeout(timeoutId); timeoutId = undefined; }
    if (warningId !== undefined) { clearTimeout(warningId); warningId = undefined; }
  };
  return {
    next<T>(nextPromise: Promise<IteratorResult<T>>): Promise<IteratorResult<T>> {
      const timeoutPromise = new Promise<never>((_, reject) => {
        warningId = setTimeout(() => {
          debugLogger.warn('Stream idle for ' + warningMs + 'ms from ' + model);
        }, warningMs);
        timeoutId = setTimeout(() => {
          clearTimers();
          abortController.abort();
          reject(new InvalidStreamError(
            'Stream idle timeout after ' + timeoutMs + 'ms',
            'STREAM_IDLE_TIMEOUT',
          ));
        }, timeoutMs);
      });
      return Promise.race([nextPromise, timeoutPromise]).finally(clearTimers);
    },
    cleanup() { clearTimers(); },
  };
}
