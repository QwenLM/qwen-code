/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  OutputFormat,
  type ChatRecordingFailureEvent,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import type { CLISystemMessage } from '../nonInteractive/types.js';
import { writeStderrLine } from './stdioHelpers.js';

export const CHAT_RECORDING_FAILURE_MESSAGE =
  'Session recording stopped after a write failure. New messages for the affected session will not be saved. Check disk space and permissions, then start a new session to resume recording. See the debug log for details.';

export const TUI_CHAT_RECORDING_FAILURE_MESSAGE =
  'Session recording stopped after a write failure. New messages for the affected session will not be saved. Check disk space and permissions, then run `/clear` to start a new recorded session. See the debug log for details.';

const CHAT_RECORDING_SETTLE_TIMEOUT_MS = 2000;

export function createChatRecordingFailureSystemMessage(
  event: ChatRecordingFailureEvent,
): CLISystemMessage {
  return {
    type: 'system',
    subtype: 'session_recording_degraded',
    uuid: randomUUID(),
    session_id: event.sessionId,
    parent_tool_use_id: null,
    data: {
      session_id: event.sessionId,
      reason: 'write_failed',
      message: CHAT_RECORDING_FAILURE_MESSAGE,
    },
  };
}

export function reportChatRecordingFailureToAdapter(
  adapter: JsonOutputAdapterInterface,
  event: ChatRecordingFailureEvent,
): void {
  adapter.emitMessage(createChatRecordingFailureSystemMessage(event));
}

export function subscribeToHeadlessChatRecordingFailures(
  config: Config,
  adapter: JsonOutputAdapterInterface,
): () => void {
  if (typeof config.onChatRecordingFailure !== 'function') return () => {};
  return config.onChatRecordingFailure((event) => {
    if (config.getOutputFormat() === OutputFormat.TEXT) {
      writeStderrLine(`Warning: ${CHAT_RECORDING_FAILURE_MESSAGE}`);
      return;
    }
    reportChatRecordingFailureToAdapter(adapter, event);
  });
}

export async function settleChatRecording(
  config: Config,
  options: { finalize: boolean },
): Promise<'settled' | 'timeout'> {
  if (typeof config.getChatRecordingService !== 'function') return 'settled';
  const recorder = config.getChatRecordingService();
  if (!recorder) return 'settled';

  if (options.finalize) recorder.finalize();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(
      () => resolve('timeout'),
      CHAT_RECORDING_SETTLE_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  const settled = recorder.flush().then(
    () => 'settled' as const,
    () => 'settled' as const,
  );

  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
