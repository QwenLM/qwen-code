/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Part } from '@google/genai';
import { HTTP_MANAGED_SESSION_STORE_CONTRACT } from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';

export function hostedTranscriptFitsInline(cwd: string, sessionId: string) {
  return (type: 'assistant' | 'tool_result', parts: Part[], model: string) =>
    Buffer.byteLength(
      JSON.stringify({
        uuid: randomUUID(),
        parentUuid: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type,
        cwd,
        version: 'hosted-harness/1',
        daemonPromptId: 'prompt',
        model,
        message: { role: type === 'assistant' ? 'model' : 'user', parts },
      }),
    ) <= HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes;
}
