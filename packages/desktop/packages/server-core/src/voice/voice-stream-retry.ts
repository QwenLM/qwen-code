import type { VoiceStreamSession } from './voice-stream-session';
import { CONSOLE_LOGGER, createScopedLogger } from '../runtime/platform';

const RETRY_DELAY_MS = 200;
const debugLogger = createScopedLogger(CONSOLE_LOGGER, 'VOICE_STREAM');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableVoiceStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /\b(400|401|403|404|410|422|429)\b|unauthori[sz]ed|forbidden|model_not_supported|rate.?limit/i.test(
      message,
    )
  ) {
    return false;
  }
  return true;
}

export async function openVoiceStreamWithRetry(
  open: () => Promise<VoiceStreamSession>,
): Promise<VoiceStreamSession> {
  try {
    return await open();
  } catch (error) {
    if (!isRetryableVoiceStreamError(error)) {
      throw error;
    }
    debugLogger.debug('[voice] stream open failed, retrying:', error);
    await delay(RETRY_DELAY_MS);
    return open();
  }
}
