/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  Storage,
  runLogger,
  getVersion,
  unmanagedRequest,
  type UiLocale,
} from '@qwen-code/core';
import { CHANGELOG_URL, CHANGELOG_ZH_CN_URL } from './changelogUrls.js';
import { eq, valid } from 'semver';
import { lock } from 'proper-lockfile';

// ── Types ──────────────────────────────────────────────────────────────────

/** A single parsed version entry from the changelog. */
export interface VersionEntry {
  /** Version string, e.g. "0.1.2" */
  version: string;
  /** Markdown content for that version (everything below the header) */
  content: string;
}

export interface ChangelogSnapshot {
  /** Parsed changelog entries, newest first. */
  entries: readonly VersionEntry[];
  /** Version of the first changelog entry. */
  latestVersion?: string;
  /** CLI version that fetched the persisted cache. */
  cliVersion?: string;
  /** Epoch ms when the persisted cache was fetched. */
  fetchedAt?: number;
  /** Current refresh state for this process. */
  status: 'idle' | 'refreshing' | 'ready' | 'error';
}

type ChangelogListener = () => void;

/** Schema for the cached changelog file on disk. */
interface ChangelogCacheEntry {
  /** Epoch ms when the changelog was fetched */
  fetchedAt: number;
  /** CLI version that fetched this cache. Missing for legacy caches. */
  cliVersion?: string;
  /** Raw changelog text (markdown) */
  content: string;
}

interface ChangelogCacheV2 {
  schemaVersion: 2;
  byLocale: Partial<Record<UiLocale, ChangelogCacheEntry>>;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** How long a cached changelog stays fresh (4 hours). */
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

/** HTTP request timeout for fetching changelog (10 s). */
const FETCH_TIMEOUT_MS = 10_000;

const EMPTY_ENTRIES: readonly VersionEntry[] = [];

let cacheByLocale: Partial<Record<UiLocale, ChangelogCacheEntry>> | undefined;
const snapshots = new Map<UiLocale, ChangelogSnapshot>();
interface ChangelogRefreshState {
  initialForce: boolean;
  forceRequested: boolean;
  promise?: Promise<void>;
}

const refreshStates = new Map<UiLocale, ChangelogRefreshState>();
const listeners = new Set<ChangelogListener>();
let activeCliVersion: string | undefined;

// ── Paths ──────────────────────────────────────────────────────────────────

function getCacheDir(): string {
  return path.join(Storage.getGlobalConfigDir(), 'cache');
}

function getCachePath(): string {
  return path.join(getCacheDir(), 'changelog.json');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function readCacheEntry(value: unknown): ChangelogCacheEntry | undefined {
  if (!isPlainRecord(value)) return undefined;
  const fetchedAt = value['fetchedAt'];
  const content = value['content'];
  const cliVersion = value['cliVersion'];
  if (
    typeof fetchedAt !== 'number' ||
    !Number.isFinite(fetchedAt) ||
    typeof content !== 'string' ||
    (cliVersion !== undefined && typeof cliVersion !== 'string')
  ) {
    return undefined;
  }
  return {
    fetchedAt,
    cliVersion,
    content,
  };
}

// ── Cache helpers ──────────────────────────────────────────────────────────

function readCache(): Partial<Record<UiLocale, ChangelogCacheEntry>> {
  try {
    const raw = fs.readFileSync(getCachePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isPlainRecord(parsed) && parsed['schemaVersion'] === 2) {
      const byLocale = isPlainRecord(parsed['byLocale'])
        ? parsed['byLocale']
        : {};
      const result: Partial<Record<UiLocale, ChangelogCacheEntry>> = {};
      for (const locale of ['en', 'zh-CN'] as const) {
        const entry = readCacheEntry(byLocale[locale]);
        if (entry) result[locale] = entry;
      }
      return result;
    }
    const legacy = readCacheEntry(parsed);
    if (legacy?.content) return { en: legacy };
  } catch {
    // Cache miss or corrupt — that's fine
  }
  return {};
}

function normalizeCliVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^v(?=\d)/i, '');
}

/**
 * Find the changelog entry for the running CLI version. Unknown/non-semver
 * versions fall back to the newest entry so development builds keep showing
 * cached release notes.
 */
export function findChangelogEntryForCliVersion(
  entries: readonly VersionEntry[],
  currentCliVersion: string | undefined,
): VersionEntry | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const normalizedCurrent = normalizeCliVersion(currentCliVersion);
  const current = normalizedCurrent ? valid(normalizedCurrent) : null;
  if (!current) {
    return entries[0];
  }

  return entries.find((entry) => {
    const normalizedEntry = normalizeCliVersion(entry.version);
    const entryVersion = normalizedEntry ? valid(normalizedEntry) : null;
    return entryVersion ? eq(entryVersion, current) : false;
  });
}

