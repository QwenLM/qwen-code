/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { normalizeWorkerDiagnostic } from '../../serve/channel-worker-diagnostics.js';
import {
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
} from '../../serve/channel-worker-startup-ipc.js';

function sanitizeValue(value: string, maxLength: number): string {
  const normalized = normalizeWorkerDiagnostic(value);
  return sanitizeLogText(redactLogCredentials(normalized), maxLength);
}

export function sanitizeChannelCommandValue(
  value: string,
  maxLength = 512,
): string {
  return sanitizeValue(value, maxLength);
}

export function safeChannelCommandErrorMessage(error: unknown): string {
  let value: string;
  try {
    const message =
      error && (typeof error === 'object' || typeof error === 'function')
        ? Reflect.get(error, 'message')
        : undefined;
    value =
      typeof message === 'string' && message.length > 0
        ? message
        : String(error);
  } catch {
    value = 'Unknown error';
  }
  return sanitizeChannelCommandValue(value) || 'Unknown error';
}

export function channelStartupFailureBody(error: unknown): unknown {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return undefined;
  }
  try {
    const body = Reflect.get(error, 'body');
    return body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      Reflect.get(body, 'code') === 'channel_worker_start_failed'
      ? body
      : undefined;
  } catch {
    return undefined;
  }
}

export function formatChannelStartupFailures(
  source: unknown,
  fallbackWorkspaceCwd?: string,
): string[] {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  let rawFailures: unknown;
  let rawTruncated: unknown;
  try {
    rawFailures = Reflect.get(source, 'startupFailures');
    rawTruncated = Reflect.get(source, 'startupFailuresTruncated');
  } catch {
    return [];
  }
  if (!Array.isArray(rawFailures)) return [];
  let limitedFailures: unknown[];
  let rawFailureCount: number;
  try {
    limitedFailures = rawFailures.slice(0, MAX_CHANNEL_STARTUP_FAILURES);
    rawFailureCount = rawFailures.length;
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const raw of limitedFailures) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const channel = Reflect.get(raw, 'channel');
      const phase = Reflect.get(raw, 'phase');
      const message = Reflect.get(raw, 'message');
      const rawCode = Reflect.get(raw, 'code');
      const rawWorkspace = Reflect.get(raw, 'workspaceCwd');
      if (
        typeof channel !== 'string' ||
        channel.length === 0 ||
        phase !== 'connect' ||
        typeof message !== 'string' ||
        message.length === 0 ||
        (rawCode !== undefined &&
          (typeof rawCode !== 'string' || rawCode.length === 0)) ||
        (rawWorkspace !== undefined && typeof rawWorkspace !== 'string')
      ) {
        continue;
      }
      const safeChannel = sanitizeValue(
        channel,
        MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
      );
      const safeMessage = sanitizeValue(
        message,
        MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
      );
      const workspace = sanitizeValue(
        typeof rawWorkspace === 'string'
          ? rawWorkspace
          : (fallbackWorkspaceCwd ?? ''),
        4096,
      );
      const code =
        typeof rawCode === 'string'
          ? sanitizeValue(rawCode, MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH)
          : undefined;
      if (!safeChannel || !safeMessage) continue;
      const fields = [
        ...(workspace ? [`workspace=${workspace}`] : []),
        `channel=${safeChannel}`,
        'phase=connect',
        ...(code ? [`code=${code}`] : []),
      ];
      lines.push(
        `[Channel] Startup failure (${fields.join(', ')}): ${safeMessage}`,
      );
    } catch {
      // Malformed daemon responses are ignored rather than rendered.
    }
  }
  if (rawTruncated === true || rawFailureCount > MAX_CHANNEL_STARTUP_FAILURES) {
    lines.push('[Channel] Additional startup failures were truncated.');
  }
  return lines;
}
