/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  runLogger,
  writeToStdout,
  BRAND_CLI_NAME,
} from '@qwen-code/core';
import type { LoadedSettings } from '../config/settings.js';
import { sanitizeForDisplay } from '../ui/utils/textUtils.js';
import { TerminalCapabilityManager } from '../ui/utils/terminalCapabilityManager.js';

export const MAX_NOTIFICATION_TITLE_CHARS = 48;
export const MAX_NOTIFICATION_SUBTITLE_CHARS = 64;
export const MAX_NOTIFICATION_BODY_CHARS = 180;

const BEL = '\x07';
const OSC9_PREFIX = '\x1b]9;';
const OSC9_SEPARATOR = ' | ';
const MAX_OSC9_MESSAGE_CHARS =
  MAX_NOTIFICATION_TITLE_CHARS +
  MAX_NOTIFICATION_SUBTITLE_CHARS +
  MAX_NOTIFICATION_BODY_CHARS +
  OSC9_SEPARATOR.length * 2;

export interface RunEventNotificationContent {
  title: string;
  subtitle?: string;
  body: string;
}

export type RunEventNotificationEvent =
  | {
      type: 'attention';
      heading?: string;
      detail?: string;
    }
  | {
      type: 'session_complete';
      detail?: string;
    };

function sanitizeNotificationContent(
  content: RunEventNotificationContent,
): RunEventNotificationContent {
  const cliName = BRAND_CLI_NAME;
  const title = sanitizeForDisplay(content.title, MAX_NOTIFICATION_TITLE_CHARS);
  const subtitle = content.subtitle
    ? sanitizeForDisplay(content.subtitle, MAX_NOTIFICATION_SUBTITLE_CHARS)
    : undefined;
  const body = sanitizeForDisplay(content.body, MAX_NOTIFICATION_BODY_CHARS);

  return {
    title: title || cliName,
    subtitle: subtitle || undefined,
    body: body || `Open ${cliName} for details.`,
  };
}

export function buildRunEventNotificationContent(
  event: RunEventNotificationEvent,
): RunEventNotificationContent {
  const cliName = BRAND_CLI_NAME;
  if (event.type === 'attention') {
    return sanitizeNotificationContent({
      title: `${cliName} needs your attention`,
      subtitle: event.heading ?? 'Action required',
      body: event.detail ?? `Open ${cliName} to continue.`,
    });
  }

  return sanitizeNotificationContent({
    title: `${cliName} session complete`,
    subtitle: 'Run finished',
    body: event.detail ?? 'The session finished successfully.',
  });
}

export function isNotificationsEnabled(settings: LoadedSettings): boolean {
  const general = settings.merged.general as
    | { enableNotifications?: boolean }
    | undefined;

  return general?.enableNotifications === true;
}

function buildTerminalNotificationMessage(
  content: RunEventNotificationContent,
): string {
  const pieces = [content.title, content.subtitle, content.body].filter(
    Boolean,
  );
  const combined = pieces.join(OSC9_SEPARATOR);
  return sanitizeForDisplay(combined, MAX_OSC9_MESSAGE_CHARS);
}

function emitOsc9Notification(content: RunEventNotificationContent): void {
  const message = buildTerminalNotificationMessage(content);
  if (!TerminalCapabilityManager.getInstance().supportsOsc9Notifications()) {
    writeToStdout(BEL);
    return;
  }

  writeToStdout(`${OSC9_PREFIX}${message}${BEL}`);
}

export async function notifyViaTerminal(
  notificationsEnabled: boolean,
  content: RunEventNotificationContent,
): Promise<boolean> {
  if (!notificationsEnabled) {
    return false;
  }

  try {
    emitOsc9Notification(sanitizeNotificationContent(content));
    return true;
  } catch (error) {
    runLogger.debug('Failed to emit terminal notification:', error);
    return false;
  }
}