async function getCurrentCliVersion(): Promise<string | undefined> {
  try {
    return normalizeCliVersion(await getVersion());
  } catch (e) {
    runLogger.warn('Failed to resolve CLI version for changelog cache:', e);
    return undefined;
  }
}

function isCacheFreshForCurrentVersion(
  cached: ChangelogCacheEntry,
  currentCliVersion: string | undefined,
): boolean {
  if (Date.now() - cached.fetchedAt >= CACHE_TTL_MS) {
    return false;
  }

  if (
    currentCliVersion &&
    normalizeCliVersion(cached.cliVersion) !== currentCliVersion
  ) {
    return false;
  }

  return hasCacheEntryForVersion(cached, currentCliVersion);
}

function createCache(
  content: string,
  cliVersion: string | undefined,
): ChangelogCacheEntry {
  return {
    fetchedAt: Date.now(),
    cliVersion: normalizeCliVersion(cliVersion),
    content,
  };
}

function selectNewestCache(
  candidates: ReadonlyArray<ChangelogCacheEntry | undefined>,
): ChangelogCacheEntry | undefined {
  const existing = candidates.filter(
    (value): value is ChangelogCacheEntry => value !== undefined,
  );
  const displayable = existing.filter(isCacheDisplayable);
  return (displayable.length > 0 ? displayable : existing).sort(
    (left, right) => right.fetchedAt - left.fetchedAt,
  )[0];
}

function mergeCacheFromDisk(): void {
  const disk = readCache();
  const merged: Partial<Record<UiLocale, ChangelogCacheEntry>> = {};
  for (const locale of ['en', 'zh-CN'] as const) {
    const winner = selectNewestCache([disk[locale], cacheByLocale?.[locale]]);
    if (winner) merged[locale] = winner;
  }
  cacheByLocale = merged;
}

