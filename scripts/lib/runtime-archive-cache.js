/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const UNUSED_ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Returns the bytes at `url` once `digest` of them equals `expected`. With a
 * `cacheDir`, a copy there is used only if it matches, and a fresh download is
 * written back. The cache only saves time: no cache failure reaches the caller.
 */
export async function fetchVerifiedArchive(
  url,
  filename,
  { digest, expected },
  {
    cacheDir,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const cached = cacheDir && path.join(cacheDir, filename);
  if (cached) {
    try {
      const bytes = fs.readFileSync(cached);
      if (digest(bytes) === expected) {
        console.log(`runtime archive reused from cache: ${cached}`);
        markUsed(cached);
        return bytes;
      }
      // Replaced by the download below.
      console.log(`runtime archive in cache failed verification: ${cached}`);
    } catch {
      // Not cached yet, or unreadable: download it below.
    }
  }
  let bytes;
  for (let attempt = 1; !bytes; attempt++) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(300_000),
      });
      assert.equal(
        response.status,
        200,
        `runtime download: ${url} returned ${response.status}`,
      );
      const body = Buffer.from(await response.arrayBuffer());
      // Verified per attempt: a truncated or stale body is retried like a
      // failed request.
      const actual = digest(body);
      assert(
        actual === expected,
        `runtime archive digest mismatch: ${url} is ${actual}, pinned ${expected}`,
      );
      bytes = body;
    } catch (error) {
      if (attempt === 3) throw error;
      // undici reports only "fetch failed"; the cause says why.
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? ` (cause: ${error.cause.message})`
          : '';
      console.log(
        `runtime download attempt ${attempt} failed: ${error}${cause}`,
      );
      await sleep(attempt * 5_000);
    }
  }
  if (cached) {
    // Rename into place so a concurrent job never reads a partial file.
    const partial = `${cached}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(partial, bytes);
      fs.renameSync(partial, cached);
      console.log(`runtime archive cached: ${cached}`);
    } catch (error) {
      try {
        fs.rmSync(partial, { force: true });
      } catch {
        // A directory that refused the write can refuse the cleanup too.
      }
      console.log(`runtime archive not cached: ${error}`);
    }
  }
  return bytes;
}

function markUsed(file) {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    // The sweep below also spares the archives a run names as used.
  }
}

/**
 * Removes what no run has used for a week: archives that only other revisions
 * pin, and partial files a killed run left behind. Call it once a run has
 * fetched every archive it needs, naming them in `used`; until then, an
 * archive the run fetches later may look just as unused. Each fetch marks its
 * archive as used, so revisions still running keep theirs, and an in-flight
 * partial file is always newer than a week.
 */
export function sweepRuntimeCache(cacheDir, used) {
  let entries;
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (used.includes(entry)) continue;
    try {
      const file = path.join(cacheDir, entry);
      // Another job may have removed it since the listing.
      const stats = fs.statSync(file, { throwIfNoEntry: false });
      if (stats?.isFile() && now - stats.mtimeMs > UNUSED_ENTRY_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Sweeping only saves space; an entry it cannot remove does not stop
      // it from removing the rest.
    }
  }
}
