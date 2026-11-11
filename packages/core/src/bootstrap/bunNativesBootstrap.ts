/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extracts embedded native modules out of a Bun-compiled binary so that
 * dlopen can load them.
 *
 * Background: `bun build --compile` embeds files imported via
 * `with { type: 'file' }` into the binary's /$bunfs/ virtual FS. Bun transparently
 * extracts those files when `Bun.spawn()` executes them, but `require('.node')`
 * ends up calling `dlopen()`, which is a libc-level call that doesn't know
 * about /$bunfs/ — it wants a real path. So we mirror the embedded native
 * tree out to disk before anything tries to require sharp or node-pty.
 *
 * This module must be imported as the FIRST import of the CLI entry
 * (packages/cli/index.ts). It's a no-op outside Bun-compiled mode.
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

import { BRAND_CLI_BIN, BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';
import { EMBEDDED_NATIVES } from '../generated/embedded-natives-bun.js';
import { isInBundledMode, isStandaloneBinary } from '../utils/bundledMode.js';
import { BUN_NATIVE_EXTRACTION_FAILURE_MARKER } from './bunNativesConstants.js';

const ENV_DEBUG_NATIVES = `${BRAND_FIXED_ENV_PREFIX}CLI_DEBUG_NATIVES`;

/**
 * Marker written at the root of a fully-extracted runtime dir. Its content is
 * the extraction key — if the key matches on next startup we skip re-extraction.
 * We use a content-derived key (hash of the embedded manifest) so a new binary
 * build always invalidates the cache, even within the same CLI_VERSION.
 */
const READY_MARKER = '.ready';

function getSafeName(name: string): string {
  return (name || 'unknown').toString().replace(/[^a-zA-Z0-9.-]/g, '_');
}

function computeExtractionKey(): string {
  // Hash the set of (relKey, mode) tuples plus the embedded file path. The
  // path is a /$bunfs/... string that Bun generates deterministically from
  // the binary's content hash — so two distinct builds produce different
  // keys even if the source files were identical.
  const hash = createHash('sha256');
  const keys = Object.keys(EMBEDDED_NATIVES).sort();
  for (const key of keys) {
    const entry = EMBEDDED_NATIVES[key];
    hash.update(`${key}\0${entry.path}\0${entry.mode}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

function isSecureDir(dir: string, expectedUid: number | 'unknown'): boolean {
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return false;
    if (expectedUid !== 'unknown' && st.uid !== expectedUid) return false;
    // Windows mode bits are unreliable; only enforce 0700 on POSIX.
    if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractAll(runtimeDir: string, key: string): void {
  // Extract into a pid-scoped temp dir first, then rename atomically onto the
  // real location. If two processes race, the loser's rename fails and it
  // falls through to reuse the winner's tree. Any other failure propagates to
  // ensureNativesExtracted, which retries with backoff and finally falls back
  // to a process-private directory.
  const tmpBase = path.dirname(runtimeDir);
  const setupDir = path.join(
    tmpBase,
    `.setup-${path.basename(runtimeDir)}-${process.pid}-${Date.now()}`,
  );

  mkdirSync(setupDir, { recursive: true, mode: 0o700 });
  try {
    // Keys in EMBEDDED_NATIVES already include their runtime-root-relative
    // prefix (node_modules/... for sharp/pty; vendor/... for ripgrep), so we
    // write directly under setupDir without further namespacing.
    for (const [relKey, entry] of Object.entries(EMBEDDED_NATIVES)) {
      const destPath = path.join(setupDir, relKey);
      mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
      // readFileSync on a /$bunfs/ path returns a Buffer backed by the
      // embedded blob. On darwin/linux we chmod to preserve the exec bit so
      // spawn-helper, vendor rg, and any .so/.dylib/.node file retain mode.
      const buf = readFileSync(entry.path);
      writeFileSync(destPath, buf, { mode: entry.mode });
      if (process.platform !== 'win32') {
        chmodSync(destPath, entry.mode);
      }
    }
    writeFileSync(path.join(setupDir, READY_MARKER), key, { mode: 0o600 });

    try {
      renameSync(setupDir, runtimeDir);
    } catch (err) {
      // Another process likely got there first; if their tree matches our
      // expected key we happily use it. Otherwise re-throw.
      const readyPath = path.join(runtimeDir, READY_MARKER);
      if (existsSync(readyPath) && safeReadText(readyPath) === key) {
        rmSync(setupDir, { recursive: true, force: true });
        return;
      }
      throw err;
    }
  } catch (err) {
    try {
      rmSync(setupDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

function safeReadText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The extraction root currently in use by this process (set once
 * extractAndHook / repairBunNativesRuntime succeeds). May differ from
 * getBunNativesRuntimeDir() when extraction fell back to a pid-scoped dir.
 */
let activeNativesDir: string | null = null;

/**
 * True when `dir` still holds a complete extraction for `key`: ownership and
 * permissions are intact, the ready marker matches, and every embedded file
 * is still present on disk. OS temp cleaners (e.g. macOS dirhelper purging
 * /var/folders by access time) can delete individual files while leaving the
 * directory and the marker behind, so checking the marker alone is not enough.
 */
function isNativesTreeIntact(
  dir: string,
  uid: number | 'unknown',
  key: string,
): boolean {
  if (!isSecureDir(dir, uid)) return false;
  if (safeReadText(path.join(dir, READY_MARKER)) !== key) return false;
  for (const relKey of Object.keys(EMBEDDED_NATIVES)) {
    if (!existsSync(path.join(dir, relKey))) return false;
  }
  return true;
}

/**
 * Directly resolve a bare specifier against the extracted node_modules tree,
 * implementing the subset of Node resolution we need (main / exports-field
 * with a string target / literal subpath fallback). Returns an absolute path
 * or null if nothing matched.
 *
 * We hand-roll this instead of delegating to require.resolve because Bun's
 * compiled-binary resolver loses the anchor-path context we tried to feed it
 * via createRequire — every attempt returned "from ''". The requests we need
 * to handle are narrow and deterministic (a few package families, no
 * conditional exports used by their native loaders), so the mini-resolver is
 * simpler than fighting Bun's internals.
 */
function resolveEmbeddedModule(
  request: string,
  nodeModulesRoot: string,
): string | null {
  const fsMod = createRequire(import.meta.url)(
    'node:fs',
  ) as typeof import('node:fs');

  const parts = request.split('/');
  let pkgName: string;
  let subpath: string | undefined;
  if (request.startsWith('@')) {
    if (parts.length < 2) return null;
    pkgName = `${parts[0]}/${parts[1]}`;
    subpath = parts.slice(2).join('/') || undefined;
  } else {
    pkgName = parts[0];
    subpath = parts.slice(1).join('/') || undefined;
  }

  const pkgDir = path.join(nodeModulesRoot, pkgName);
  if (!fsMod.existsSync(pkgDir)) return null;

  let pkgJson: {
    main?: string;
    exports?: Record<string, string | Record<string, string>>;
  } = {};
  try {
    pkgJson = JSON.parse(
      fsMod.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
    );
  } catch {
    // non-fatal; fall through
  }

  if (!subpath) {
    const main = pkgJson.main || 'index.js';
    const target = path.join(pkgDir, main);
    return fsMod.existsSync(target) ? target : null;
  }

  // Exports-field resolution: sharp-darwin-arm64 exports `"./sharp.node":
  // "./lib/sharp-darwin-arm64.node"`. Only handle string targets — none of
  // our embedded packages use conditional maps.
  if (pkgJson.exports && typeof pkgJson.exports === 'object') {
    const exportKey = `./${subpath}`;
    const entry = pkgJson.exports[exportKey];
    if (typeof entry === 'string') {
      const target = path.join(pkgDir, entry);
      if (fsMod.existsSync(target)) return target;
    }
  }

  // Literal subpath + extension probing for the few cases the exports field
  // doesn't cover (e.g. node-pty's `require('...spawn-helper')`).
  const direct = path.join(pkgDir, subpath);
  if (fsMod.existsSync(direct) && fsMod.statSync(direct).isFile()) {
    return direct;
  }
  for (const ext of ['.js', '.json', '.node']) {
    const withExt = direct + ext;
    if (fsMod.existsSync(withExt)) return withExt;
  }
  return null;
}

function hookResolver(extractedNodeModules: string): void {
  const debug = !!process.env[ENV_DEBUG_NATIVES];
  const log = (m: string) => {
    if (debug) process.stderr.write(`[natives-debug] ${m}\n`);
  };
  process.env['NODE_PATH'] = process.env['NODE_PATH']
    ? `${extractedNodeModules}${path.delimiter}${process.env['NODE_PATH']}`
    : extractedNodeModules;

  let Module: typeof import('node:module') | null = null;
  try {
    Module = createRequire(import.meta.url)('node:module');
  } catch (e) {
    log(`node:module load failed: ${(e as Error)?.message}`);
    return;
  }

  // @ts-expect-error _initPaths is internal.
  if (typeof Module._initPaths === 'function') {
    // @ts-expect-error _initPaths is internal.
    Module._initPaths();
  }

  // @ts-expect-error _resolveFilename is internal.
  const origResolve = Module._resolveFilename;
  if (typeof origResolve !== 'function') {
    log('no _resolveFilename to patch');
    return;
  }

  // @ts-expect-error _resolveFilename is internal.
  Module._resolveFilename = function patched(
    request: string,
    parent: unknown,
    isMain: boolean,
    options: unknown,
  ) {
    if (
      typeof request === 'string' &&
      (request.startsWith('@crosscopy/') ||
        request.startsWith('@img/') ||
        request.startsWith('@lydell/') ||
        request.startsWith('@silvia-odwyer/'))
    ) {
      const direct = resolveEmbeddedModule(request, extractedNodeModules);
      if (direct) {
        log(`resolved ${request} -> ${direct}`);
        return direct;
      }
      log(`could not resolve ${request} in extracted tree`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return origResolve.call(this, request, parent, isMain, options);
  };
}

/**
 * Returns the extraction root used when running as a Bun-compiled binary, or
 * null in dev / Node SEA modes. Consumers like ripgrep.ts look up files under
 * this dir (e.g. `vendor/ripgrep/<arch>-<os>/rg`) instead of relying on
 * sidecar paths that single-binary distributions don't ship.
 *
 * Pure — just composes the deterministic path; the directory may or may not
 * exist depending on whether extractAndHook ran successfully.
 */
export function getBunNativesRuntimeDir(): string | null {
  if (!isInBundledMode() || Object.keys(EMBEDDED_NATIVES).length === 0) {
    return null;
  }
  const version = process.env['CLI_VERSION'] || 'dev';
  const uid =
    typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const username = userInfo().username || process.env['USER'] || String(uid);
  return path.join(
    tmpdir(),
    `${BRAND_CLI_BIN}-natives-v${getSafeName(version)}-${getSafeName(username)}`,
  );
}

/**
 * Synchronous sleep for the bootstrap retry loop. This module runs before
 * anything async is set up (it must complete before the first
 * `require('sharp')`), so we block via Atomics.wait instead of timers.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable — busy-wait as a crude fallback.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * Fast path: if runtimeDir already holds a valid, complete tree for `key`,
 * return true. "Complete" includes every embedded file still existing on disk
 * — OS temp cleaners may delete individual .node files while keeping the
 * marker. Otherwise best-effort remove whatever is there (stale tree from an
 * old binary, a half-purged tree, or a dir that failed the security check) so
 * extractAll can rename onto a clean slot. On Windows the removal can silently
 * fail while another process holds a loaded .node DLL — the caller retries
 * with backoff.
 */
function tryReuseOrClear(
  runtimeDir: string,
  uid: number | 'unknown',
  key: string,
): boolean {
  if (isNativesTreeIntact(runtimeDir, uid, key)) return true;
  if (!existsSync(runtimeDir)) return false;
  // Dir exists but is stale, incomplete, or untrusted — wipe so the rename
  // can land.
  try {
    rmSync(runtimeDir, { recursive: true, force: true });
  } catch {
    // Swallowed; extractAll / the retry loop handles the consequences.
  }
  return false;
}

/**
 * Ensures a usable extracted-natives tree exists and returns its path, or
 * null if extraction failed everywhere.
 *
 * Windows intermittently fails the rmSync/renameSync pair with EPERM when the
 * shared runtime dir is held open by a concurrent CLI process (loaded .node
 * DLLs) or an antivirus scan. Those locks are transient, so we retry the
 * whole reuse-or-extract cycle a few times with backoff — a racing loser also
 * lands here and picks up the winner's tree on the next pass. If the shared
 * dir stays locked, we fall back to a process-private dir whose unique name
 * needs no rename and cannot collide.
 *
 * Exported for testing.
 */
export function ensureNativesExtracted(
  runtimeDir: string,
  uid: number | 'unknown',
  key: string,
): string | null {
  const maxAttempts = 3;
  const baseDelayMs = 100;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) sleepSync(baseDelayMs * (attempt - 1));
    if (tryReuseOrClear(runtimeDir, uid, key)) return runtimeDir;
    try {
      extractAll(runtimeDir, key);
      return runtimeDir;
    } catch {
      // Transient lock / lost race — loop and re-check the fast path.
    }
  }

  // Last resort: the shared dir is stuck (e.g. an old CLI process keeps its
  // DLLs mapped for its whole lifetime). Extract into a fresh pid-scoped dir;
  // its unique name makes the final rename collision-free. Costs a duplicate
  // tree in tmpdir, which the OS tmp cleaner reclaims later.
  const fallbackDir = `${runtimeDir}-p${process.pid}-${Date.now()}`;
  try {
    extractAll(fallbackDir, key);
    process.once('exit', () => {
      try {
        rmSync(fallbackDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; loaded DLLs may pin files until process death
      }
    });
    return fallbackDir;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[${BRAND_CLI_BIN}] Warning: ${BUN_NATIVE_EXTRACTION_FAILURE_MARKER}: ${msg}\n`,
    );
    return null;
  }
}

function extractAndHook(): void {
  const runtimeDir = getBunNativesRuntimeDir();
  if (!runtimeDir) return;
  const uid =
    typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const key = computeExtractionKey();

  // If extraction fails everywhere we still want the binary to run for
  // everything that doesn't need a native module. ensureNativesExtracted has
  // already logged a warning; the next `require('sharp')` will throw on its
  // own, with a more actionable error.
  const extractedDir = ensureNativesExtracted(runtimeDir, uid, key);
  if (!extractedDir) return;

  activeNativesDir = extractedDir;
  hookResolver(path.join(extractedDir, 'node_modules'));
}

/**
 * Re-validates the extracted natives tree while the process is running and
 * re-extracts it when files went missing (e.g. the OS temp cleaner purged
 * /var/folders or /tmp during a long-lived session). Returns the usable
 * runtime dir, or null when not in Bun-compiled mode or extraction failed.
 *
 * Consumers that lazily dlopen a native module long after startup (e.g. the
 * sharp image pipeline) must call this BEFORE their first require/import:
 * once a native load fails, the half-evaluated module is cached and every
 * later call fails with a cryptic minified TypeError ("T is not a function")
 * for the remainder of the process lifetime.
 */
export function repairBunNativesRuntime(): string | null {
  const runtimeDir = getBunNativesRuntimeDir();
  if (!runtimeDir) return null;
  const uid =
    typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  const key = computeExtractionKey();

  const current = activeNativesDir ?? runtimeDir;
  if (isNativesTreeIntact(current, uid, key)) return current;

  const extractedDir = ensureNativesExtracted(runtimeDir, uid, key);
  if (!extractedDir) return null;

  if (extractedDir !== activeNativesDir) {
    hookResolver(path.join(extractedDir, 'node_modules'));
    activeNativesDir = extractedDir;
  }
  return extractedDir;
}

/**
 * Bun-compiled binaries leave `process.stdout.isTTY` / `process.stdin.isTTY`
 * undefined even when the process is attached to a real terminal. Node's
 * `tty.isatty(fd)` works correctly in both runtimes, so we use it to backfill
 * the properties Ink / yargs / isHeadlessMode() rely on. Without this, the
 * CLI mistakenly treats every interactive launch as headless and prints
 * help instead of entering the TUI.
 *
 * Applies to all standalone binaries (Bun-compiled and Node SEA) since both
 * may fail to propagate isTTY when the process is launched without a script path.
 */
function polyfillIsTTY(): void {
  if (!isStandaloneBinary()) return;

  const tty = createRequire(import.meta.url)(
    'node:tty',
  ) as typeof import('node:tty');
  const probe = (fd: number): true | undefined =>
    tty.isatty(fd) ? true : undefined;
  if (process.stdin && process.stdin.isTTY === undefined) {
    // @ts-expect-error Node declares this as readonly; we're in polyfill territory.
    process.stdin.isTTY = probe(0);
  }
  if (process.stdout && process.stdout.isTTY === undefined) {
    // @ts-expect-error see above.
    process.stdout.isTTY = probe(1);
  }
  if (process.stderr && process.stderr.isTTY === undefined) {
    // @ts-expect-error see above.
    process.stderr.isTTY = probe(2);
  }
}

/**
 * Bun compile leaks the user's `NODE_OPTIONS` / `BUN_OPTIONS` env vars into
 * `process.argv` as real arguments — and duplicates the script path. Typical
 * shape on darwin when NODE_OPTIONS="--max-old-space-size=24576":
 *
 *   process.argv = [
 *     "bun",                              // argv[0]: host executable name
 *     "/$bunfs/root/index.js",            // argv[1]: compiled entry
 *     "--max-old-space-size=24576",       // leaked from NODE_OPTIONS
 *     "/$bunfs/root/index.js",            // ghost duplicate
 *     ...user args
 *   ]
 *
 * yargs with `.strict()` sees the NODE_OPTIONS flag as an unknown argument,
 * throws, the catch block calls `showHelp()` and the process exits — so the
 * CLI never enters interactive mode when run from a shell that has any
 * NODE_OPTIONS set. The SEA path (sea/sea-launch.cjs → sanitizeArgv) and the
 * release-tarball launcher both handle this; running the raw Bun binary
 * direct doesn't. Strip here so it just works.
 *
 * Strategy: find the LAST argv entry that looks like the compiled entry path
 * (/$bunfs/root/... on Unix, \\$bunfs\\... or B:/~BUN/... on Windows).
 * Everything between argv[1] and that position is runtime gunk; keep
 * argv[0] + the canonical script path + everything after it.
 */
function sanitizeBunArgv(): void {
  if (!isInBundledMode() || process.argv.length < 2) return;
  const isBunfs = (p: string | undefined): boolean =>
    !!p &&
    (p.startsWith('/$bunfs/') ||
      p.startsWith('\\$bunfs\\') ||
      /^[A-Za-z]:[/\\]~BUN[/\\]/.test(p));
  let lastScriptIdx = -1;
  for (let i = 1; i < process.argv.length; i++) {
    if (isBunfs(process.argv[i])) lastScriptIdx = i;
  }
  if (lastScriptIdx <= 1) return;
  const cleaned = [
    process.argv[0],
    process.argv[lastScriptIdx],
    ...process.argv.slice(lastScriptIdx + 1),
  ];
  process.argv.length = 0;
  process.argv.push(...cleaned);
}

sanitizeBunArgv();
polyfillIsTTY();

if (isInBundledMode() && Object.keys(EMBEDDED_NATIVES).length > 0) {
  extractAndHook();
}