async function mergeAndWriteCache(
  locale: UiLocale,
  entry: ChangelogCacheEntry,
): Promise<ChangelogCacheEntry> {
  let release: (() => Promise<void>) | undefined;
  let winner = entry;
  try {
    const dir = getCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const lockTarget = path.join(dir, 'changelog.lock');
    fs.closeSync(fs.openSync(lockTarget, 'a'));
    release = await lock(lockTarget, {
      realpath: false,
      retries: { retries: 3, minTimeout: 10, maxTimeout: 50 },
    });
    const disk = readCache();
    const byLocale: Partial<Record<UiLocale, ChangelogCacheEntry>> = {};
    for (const candidateLocale of ['en', 'zh-CN'] as const) {
      const existing = selectNewestCache([
        disk[candidateLocale],
        cacheByLocale?.[candidateLocale],
      ]);
      const winnerForLocale =
        candidateLocale === locale &&
        isCacheDisplayable(entry) &&
        (!existing ||
          !isCacheDisplayable(existing) ||
          entry.fetchedAt >= existing.fetchedAt)
          ? entry
          : existing;
      if (winnerForLocale) byLocale[candidateLocale] = winnerForLocale;
    }
    winner = byLocale[locale] ?? entry;
    const cache: ChangelogCacheV2 = { schemaVersion: 2, byLocale };
    const temporaryPath = `${getCachePath()}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(cache), 'utf-8');
    fs.renameSync(temporaryPath, getCachePath());
    cacheByLocale = byLocale;
  } catch (e) {
    runLogger.warn('Failed to write changelog cache:', e);
    const existing = cacheByLocale?.[locale];
    winner =
      existing &&
      isCacheDisplayable(existing) &&
      existing.fetchedAt > entry.fetchedAt
        ? existing
        : entry;
    cacheByLocale = { ...cacheByLocale, [locale]: winner };
  } finally {
    await release?.().catch(() => {});
  }
  return winner;
}

function snapshotFromCache(
  cached: ChangelogCacheEntry | undefined,
  status: ChangelogSnapshot['status'],
): ChangelogSnapshot {
  if (!cached) {
    return {
      entries: EMPTY_ENTRIES,
      status,
    };
  }

  const entries = parseChangelog(cached.content);
  return {
    entries,
    latestVersion: entries[0]?.version,
    cliVersion: normalizeCliVersion(cached.cliVersion),
    fetchedAt: cached.fetchedAt,
    status,
  };
}

function ensureCacheLoaded(): void {
  cacheByLocale ??= readCache();
}

function selectEffectiveCache(
  locale: UiLocale,
  currentCliVersion: string | undefined = activeCliVersion,
): ChangelogCacheEntry | undefined {
  ensureCacheLoaded();
  const localized = cacheByLocale?.[locale];
  const english = cacheByLocale?.en;
  if (localized && hasCacheEntryForVersion(localized, currentCliVersion)) {
    return localized;
  }
  if (english && hasCacheEntryForVersion(english, currentCliVersion)) {
    return english;
  }
  if (localized && isCacheDisplayable(localized)) {
    return localized;
  }
  return english && isCacheDisplayable(english) ? english : undefined;
}

function isCacheDisplayable(cached: ChangelogCacheEntry): boolean {
  return parseChangelog(cached.content).some(
    (entry) => entry.content.trim().length > 0,
  );
}

function hasCacheEntryForVersion(
  cached: ChangelogCacheEntry,
  currentCliVersion: string | undefined,
): boolean {
  if (!currentCliVersion) return isCacheDisplayable(cached);
  const entries = parseChangelog(cached.content);
  const selected = findChangelogEntryForCliVersion(entries, currentCliVersion);
  return selected !== undefined && selected.content.trim().length > 0;
}

function getOrCreateSnapshot(locale: UiLocale): ChangelogSnapshot {
  let snapshot = snapshots.get(locale);
  if (!snapshot) {
    snapshot = snapshotFromCache(selectEffectiveCache(locale), 'idle');
    snapshots.set(locale, snapshot);
  }
  return snapshot;
}

function publishSnapshot(locale: UiLocale, next: ChangelogSnapshot): void {
  snapshots.set(locale, next);
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      runLogger.warn('Changelog listener failed:', error);
    }
  }
}

function setSnapshotStatus(
  locale: UiLocale,
  status: ChangelogSnapshot['status'],
): void {
  const current = getOrCreateSnapshot(locale);
  if (current.status === status) {
    return;
  }
  publishSnapshot(locale, { ...current, status });
}

// ── Fetch ──────────────────────────────────────────────────────────────────

export function getChangelogUrl(locale: UiLocale): string {
  return locale === 'zh-CN' ? CHANGELOG_ZH_CN_URL : CHANGELOG_URL;
}

async function doFetch(
  locale: UiLocale,
  cliVersion: string | undefined,
  url: string,
): Promise<boolean> {
  const response = await unmanagedRequest(url, undefined, {
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  if (!response.ok) {
    runLogger.warn(
      `Changelog fetch failed: ${response.status} ${response.statusText}`,
    );
    setSnapshotStatus(locale, 'error');
    return false;
  }

  const text = await response.text();
  const cache = createCache(text, cliVersion);
  if (isCacheDisplayable(cache)) {
    ensureCacheLoaded();
    const winner = await mergeAndWriteCache(locale, cache);
    // Publish even when persistence fails: the current session can still use
    // the successfully fetched release notes.
    const effective = selectEffectiveCache(locale, cliVersion) ?? winner;
    publishSnapshot(locale, snapshotFromCache(effective, 'ready'));
    if (locale === 'en') {
      const chineseSnapshotCache = selectEffectiveCache('zh-CN', cliVersion);
      publishSnapshot(
        'zh-CN',
        snapshotFromCache(
          chineseSnapshotCache,
          chineseSnapshotCache ? 'ready' : 'error',
        ),
      );
    }
    runLogger.log('Changelog fetched and cached successfully');
    return true;
  } else {
    setSnapshotStatus(locale, 'error');
    return false;
  }
}

/** Resolve language-specific requests here; lower layers receive one URL only. */
export async function fetchChangelogForLocale(
  locale: UiLocale = 'en',
  getUrl: typeof getChangelogUrl = getChangelogUrl,
  force = false,
): Promise<void> {
  const request = force ? refreshChangelog : fetchChangelog;
  await request(locale, getUrl(locale));
  if (
    locale === 'zh-CN' &&
    !(
      cacheByLocale?.en &&
      hasCacheEntryForVersion(cacheByLocale.en, activeCliVersion)
    )
  ) {
    await fetchChangelog('en', getUrl('en'));
    const fallback = selectEffectiveCache(locale);
    publishSnapshot(
      locale,
      snapshotFromCache(fallback, fallback ? 'ready' : 'error'),
    );
  }
}

/** Fetch one language from the supplied URL and update its cache. */
export async function fetchChangelog(
  locale: UiLocale = 'en',
  url: string = getChangelogUrl(locale),
): Promise<void> {
  return scheduleChangelogFetch(locale, false, url);
}

function scheduleChangelogFetch(
  locale: UiLocale,
  force: boolean,
  url: string,
): Promise<void> {
  const inFlight = refreshStates.get(locale);
  if (inFlight?.promise) {
    if (force && !inFlight.initialForce) {
      inFlight.forceRequested = true;
    }
    return inFlight.promise;
  }

  const state: ChangelogRefreshState = {
    initialForce: force,
    forceRequested: false,
  };
  const task = (async () => {
    let initialFailed = false;
    let initialError: unknown;
    try {
      try {
        await fetchChangelogInternal(locale, force, url);
      } catch (error) {
        initialFailed = true;
        initialError = error;
      }
      if (!force && state.forceRequested) {
        await fetchChangelogInternal(locale, true, url);
      }
      if (initialFailed) {
        throw initialError;
      }
    } finally {
      if (refreshStates.get(locale) === state) {
        refreshStates.delete(locale);
      }
    }
  })();
  state.promise = task;
  refreshStates.set(locale, state);
  return task;
}

async function fetchChangelogInternal(
  locale: UiLocale,
  force: boolean,
  url: string,
): Promise<void> {
  const currentCliVersion = await getCurrentCliVersion();
  activeCliVersion = currentCliVersion;
  mergeCacheFromDisk();
  const cached = cacheByLocale?.[locale];
  if (
    !force &&
    cached &&
    isCacheFreshForCurrentVersion(cached, currentCliVersion)
  ) {
    // Keep the process snapshot aligned with the persisted cache in case
    // another process refreshed it after this process first read the file.
    const effective = selectEffectiveCache(locale, currentCliVersion);
    publishSnapshot(locale, snapshotFromCache(effective, 'ready'));
    runLogger.log('Changelog cache is still fresh, skipping fetch');
    return;
  }

  const effective = selectEffectiveCache(locale, currentCliVersion);
  publishSnapshot(locale, snapshotFromCache(effective, 'refreshing'));
  let fetchSucceeded = false;
  try {
    fetchSucceeded = await doFetch(locale, currentCliVersion, url);
  } catch (e) {
    setSnapshotStatus(locale, 'error');
    runLogger.warn('Changelog fetch error:', e);
  }
  if (!fetchSucceeded) {
    const fallback = selectEffectiveCache(locale, currentCliVersion);
    publishSnapshot(
      locale,
      snapshotFromCache(fallback, fallback ? 'ready' : 'error'),
    );
  }
}

/**
 * Force-refresh the changelog cache, bypassing the TTL check.
 * Called after a successful auto-update so the user sees the new release notes
 * immediately without waiting for the 4-hour cache to expire.
 */
export async function refreshChangelog(
  locale: UiLocale = 'en',
  url: string = getChangelogUrl(locale),
): Promise<void> {
  return scheduleChangelogFetch(locale, true, url);
}

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse changelog markdown into version entries.
 *
 * The expected format is:
 * ```
 * ## CLI 0.3.0
 * ... content ...
 *
 * ## CLI 0.2.1
 * ... content ...
 * ```
 *
 * Version sections are identified by their CLI heading.
 */
export function parseChangelog(content: string): VersionEntry[] {
  const entries: VersionEntry[] = [];
  const lines = content.split(/\r?\n/);

  let currentVersion: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## CLI ')) {
      // Save the previous version entry
      if (currentVersion !== null) {
        entries.push({
          version: currentVersion,
          content: currentContent.join('\n').trim(),
        });
        currentContent = [];
      }
      currentVersion = line.slice('## CLI '.length).trim();
    } else if (currentVersion !== null) {
      currentContent.push(line);
    }
  }

  // Don't forget the last version entry
  if (currentVersion !== null) {
    entries.push({
      version: currentVersion,
      content: currentContent.join('\n').trim(),
    });
  }

  return entries;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Subscribe to changelog changes in the current process.
 */
export function subscribeChangelog(listener: ChangelogListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Return the referentially stable changelog snapshot for React consumers. */
export function getChangelogSnapshot(
  locale: UiLocale = 'en',
): ChangelogSnapshot {
  return getOrCreateSnapshot(locale);
}

/**
 * Load version entries from the current process snapshot.
 * Returns an empty array if no cache exists yet.
 */
export function loadCachedVersionEntries(): VersionEntry[] {
  return [...getChangelogSnapshot('en').entries];
}

/** Reset module state between tests that use different cache directories. */
export function _resetChangelogSnapshotForTest(): void {
  cacheByLocale = undefined;
  snapshots.clear();
  refreshStates.clear();
  listeners.clear();
  activeCliVersion = undefined;
}
