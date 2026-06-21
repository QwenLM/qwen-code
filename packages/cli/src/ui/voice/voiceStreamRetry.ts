/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VoiceStreamSession } from './voiceStreamSession.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const RETRY_DELAY_MS = 200;
const debugLogger = createDebugLogger('VOICE_STREAM');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
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
    if (!isRetryable(error)) {
      throw error;
    }
    debugLogger.debug('[voice] stream open failed, retrying:', error);
    await delay(RETRY_DELAY_MS);
    return open();
  }
}
