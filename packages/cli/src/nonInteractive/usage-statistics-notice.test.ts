/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import {
  USAGE_STATISTICS_NOTICE,
  discloseUsageStatisticsForHeadlessRun,
  operatorUsageStatisticsSetting,
  prepareUsageStatisticsNotice,
  recordUsageStatisticsNoticeShown,
  resetUsageStatisticsNoticeForTesting,
  takeUsageStatisticsNotice,
  type UsageStatisticsNoticeInput,
} from './usage-statistics-notice.js';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
}));

const mockIsFileSourcedEnvKey = vi.hoisted(() => vi.fn(() => false));
vi.mock('../config/environment.js', () => ({
  isFileSourcedEnvKey: mockIsFileSourcedEnvKey,
}));

const notFileSourced = (_key: string) => false;

describe('usage statistics notice', () => {
  let dir: string;
  let markerPath: string;

  beforeEach(() => {
    resetUsageStatisticsNoticeForTesting();
    mockWriteStderrLine.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notice-'));
    markerPath = path.join(dir, 'nested', 'usage-statistics-notice-shown');
  });

  afterEach(() => {
    resetUsageStatisticsNoticeForTesting();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const defaults = (): UsageStatisticsNoticeInput => ({
    usageStatisticsEnabled: true,
    operatorSettingsValue: undefined,
    env: {},
    isEnvFileSourced: notFileSourced,
    markerPath,
  });

  /** Prepares, takes, and records, as one headless run that writes it would. */
  const showOnce = (input = defaults()) => {
    if (!prepareUsageStatisticsNotice(input)) return null;
    const notice = takeUsageStatisticsNotice();
    recordUsageStatisticsNoticeShown();
    return notice;
  };

  it('names the collection host and the opt-out', () => {
    expect(USAGE_STATISTICS_NOTICE).toContain(
      'gb4w8c3ygj-default-sea.rum.aliyuncs.com',
    );
    expect(USAGE_STATISTICS_NOTICE).toContain(
      'QWEN_USAGE_STATISTICS_ENABLED=false',
    );
    expect(USAGE_STATISTICS_NOTICE).toContain('usageStatisticsEnabled');
    // The install ID is a stable identifier; the disclosure must not imply
    // that nothing identifying is sent (#17052).
    expect(USAGE_STATISTICS_NOTICE).toContain('random per-install ID');
  });

  it('shows once for a user on the default, then records a marker', () => {
    expect(showOnce()).toBe(USAGE_STATISTICS_NOTICE);
    expect(fs.existsSync(markerPath)).toBe(true);

    resetUsageStatisticsNoticeForTesting();
    expect(showOnce()).toBeNull();
  });

  it('records the marker only once the notice has been written', () => {
    expect(prepareUsageStatisticsNotice(defaults())).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    // Taken for buffered output that never reached stdout.
    expect(takeUsageStatisticsNotice()).toBe(USAGE_STATISTICS_NOTICE);
    expect(fs.existsSync(markerPath)).toBe(false);

    // A run that exits before writing it shows the notice next time.
    resetUsageStatisticsNoticeForTesting();
    expect(prepareUsageStatisticsNotice(defaults())).toBe(true);
  });

  it('records nothing when no notice was taken', () => {
    expect(prepareUsageStatisticsNotice(defaults())).toBe(true);
    recordUsageStatisticsNoticeShown();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('delivers at most once per process even without a marker', () => {
    expect(showOnce()).not.toBeNull();
    fs.rmSync(markerPath);
    expect(showOnce()).toBeNull();
    expect(takeUsageStatisticsNotice()).toBeNull();
  });

  it('is skipped when usage statistics are disabled', () => {
    expect(
      prepareUsageStatisticsNotice({
        ...defaults(),
        usageStatisticsEnabled: false,
      }),
    ).toBe(false);
    expect(takeUsageStatisticsNotice()).toBeNull();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it.each([['true'], ['false'], ['1'], ['']])(
    'is skipped when the launch environment sets the env var (%j)',
    (value) => {
      expect(
        showOnce({
          ...defaults(),
          env: { QWEN_USAGE_STATISTICS_ENABLED: value },
        }),
      ).toBeNull();
    },
  );

  it('still shows when the env var came from a .env file or settings env', () => {
    // A cloned repository's `.qwen/.env` must not be able to suppress the
    // disclosure while collection stays on.
    const isEnvFileSourced = vi.fn(
      (key: string) => key === 'QWEN_USAGE_STATISTICS_ENABLED',
    );
    expect(
      showOnce({
        ...defaults(),
        env: { QWEN_USAGE_STATISTICS_ENABLED: 'true' },
        isEnvFileSourced,
      }),
    ).toBe(USAGE_STATISTICS_NOTICE);
    expect(isEnvFileSourced).toHaveBeenCalledWith(
      'QWEN_USAGE_STATISTICS_ENABLED',
    );
  });

  it('is skipped when the operator setting is explicitly true', () => {
    expect(showOnce({ ...defaults(), operatorSettingsValue: true })).toBeNull();
  });

  it('still shows when an operator false was overridden and collection is on', () => {
    // User settings say false, a trusted workspace says true: the merged
    // value keeps collection on, so the opt-out must not hide the notice.
    expect(showOnce({ ...defaults(), operatorSettingsValue: false })).toBe(
      USAGE_STATISTICS_NOTICE,
    );
  });

  it('checks env provenance with the loader by default', () => {
    mockIsFileSourcedEnvKey.mockReturnValueOnce(true);
    const { isEnvFileSourced: _seam, ...rest } = defaults();
    expect(
      showOnce({ ...rest, env: { QWEN_USAGE_STATISTICS_ENABLED: 'true' } }),
    ).toBe(USAGE_STATISTICS_NOTICE);
    expect(mockIsFileSourcedEnvKey).toHaveBeenCalledWith(
      'QWEN_USAGE_STATISTICS_ENABLED',
    );
  });

  it('still shows when the marker cannot be written', () => {
    // A regular file where the marker's parent directory should be makes
    // both mkdir and the write fail.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    const unwritable = path.join(blocker, 'usage-statistics-notice-shown');

    expect(showOnce({ ...defaults(), markerPath: unwritable })).toBe(
      USAGE_STATISTICS_NOTICE,
    );
    expect(fs.existsSync(unwritable)).toBe(false);
  });

  it('reads the process environment when no env is passed', () => {
    vi.stubEnv('QWEN_USAGE_STATISTICS_ENABLED', 'false');
    const { env: _env, ...rest } = defaults();
    expect(showOnce(rest)).toBeNull();
  });

  it('records the marker in the global Qwen directory by default', () => {
    const qwenHome = path.join(dir, 'qwen-home');
    vi.stubEnv('QWEN_HOME', qwenHome);
    const { markerPath: _markerPath, ...rest } = defaults();
    expect(showOnce(rest)).toBe(USAGE_STATISTICS_NOTICE);
    expect(
      fs.existsSync(path.join(qwenHome, 'usage-statistics-notice-shown')),
    ).toBe(true);
  });
});

describe('operatorUsageStatisticsSetting', () => {
  const scope = (value?: boolean) => ({
    settings:
      value === undefined ? {} : { privacy: { usageStatisticsEnabled: value } },
  });

  it('is undefined when no operator scope sets it', () => {
    expect(
      operatorUsageStatisticsSetting({
        systemDefaults: scope(),
        user: scope(),
        system: scope(),
      }),
    ).toBeUndefined();
  });

  it('resolves system over user over system defaults', () => {
    expect(
      operatorUsageStatisticsSetting({
        systemDefaults: scope(true),
        user: scope(false),
        system: scope(),
      }),
    ).toBe(false);
    expect(
      operatorUsageStatisticsSetting({
        systemDefaults: scope(false),
        user: scope(false),
        system: scope(true),
      }),
    ).toBe(true);
  });

  it('ignores the workspace scope', () => {
    const loaded = {
      systemDefaults: scope(),
      user: scope(),
      system: scope(),
      workspace: scope(true),
    };
    expect(operatorUsageStatisticsSetting(loaded)).toBeUndefined();
  });
});

describe('discloseUsageStatisticsForHeadlessRun', () => {
  let dir: string;
  let markerPath: string;
  const noSettings = {
    systemDefaults: { settings: {} },
    user: { settings: {} },
    system: { settings: {} },
    workspace: { settings: { privacy: { usageStatisticsEnabled: true } } },
  };
  const config = (format: OutputFormat) => ({
    getUsageStatisticsEnabled: () => true,
    getOutputFormat: () => format,
  });

  beforeEach(() => {
    resetUsageStatisticsNoticeForTesting();
    mockWriteStderrLine.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-notice-'));
    markerPath = path.join(dir, 'usage-statistics-notice-shown');
  });

  afterEach(() => {
    resetUsageStatisticsNoticeForTesting();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints to stderr immediately in text mode', () => {
    discloseUsageStatisticsForHeadlessRun(
      config(OutputFormat.TEXT),
      noSettings,
      { env: {}, isEnvFileSourced: notFileSourced, markerPath },
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(USAGE_STATISTICS_NOTICE);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(takeUsageStatisticsNotice()).toBeNull();
  });

  it.each([OutputFormat.JSON, OutputFormat.STREAM_JSON])(
    'keeps the notice pending in %s mode and falls back to stderr at exit',
    (format) => {
      const once = vi.spyOn(process, 'once');
      discloseUsageStatisticsForHeadlessRun(config(format), noSettings, {
        env: {},
        isEnvFileSourced: notFileSourced,
        markerPath,
      });
      expect(mockWriteStderrLine).not.toHaveBeenCalled();

      const exitCall = once.mock.calls.find(([event]) => event === 'exit');
      expect(exitCall).toBeDefined();
      (exitCall![1] as () => void)();
      expect(mockWriteStderrLine).toHaveBeenCalledWith(USAGE_STATISTICS_NOTICE);
      expect(fs.existsSync(markerPath)).toBe(true);
    },
  );

  it('prints at exit when the notice was taken but never written', () => {
    const once = vi.spyOn(process, 'once');
    discloseUsageStatisticsForHeadlessRun(
      config(OutputFormat.JSON),
      noSettings,
      { env: {}, isEnvFileSourced: notFileSourced, markerPath },
    );
    // Buffered into a JSON document that was never written.
    expect(takeUsageStatisticsNotice()).toBe(USAGE_STATISTICS_NOTICE);

    const exitCall = once.mock.calls.find(([event]) => event === 'exit');
    (exitCall![1] as () => void)();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(USAGE_STATISTICS_NOTICE);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it('does not print at exit once the JSON output delivered the notice', () => {
    const once = vi.spyOn(process, 'once');
    discloseUsageStatisticsForHeadlessRun(
      config(OutputFormat.JSON),
      noSettings,
      { env: {}, isEnvFileSourced: notFileSourced, markerPath },
    );
    expect(takeUsageStatisticsNotice()).toBe(USAGE_STATISTICS_NOTICE);
    recordUsageStatisticsNoticeShown();

    const exitCall = once.mock.calls.find(([event]) => event === 'exit');
    (exitCall![1] as () => void)();
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });
});
