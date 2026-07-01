/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const chatRecordingSuppressionContext = new AsyncLocalStorage<boolean>();

export function isChatRecordingSuppressed(): boolean {
  return chatRecordingSuppressionContext.getStore() === true;
}

export function runWithChatRecordingSuppressed<T>(fn: () => T): T {
  return chatRecordingSuppressionContext.run(true, fn);
}
