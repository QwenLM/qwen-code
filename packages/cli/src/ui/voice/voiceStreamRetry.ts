/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VoiceStreamSession } from './voiceStreamSession.js';

export async function openVoiceStreamWithRetry(
  open: () => Promise<VoiceStreamSession>,
): Promise<VoiceStreamSession> {
  try {
    return await open();
  } catch {
    return open();
  }
}
