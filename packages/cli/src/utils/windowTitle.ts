/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamingState } from '../ui/types.js';
import { BRAND_CLI_NAME } from '@qwen-code/core';

export interface TerminalTitleOptions {
  streamingState: StreamingState;
  isConfirming: boolean;
  sessionTitle: string;
  useDynamicTitle: boolean;
}

const MAX_TITLE_LENGTH = 80;
const MAX_PROVISIONAL_TITLE_LENGTH = 60;
const MAX_STATUS_DESCRIPTION_LENGTH = 32;

export function isWindowsTerminalHost(
  platform: NodeJS.Platform = process.platform,
  wtSession: string | undefined = process.env['WT_SESSION'],
): boolean {
  return platform === 'win32' || Boolean(wtSession);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.substring(0, maxLen - 1) + '…';
}

export function sanitizeTitleText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function createProvisionalTerminalTitle(
  submittedPrompt: string,
): string | null {
  const normalized = sanitizeTitleText(submittedPrompt);
  return normalized
    ? truncate(normalized, MAX_PROVISIONAL_TITLE_LENGTH)
    : null;
}

/**
 * Computes the dynamic terminal window title based on the current CLI state.
 *
 * @param options - The current state of the CLI and environment context
 * @returns A formatted string padded to 80 characters for the terminal title
 */
export function computeTerminalTitle({
  streamingState,
  isConfirming,
  sessionTitle,
  useDynamicTitle,
}: TerminalTitleOptions): string {
  const cliName = BRAND_CLI_NAME;
  const displayTitle =
    sanitizeTitleText(process.env['CLI_TITLE'] || sessionTitle) || cliName;

  if (!useDynamicTitle) {
    const base = `${cliName} `;
    // Max context length is 80 - base.length - 2 (for brackets)
    const maxContextLen = MAX_TITLE_LENGTH - base.length - 2;
    return `${base}(${truncate(displayTitle, maxContextLen)})`.padEnd(
      MAX_TITLE_LENGTH,
      ' ',
    );
  }

  let icon: string;
  let statusDescription: string;
  if (
    isConfirming ||
    streamingState === StreamingState.WaitingForConfirmation
  ) {
    icon = '▲';
    statusDescription = 'Action Required';
  } else if (streamingState === StreamingState.Idle) {
    icon = '◇';
    statusDescription = 'Ready';
  } else {
    icon = '✦';
    statusDescription = 'Working';
  }

  const compactStatus = truncate(
    statusDescription,
    MAX_STATUS_DESCRIPTION_LENGTH,
  );
  const prefix = `${icon} `;
  const suffix = ` | ${compactStatus}`;
  const maxSessionTitleLength = Math.max(
    1,
    MAX_TITLE_LENGTH - prefix.length - suffix.length,
  );
  const title = `${prefix}${truncate(
    displayTitle,
    maxSessionTitleLength,
  )}${suffix}`;

  // Fixed width prevents taskbar icon resizing/jitter.
  return title.padEnd(MAX_TITLE_LENGTH, ' ').substring(0, MAX_TITLE_LENGTH);
}
