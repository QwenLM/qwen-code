/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Returns the bytes at `url` once `verified` accepts them. With a `cacheDir`,
 * a copy there is used only if it verifies, and a fresh download is written
 * back. The cache only saves time: no cache failure reaches the caller.
 */
export async function fetchVerifiedArchive(
  url,
  filename,
  verified,
  { cacheDir, fetchImpl = fetch } = {},
) {
  const cached = cacheDir && path.join(cacheDir, filename);
  if (cached) {
    try {
      const bytes = fs.readFileSync(cached);
      // A mismatching copy is replaced by the download below.
      if (verified(bytes)) return bytes;
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
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw error;
      console.log(`runtime download attempt ${attempt} failed: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    }
  }
  assert(verified(bytes), `runtime archive digest mismatch: ${url}`);
  if (cached) {
    // Rename into place so a concurrent job never reads a partial file.
    const partial = `${cached}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(partial, bytes);
      fs.renameSync(partial, cached);
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
