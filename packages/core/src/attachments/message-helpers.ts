/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamUserMessage } from '../provider/modelStreamRequest.js';

export function systemReminder(content: string): ModelStreamUserMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<system-reminder>\n${content}\n</system-reminder>`,
      },
    ],
  };
}

export function userMessage(text: string): ModelStreamUserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}
