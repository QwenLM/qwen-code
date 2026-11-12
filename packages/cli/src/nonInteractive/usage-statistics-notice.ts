/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-time disclosure of default-on usage statistics for headless runs.
 *
 * Interactive sessions disclose usage statistics through the privacy notice
 * linked from the auth dialog, but a headless `qwen -p` run renders no
 * dialog. This notice names the collection host and the opt-out once per
 * install, and only for users who are relying on the default: anyone who has
 * set the setting or the environment variable, either way, has already made
 * a choice and is not shown it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/storage';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/atomicFileWrite';
import { USAGE_STATS_HOSTNAME } from '@qwen-code/qwen-code-core/telemetryConstants';

export const USAGE_STATISTICS_NOTICE_SUBTYPE = 'usage_statistics_notice';

const USAGE_STATISTICS_ENV = 'QWEN_USAGE_STATISTICS_ENABLED';
const NOTICE_MARKER_FILE = 'usage-statistics-notice-shown';
const PRIVACY_NOTICE_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/';

export const USAGE_STATISTICS_NOTICE =
  `Qwen Code sends usage statistics (no prompts, code, or file contents) to ` +
  `${USAGE_STATS_HOSTNAME}. To opt out, set ${USAGE_STATISTICS_ENV}=false or ` +
  `"privacy": { "usageStatisticsEnabled": false } in settings; this also ` +
  `stops the models.dev catalog refresh. Shown once. Details: ` +
  `${PRIVACY_NOTICE_URL}`;

export interface UsageStatisticsNoticeInput {
  /** Resolved usage-statistics state for this session. */
  usageStatisticsEnabled: boolean;
  /** `privacy.usageStatisticsEnabled` from merged settings, before defaults. */
  settingsValue: boolean | undefined;
  env?: Record<string, string | undefined>;
  /** Overrides the marker location; defaults to the global Qwen directory. */
  markerPath?: string;
}

let shownThisProcess = false;

function defaultMarkerPath(): string {
  return path.join(Storage.getGlobalQwenDir(), NOTICE_MARKER_FILE);
}

/**
 * Returns the notice text when it should be shown, recording that it was so
 * later runs stay quiet. A marker that cannot be read or written never
 * suppresses the notice: showing it again beats never showing it.
 */
export function consumeUsageStatisticsNotice(
  input: UsageStatisticsNoticeInput,
): string | null {
  const env = input.env ?? process.env;
  if (shownThisProcess) return null;
  if (!input.usageStatisticsEnabled) return null;
  if (env[USAGE_STATISTICS_ENV] !== undefined) return null;
  if (input.settingsValue !== undefined) return null;

  const markerPath = input.markerPath ?? defaultMarkerPath();
  try {
    if (fs.existsSync(markerPath)) return null;
  } catch {
    // Unreadable marker: fall through and show the notice.
  }

  shownThisProcess = true;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    atomicWriteFileSync(markerPath, `${new Date().toISOString()}\n`, {
      encoding: 'utf-8',
    });
  } catch {
    // Read-only home or sandbox: the notice will show again next run.
  }
  return USAGE_STATISTICS_NOTICE;
}

/** Test-only: forget that the notice was shown in this process. */
export function resetUsageStatisticsNoticeForTesting(): void {
  shownThisProcess = false;
}
