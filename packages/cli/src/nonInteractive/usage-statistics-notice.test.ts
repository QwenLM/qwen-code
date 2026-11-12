/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_STATISTICS_NOTICE,
  consumeUsageStatisticsNotice,
  resetUsageStatisticsNoticeForTesting,
} from './usage-statistics-notice.js';

describe('consumeUsageStatisticsNotice', () => {
  let dir: string;
  let markerPath: string;

  beforeEach(() => {
    resetUsageStatisticsNoticeForTesting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notice-'));
    markerPath = path.join(dir, 'nested', 'usage-statistics-notice-shown');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const defaults = () => ({
    usageStatisticsEnabled: true,
    settingsValue: undefined,
    env: {},
    markerPath,
  });

  it('names the collection host and the opt-out', () => {
    expect(USAGE_STATISTICS_NOTICE).toContain(
      'gb4w8c3ygj-default-sea.rum.aliyuncs.com',
    );
    expect(USAGE_STATISTICS_NOTICE).toContain(
      'QWEN_USAGE_STATISTICS_ENABLED=false',
    );
    expect(USAGE_STATISTICS_NOTICE).toContain('usageStatisticsEnabled');
  });

  it('shows once for a user on the default, then records a marker', () => {
    expect(consumeUsageStatisticsNotice(defaults())).toBe(
      USAGE_STATISTICS_NOTICE,
    );
    expect(fs.existsSync(markerPath)).toBe(true);

    resetUsageStatisticsNoticeForTesting();
    expect(consumeUsageStatisticsNotice(defaults())).toBeNull();
  });

  it('shows only once per process even without a marker', () => {
    expect(consumeUsageStatisticsNotice(defaults())).not.toBeNull();
    fs.rmSync(markerPath);
    expect(consumeUsageStatisticsNotice(defaults())).toBeNull();
  });

  it('is skipped when usage statistics are disabled', () => {
    expect(
      consumeUsageStatisticsNotice({
        ...defaults(),
        usageStatisticsEnabled: false,
      }),
    ).toBeNull();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.each([['true'], ['false'], ['1'], ['']])(
    'is skipped when the env var is set explicitly (%j)',
    (value) => {
      expect(
        consumeUsageStatisticsNotice({
          ...defaults(),
          env: { QWEN_USAGE_STATISTICS_ENABLED: value },
        }),
      ).toBeNull();
    },
  );

  it('is skipped when the setting is explicitly true', () => {
    expect(
      consumeUsageStatisticsNotice({ ...defaults(), settingsValue: true }),
    ).toBeNull();
  });

  it('still shows when the marker cannot be written', () => {
    // A regular file where the marker's parent directory should be makes
    // both mkdir and the write fail.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    const unwritable = path.join(blocker, 'usage-statistics-notice-shown');

    expect(
      consumeUsageStatisticsNotice({ ...defaults(), markerPath: unwritable }),
    ).toBe(USAGE_STATISTICS_NOTICE);
    expect(fs.existsSync(unwritable)).toBe(false);
  });
});
