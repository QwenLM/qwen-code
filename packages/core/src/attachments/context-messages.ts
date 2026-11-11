/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../protocol/transcript/message.js';
import { isEnvironmentMessage } from './models/environment-attachment.js';
import { isSessionContextMessage } from './models/session-context-attachment.js';

/** Structured baselines whose rendered text already belongs to a fork prefix. */
export function isContextAttachmentMessage(message: Message): boolean {
  return isEnvironmentMessage(message) || isSessionContextMessage(message);
}
