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
 * install, and only for users who are relying on the default: an operator
 * who has set the setting or the environment variable, either way, has
 * already made a choice and is not shown it.
 *
 * The decision is made on the headless entry path before `config.initialize()`
 * sends the first event (see `prepareUsageStatisticsNotice`), so the
 * disclosure cannot be skipped by a run that exits early, for example at the
 * auth check.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/storage';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/atomicFileWrite';
import { USAGE_STATS_HOSTNAME } from '@qwen-code/qwen-code-core/telemetryConstants';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import { isFileSourcedEnvKey } from '../config/environment.js';
import type { Settings } from '../config/settings.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

export const USAGE_STATISTICS_NOTICE_SUBTYPE = 'usage_statistics_notice';

const USAGE_STATISTICS_ENV = 'QWEN_USAGE_STATISTICS_ENABLED';
const NOTICE_MARKER_FILE = 'usage-statistics-notice-shown';
const PRIVACY_NOTICE_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/';

export const USAGE_STATISTICS_NOTICE =
  `Qwen Code sends usage statistics, tagged with a random per-install ID ` +
  `(no prompts, code, or file contents), to ` +
  `${USAGE_STATS_HOSTNAME}. To opt out, set ${USAGE_STATISTICS_ENV}=false or ` +
  `"privacy": { "usageStatisticsEnabled": false } in settings; this also ` +
  `stops the models.dev catalog refresh. Shown once. Details: ` +
  `${PRIVACY_NOTICE_URL}`;

export interface UsageStatisticsNoticeInput {
  /** Resolved usage-statistics state for this session. */
  usageStatisticsEnabled: boolean;
  /**
   * `privacy.usageStatisticsEnabled` from operator scopes only (see
   * `operatorUsageStatisticsSetting`). A repository's workspace settings
   * must not be able to suppress the disclosure.
   */
  operatorSettingsValue: boolean | undefined;
  env?: Record<string, string | undefined>;
  /**
   * Whether an environment value was written by a `.env` file or a settings
   * `env` block rather than the launch environment. A file-sourced value may
   * come from the repository, so it does not count as the operator's choice.
   */
  isEnvFileSourced?: (key: string) => boolean;
  /** Overrides the marker location; defaults to the global Qwen directory. */
  markerPath?: string;
}

interface SettingsScope {
  settings: Pick<Settings, 'privacy'>;
}

/**
 * The operator's explicit `privacy.usageStatisticsEnabled`, ignoring the
 * workspace scope. Scopes resolve like a normal load: system over user over
 * system defaults. Bare mode keeps operator settings in the system scope.
 */
export function operatorUsageStatisticsSetting(scopes: {
  systemDefaults?: SettingsScope;
  user?: SettingsScope;
  system?: SettingsScope;
}): boolean | undefined {
  let selected: boolean | undefined;
  for (const scope of [scopes.systemDefaults, scopes.user, scopes.system]) {
    const value = scope?.settings?.privacy?.usageStatisticsEnabled;
    if (typeof value === 'boolean') selected = value;
  }
  return selected;
}

let decided = false;
let pendingMarkerPath: string | undefined;
let deliveredMarkerPath: string | undefined;

function defaultMarkerPath(): string {
  return path.join(Storage.getGlobalQwenDir(), NOTICE_MARKER_FILE);
}

/**
 * Decides once per process whether the notice is due, and holds it until
 * `takeUsageStatisticsNotice` delivers it. Returns true when a notice is
 * pending. Nothing is recorded here, so a run that never delivers the notice
 * shows it again next time.
 */
export function prepareUsageStatisticsNotice(
  input: UsageStatisticsNoticeInput,
): boolean {
  if (decided) return pendingMarkerPath !== undefined;
  decided = true;

  const env = input.env ?? process.env;
  const isEnvFileSourced = input.isEnvFileSourced ?? isFileSourcedEnvKey;
  if (!input.usageStatisticsEnabled) return false;
  if (
    env[USAGE_STATISTICS_ENV] !== undefined &&
    !isEnvFileSourced(USAGE_STATISTICS_ENV)
  ) {
    return false;
  }
  // Only an explicit opt-in suppresses it: an operator `false` that is in
  // effect already returned above, and one a trusted workspace overrode
  // leaves collection on, so it still needs the disclosure.
  if (input.operatorSettingsValue === true) return false;

  const markerPath = input.markerPath ?? defaultMarkerPath();
  // existsSync returns false rather than throwing, so an unreadable marker
  // already falls through to showing the notice.
  if (fs.existsSync(markerPath)) return false;

  pendingMarkerPath = markerPath;
  return true;
}

/**
 * Hands the pending notice to the caller once. The caller writes it and then
 * calls `recordUsageStatisticsNoticeShown`; until then, the exit fallback
 * still prints it.
 */
export function takeUsageStatisticsNotice(): string | null {
  const markerPath = pendingMarkerPath;
  if (markerPath === undefined) return null;
  pendingMarkerPath = undefined;
  deliveredMarkerPath = markerPath;
  return USAGE_STATISTICS_NOTICE;
}

/**
 * Records that a taken notice reached the output, so later runs stay quiet.
 * A marker that cannot be written never suppresses the notice: showing it
 * again beats never showing it.
 */
export function recordUsageStatisticsNoticeShown(): void {
  const markerPath = deliveredMarkerPath;
  if (markerPath === undefined) return;
  deliveredMarkerPath = undefined;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    atomicWriteFileSync(markerPath, `${new Date().toISOString()}\n`, {
      encoding: 'utf-8',
    });
  } catch {
    // Read-only home or sandbox: the notice will show again next run.
  }
}

function writePendingNoticeToStderr(): void {
  // A notice taken for buffered JSON output that was never written counts
  // as undelivered too.
  const notice =
    takeUsageStatisticsNotice() ??
    (deliveredMarkerPath !== undefined ? USAGE_STATISTICS_NOTICE : null);
  if (!notice) return;
  writeStderrLine(notice);
  recordUsageStatisticsNoticeShown();
}

export interface HeadlessNoticeConfig {
  getUsageStatisticsEnabled(): boolean;
  getOutputFormat(): OutputFormat | string;
}

/**
 * Called on the headless entry path before `config.initialize()`, which
 * sends the first usage-statistics event. Text mode prints the notice to
 * stderr right away. JSON and stream-JSON modes keep it pending so it is
 * emitted as a system message after `init` (or before an early error
 * result); if the process exits before that happens, it goes to stderr.
 */
export function discloseUsageStatisticsForHeadlessRun(
  config: HeadlessNoticeConfig,
  settings: Parameters<typeof operatorUsageStatisticsSetting>[0],
  options: Pick<
    UsageStatisticsNoticeInput,
    'env' | 'isEnvFileSourced' | 'markerPath'
  > = {},
): void {
  const pending = prepareUsageStatisticsNotice({
    usageStatisticsEnabled: config.getUsageStatisticsEnabled(),
    operatorSettingsValue: operatorUsageStatisticsSetting(settings),
    ...options,
  });
  if (!pending) return;
  if (config.getOutputFormat() === OutputFormat.TEXT) {
    writePendingNoticeToStderr();
  } else {
    process.once('exit', writePendingNoticeToStderr);
  }
}

/** Test-only: forget the decision and any pending notice. */
export function resetUsageStatisticsNoticeForTesting(): void {
  decided = false;
  pendingMarkerPath = undefined;
  deliveredMarkerPath = undefined;
  process.removeListener('exit', writePendingNoticeToStderr);
}
