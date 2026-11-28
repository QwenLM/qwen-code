/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetChangelogSnapshotForTest,
  fetchChangelog,
  fetchChangelogForLocale,
  findChangelogEntryForCliVersion,
  getChangelogUrl,
  getChangelogSnapshot,
  refreshChangelog,
  subscribeChangelog,
} from './changelogFetch.js';

const getGlobalConfigDir = vi.hoisted(() => vi.fn());
const getVersion = vi.hoisted(() => vi.fn());
const runLogger = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@qwen-code/core', () => ({
  Storage: {
    getGlobalConfigDir,
  },
  runLogger,
  getVersion,
  unmanagedRequest: (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));

vi.mock('./changelogUrls.js', () => ({
  CHANGELOG_URL: 'https://cdn.example.test/qwencode/changelog',
  CHANGELOG_ZH_CN_URL: 'https://cdn.example.test/qwencode/changelog-zh-CN',
}));

describe('changelogFetch', () => {
  it('reselects the localized fallback when English becomes cached during dispatch', async () => {
    const chinese = {
      fetchedAt: Date.now(),
      cliVersion: '1.0.0',
      content: '## CLI 0.9.0\nOld Chinese',
    };
    writeCache({ schemaVersion: 2, byLocale: { 'zh-CN': chinese } });
    getVersion
      .mockResolvedValueOnce('1.0.0')
      .mockImplementationOnce(async () => {
        writeCache({
          schemaVersion: 2,
          byLocale: {
            'zh-CN': chinese,
            en: {
              fetchedAt: Date.now(),
              cliVersion: '1.0.0',
              content: '## CLI 1.0.0\nCached English',
            },
          },
        });
        return '1.0.0';
      });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
    });
    await fetchChangelogForLocale('zh-CN');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe(
      'Cached English',
    );
  });
  it('fetches only the requested locale and URL in the single-language API', async () => {
    const url = 'https://custom.example/zh/changelog';
    await fetchChangelog('zh-CN', url);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, undefined);
  });
  it('uses resolved URLs for localized fetches and English fallback', async () => {
    const getUrl = (locale: 'en' | 'zh-CN') =>
      `https://custom.example/${locale}/changelog`;
    await fetchChangelogForLocale('zh-CN', getUrl);
    expect(fetchMock).toHaveBeenNthCalledWith(1, getUrl('zh-CN'), undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, getUrl('en'), undefined);
  });

  it('uses a resolved URL for a forced refresh', async () => {
    const getUrl = () => 'https://custom.example/changelog';
    await refreshChangelog('en', getUrl());
    expect(fetchMock).toHaveBeenCalledWith(getUrl(), undefined);
  });

  let tempDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  const oldChangelog = '## CLI 1.0.0\nOld notes\n';
  const newChangelog = '## CLI 1.0.1\nNew notes\n';

  function cachePath(): string {
    return path.join(tempDir, 'cache', 'changelog.json');
  }

  function writeCache(cache: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf-8');
  }

  function readCache(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) as Record<
      string,
      unknown
    >;
  }

  function readLocaleCache(locale: 'en' | 'zh-CN' = 'en') {
    const cache = readCache() as {
      schemaVersion?: number;
      byLocale?: Record<string, Record<string, unknown>>;
    };
    const entry = cache.byLocale?.[locale];
    if (!entry) throw new Error(`Missing ${locale} changelog cache`);
    return entry;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    _resetChangelogSnapshotForTest();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-changelog-'));
    getGlobalConfigDir.mockReturnValue(tempDir);
    getVersion.mockResolvedValue('1.0.0');

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue(newChangelog),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    _resetChangelogSnapshotForTest();
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips fetch when the cache is fresh for the current CLI version', async () => {
    writeCache({
      fetchedAt: Date.now(),
      cliVersion: '1.0.0',
      content: oldChangelog,
    });

    await fetchChangelog();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCache()['content']).toBe(oldChangelog);
  });

  it('publishes a newer cache written by another process before the next fetch', async () => {
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: {
          fetchedAt: Date.now() - 1_000,
          cliVersion: '1.0.0',
          content: '## CLI 1.0.0\nFirst process snapshot\n',
        },
      },
    });
    await fetchChangelog('en');
    expect(getChangelogSnapshot('en').entries[0]?.content).toBe(
      'First process snapshot',
    );

    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: {
          fetchedAt: Date.now(),
          cliVersion: '1.0.0',
          content: '## CLI 1.0.0\nSecond process snapshot\n',
        },
      },
    });

    await fetchChangelog('en');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getChangelogSnapshot('en').entries[0]?.content).toBe(
      'Second process snapshot',
    );
  });

  it('refetches a fresh invalid cache when the CLI version cannot be resolved', async () => {
    writeCache({
      fetchedAt: Date.now(),
      cliVersion: '1.0.0',
      content: '## CLI 1.0.0\n',
    });
    getVersion.mockRejectedValueOnce(new Error('version unavailable'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 1.0.0\nRecovered notes\n'),
    });

    await fetchChangelog('en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getChangelogSnapshot('en').entries[0]?.content).toBe(
      'Recovered notes',
    );
  });

  it('fetches despite a fresh cache when the CLI version changed', async () => {
    writeCache({
      fetchedAt: Date.now(),
      cliVersion: '1.0.0',
      content: oldChangelog,
    });
    getVersion.mockResolvedValue('1.0.1');

    await fetchChangelog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cache = readLocaleCache();
    expect(readCache()['schemaVersion']).toBe(2);
    expect(cache['cliVersion']).toBe('1.0.1');
    expect(cache['content']).toBe(newChangelog);
  });

  it('fetches fresh legacy caches that do not record a CLI version', async () => {
    writeCache({
      fetchedAt: Date.now(),
      content: oldChangelog,
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 1.0.0\nFresh notes\n'),
    });
    await fetchChangelog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cache = readLocaleCache();
    expect(cache['cliVersion']).toBe('1.0.0');
    expect(cache['content']).toBe('## CLI 1.0.0\nFresh notes\n');
  });

  it('treats v-prefixed cached versions as matching', async () => {
    writeCache({
      fetchedAt: Date.now(),
      cliVersion: 'v1.0.0',
      content: oldChangelog,
    });

    await fetchChangelog();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when the cache metadata matches but its content is behind', async () => {
    writeCache({
      fetchedAt: Date.now(),
      cliVersion: '1.0.1',
      content: oldChangelog,
    });
    getVersion.mockResolvedValue('1.0.1');

    await fetchChangelog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readLocaleCache()['content']).toBe(newChangelog);
  });

  it('keeps fetched history usable for a prerelease build absent from the changelog', async () => {
    writeCache({
      fetchedAt: Date.now(),
      cliVersion: '1.1.42-ui-i18n-feat',
      content: oldChangelog,
    });
    getVersion.mockResolvedValue('1.1.42-ui-i18n-feat');

    await fetchChangelog('en');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getChangelogSnapshot('en')).toMatchObject({
      entries: [expect.objectContaining({ content: 'New notes' })],
      status: 'ready',
    });
  });

  it('publishes a new snapshot after a background refresh', async () => {
    writeCache({
      fetchedAt: Date.now(),
      cliVersion: '1.0.0',
      content: oldChangelog,
    });
    getVersion.mockResolvedValue('1.0.1');

    expect(getChangelogSnapshot().latestVersion).toBe('1.0.0');
    const listener = vi.fn();
    const unsubscribe = subscribeChangelog(listener);

    await fetchChangelog();

    expect(getChangelogSnapshot()).toMatchObject({
      latestVersion: '1.0.1',
      cliVersion: '1.0.1',
      status: 'ready',
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('keeps history when the current-version fetch fails', async () => {
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: {
          fetchedAt: Date.now(),
          cliVersion: '1.0.0',
          content: oldChangelog,
        },
      },
    });
    expect(getChangelogSnapshot('en').latestVersion).toBe('1.0.0');
    getVersion.mockResolvedValue('2.0.0');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      text: vi.fn(),
    });

    await fetchChangelog('en');

    expect(getChangelogSnapshot('en').entries[0]?.content).toBe('Old notes');
  });

  it('selects release notes for the running CLI version', () => {
    const entries = [
      { version: '1.0.38', content: 'Newer notes' },
      { version: '1.0.37', content: 'Current notes' },
      { version: '1.0.33', content: 'Older notes' },
    ];

    expect(findChangelogEntryForCliVersion(entries, '1.0.37')).toEqual(
      entries[1],
    );
    expect(findChangelogEntryForCliVersion(entries, '1.0.36')).toBeUndefined();
    expect(
      findChangelogEntryForCliVersion(entries, '1.0.37-ui-i18n-feat'),
    ).toBeUndefined();
    expect(findChangelogEntryForCliVersion(entries, 'dev-build')).toEqual(
      entries[0],
    );
    expect(findChangelogEntryForCliVersion([], '1.0.37')).toBeUndefined();
  });

  it('fetches and selects a localized changelog with English fallback', async () => {
    const english = '## CLI 1.0.0\nEnglish notes\n';
    const chinese = '## CLI 1.0.0\n中文更新\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: Date.now(), cliVersion: '1.0.0', content: english },
      },
    });
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe(
      'English notes',
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue(chinese),
    });

    await fetchChangelogForLocale('zh-CN');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example.test/qwencode/changelog-zh-CN',
      undefined,
    );
    expect(getChangelogUrl('en')).toBe(
      'https://cdn.example.test/qwencode/changelog',
    );
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe('中文更新');
    expect(readLocaleCache('en')['content']).toBe(english);
    expect(readLocaleCache('zh-CN')['content']).toBe(chinese);
  });

  it('fetches English when the Chinese changelog endpoint has no data', async () => {
    const english = '## CLI 1.0.0\nEnglish notes\n';
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: vi.fn(),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue(english),
      });

    await fetchChangelogForLocale('zh-CN');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://cdn.example.test/qwencode/changelog-zh-CN',
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.test/qwencode/changelog',
      undefined,
    );
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe(
      'English notes',
    );
    expect(readLocaleCache('en')['content']).toBe(english);
  });

  it('keeps the entire English snapshot when localized content lacks the current version', async () => {
    const english = '## CLI 1.0.0\nEnglish notes\n';
    const staleChinese = '## CLI 0.9.0\n旧中文缓存\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: Date.now(), cliVersion: '1.0.0', content: english },
        'zh-CN': {
          fetchedAt: Date.now(),
          cliVersion: '0.9.0',
          content: staleChinese,
        },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 0.9.0\n旧中文\n'),
    });

    await fetchChangelogForLocale('zh-CN');

    expect(getChangelogSnapshot('zh-CN').entries).toEqual(
      getChangelogSnapshot('en').entries,
    );
    expect(readLocaleCache('zh-CN')['content']).toBe('## CLI 0.9.0\n旧中文\n');
  });

  it('reselects the current-version fallback while a localized fetch is in flight', async () => {
    const english = '## CLI 1.0.0\nCurrent English\n';
    const staleChinese = '## CLI 0.9.0\n旧中文缓存\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: Date.now(), cliVersion: '1.0.0', content: english },
        'zh-CN': {
          fetchedAt: Date.now(),
          cliVersion: '0.9.0',
          content: staleChinese,
        },
      },
    });
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe(
      '旧中文缓存',
    );
    let resolveChinese: ((content: string) => void) | undefined;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveChinese = resolve;
          }),
      ),
    });

    const task = fetchChangelogForLocale('zh-CN');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(getChangelogSnapshot('zh-CN')).toMatchObject({
      entries: [expect.objectContaining({ content: 'Current English' })],
      status: 'refreshing',
    });

    resolveChinese?.('## CLI 1.0.0\n当前中文\n');
    await task;
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe('当前中文');
  });

  it('falls back to the entire English snapshot when Chinese current-version content is empty', async () => {
    const english = '## CLI 1.0.0\nEnglish notes\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: Date.now(), cliVersion: '1.0.0', content: english },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 1.0.0\n'),
    });

    await fetchChangelogForLocale('zh-CN');

    expect(getChangelogSnapshot('zh-CN').entries).toEqual(
      getChangelogSnapshot('en').entries,
    );
    expect(readCache()).toEqual({
      schemaVersion: 2,
      byLocale: {
        en: expect.objectContaining({ content: english }),
      },
    });
  });

  it('rejects a fresh Chinese cache with empty current-version content', async () => {
    const english = '## CLI 1.0.0\nEnglish notes\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: Date.now(), cliVersion: '1.0.0', content: english },
        'zh-CN': {
          fetchedAt: Date.now(),
          cliVersion: '1.0.0',
          content: '## CLI 1.0.0\n',
        },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Unavailable',
      text: vi.fn(),
    });

    await fetchChangelogForLocale('zh-CN');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getChangelogSnapshot('zh-CN').entries).toEqual(
      getChangelogSnapshot('en').entries,
    );
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe(
      'English notes',
    );
  });

  it('persists English fallback after a successful first Chinese fetch', async () => {
    const english = '## CLI 1.0.0\nEnglish notes\n';
    const chinese = '## CLI 1.0.0\n中文更新\n';
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi
        .fn()
        .mockResolvedValue(url.endsWith('changelog-zh-CN') ? chinese : english),
    }));

    await fetchChangelogForLocale('zh-CN');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readLocaleCache('zh-CN')['content']).toBe(chinese);
    expect(readLocaleCache('en')['content']).toBe(english);
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe('中文更新');
  });

  it('backfills English when only a fresh Chinese cache exists', async () => {
    const chinese = '## CLI 1.0.0\n中文缓存\n';
    const english = '## CLI 1.0.0\nEnglish notes\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        'zh-CN': {
          fetchedAt: Date.now(),
          cliVersion: '1.0.0',
          content: chinese,
        },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue(english),
    });

    await fetchChangelogForLocale('zh-CN');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cdn.example.test/qwencode/changelog',
      undefined,
    );
    expect(readLocaleCache('en')['content']).toBe(english);
    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe('中文缓存');
  });

  it('ignores malformed v2 locale entries and replaces them with a valid fetch', async () => {
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: 'not-a-number', content: ['broken'] },
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 1.0.0\nRecovered\n'),
    });

    await fetchChangelog('en');

    expect(getChangelogSnapshot('en').entries[0]?.content).toBe('Recovered');
    expect(readLocaleCache('en')['content']).toContain('Recovered');
  });

  it('tracks freshness independently and deduplicates refreshes per locale', async () => {
    const english = '## CLI 1.0.0\nEnglish notes\n';
    const chinese = '## CLI 1.0.0\n中文更新\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: Date.now(), cliVersion: '1.0.0', content: english },
        'zh-CN': {
          fetchedAt: Date.now() - 5 * 60 * 60 * 1000,
          cliVersion: '1.0.0',
          content: chinese,
        },
      },
    });
    let resolveText: ((value: string) => void) | undefined;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveText = resolve;
          }),
      ),
    });

    const first = fetchChangelogForLocale('zh-CN');
    const second = fetchChangelogForLocale('zh-CN');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveText?.('## CLI 1.0.0\n新中文\n');
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchChangelog('en');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readLocaleCache('en')['content']).toBe(english);
    expect(readLocaleCache('zh-CN')['content']).toContain('新中文');
  });

  it('keeps snapshot references stable until content or status is published', async () => {
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: {
          fetchedAt: Date.now(),
          cliVersion: '1.0.0',
          content: oldChangelog,
        },
      },
    });
    const first = getChangelogSnapshot('en');
    expect(getChangelogSnapshot('en')).toBe(first);

    await fetchChangelog('en');

    const ready = getChangelogSnapshot('en');
    expect(ready).not.toBe(first);
    expect(getChangelogSnapshot('en')).toBe(ready);
  });

  it('publishes the newer disk winner when another process writes during fetch', async () => {
    const otherProcess = '## CLI 1.0.0\nNewer process notes\n';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockImplementation(async () => {
        writeCache({
          schemaVersion: 2,
          byLocale: {
            en: {
              fetchedAt: Date.now() + 60_000,
              cliVersion: '1.0.0',
              content: otherProcess,
            },
          },
        });
        return '## CLI 1.0.0\nOlder local response\n';
      }),
    });

    await fetchChangelog('en');

    expect(getChangelogSnapshot('en').entries[0]?.content).toBe(
      'Newer process notes',
    );
    expect(readLocaleCache('en')['content']).toBe(otherProcess);
  });

  it('does not let a newer invalid disk entry replace a valid network response', async () => {
    const network = '## CLI 1.0.0\nValid network notes\n';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockImplementation(async () => {
        writeCache({
          schemaVersion: 2,
          byLocale: {
            en: {
              fetchedAt: Date.now() + 60_000,
              cliVersion: '1.0.0',
              content: '## CLI 1.0.0\n',
            },
          },
        });
        return network;
      }),
    });

    await fetchChangelog('en');

    expect(getChangelogSnapshot('en').entries[0]?.content).toBe(
      'Valid network notes',
    );
    expect(readLocaleCache('en')['content']).toBe(network);
  });

  it('publishes a valid network response when persistence fails beside a newer invalid memory entry', async () => {
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: {
          fetchedAt: Date.now() + 60_000,
          cliVersion: '1.0.0',
          content: '## CLI 1.0.0\n',
        },
      },
    });
    const network = '## CLI 1.0.0\nValid network notes\n';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue(network),
    });
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });

    try {
      await fetchChangelog('en');
    } finally {
      renameSpy.mockRestore();
    }

    expect(getChangelogSnapshot('en').entries[0]?.content).toBe(
      'Valid network notes',
    );
  });

  it('runs a queued force refresh after an in-flight normal cache check', async () => {
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: {
          fetchedAt: Date.now(),
          cliVersion: '1.0.0',
          content: oldChangelog,
        },
      },
    });
    let resolveVersion: ((version: string) => void) | undefined;
    getVersion
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveVersion = resolve;
          }),
      )
      .mockResolvedValue('1.0.0');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 1.0.0\nForced notes\n'),
    });

    const normal = fetchChangelog('en');
    const forced = refreshChangelog('en');
    resolveVersion?.('1.0.0');
    await Promise.all([normal, forced]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getChangelogSnapshot('en').entries[0]?.content).toBe('Forced notes');
  });

  it('deduplicates concurrent force refreshes for one locale', async () => {
    let resolveText: ((content: string) => void) | undefined;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveText = resolve;
          }),
      ),
    });

    const first = refreshChangelog('en');
    const second = refreshChangelog('en');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveText?.('## CLI 1.0.0\nForced once\n');
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('isolates listener errors while a queued force refresh succeeds', async () => {
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: {
          fetchedAt: Date.now(),
          cliVersion: '1.0.0',
          content: oldChangelog,
        },
      },
    });
    let resolveVersion: ((version: string) => void) | undefined;
    getVersion
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveVersion = resolve;
          }),
      )
      .mockResolvedValue('1.0.0');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 1.0.0\nForced after error\n'),
    });
    const unsubscribeFailing = subscribeChangelog(() => {
      throw new Error('listener failed');
    });
    const laterListener = vi.fn();
    const unsubscribeLater = subscribeChangelog(laterListener);

    const normal = fetchChangelog('en');
    const forced = refreshChangelog('en');
    resolveVersion?.('1.0.0');
    await Promise.all([normal, forced]);
    unsubscribeFailing();
    unsubscribeLater();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(laterListener).toHaveBeenCalled();
    expect(getChangelogSnapshot('en')).toMatchObject({
      entries: [expect.objectContaining({ content: 'Forced after error' })],
      status: 'ready',
    });
    expect(runLogger.warn).toHaveBeenCalledWith(
      'Changelog listener failed:',
      expect.any(Error),
    );
  });

  it('runs different locale refresh states independently', async () => {
    const english = '## CLI 1.0.0\nCached English\n';
    writeCache({
      schemaVersion: 2,
      byLocale: {
        en: { fetchedAt: Date.now(), cliVersion: '1.0.0', content: english },
      },
    });
    let resolveEnglish: ((content: string) => void) | undefined;
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn(() => {
        if (url.endsWith('changelog-zh-CN')) {
          return Promise.resolve('## CLI 1.0.0\n独立中文\n');
        }
        return new Promise<string>((resolve) => {
          resolveEnglish = resolve;
        });
      }),
    }));

    const englishTask = refreshChangelog('en');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await refreshChangelog('zh-CN');

    expect(getChangelogSnapshot('zh-CN').entries[0]?.content).toBe('独立中文');
    resolveEnglish?.('## CLI 1.0.0\nFresh English\n');
    await englishTask;
  });

  it('starts a new force refresh after the previous task completes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: vi.fn().mockResolvedValue('## CLI 1.0.0\nForced notes\n'),
    });

    await refreshChangelog('en');
    await refreshChangelog('en');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
