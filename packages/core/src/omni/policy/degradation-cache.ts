/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { OmniJsonCacheFile } from '../json-cache-file.js';
import { OBJECT_EXTENSION_RE } from '../storage.js';

/**
 * Identity of one degradation result (decision D2): everything the
 * orchestrator needs to reuse a previously transcoded derivative without
 * re-running the tool — the derived object's content hash (locating it in
 * `objects/`), the extension it was stored under (storage.ts convention:
 * leading dot), and the disclosure text that must accompany the lossy
 * derivative on every delivery.
 */
export interface DegradationCacheEntry {
  degradedSha256: string;
  /** Object-store extension INCLUDING the leading dot (".jpg"). */
  extension: string;
  /** Disclosure the tool emitted (D8) — redelivered verbatim on reuse. */
  disclosure: string;
  mimeType: string;
  /** `metadata.omniRole` the tool stamped on the artifact, when any —
   * without it a cache hit would strip the role a fresh derivation
   * carries, changing downstream artifact matching between the first run
   * and every cached rerun. */
  role?: string;
  createdAt: string;
}

/** Ceiling on a cached disclosure's length. Disclosures are one-line
 * summaries (tens of characters in practice); the cache file is
 * workspace-shippable, and an unbounded field served verbatim into
 * model-visible content would hand a hostile repo an arbitrarily large
 * prompt-stuffing channel on every cache hit. */
export const MAX_CACHED_DISCLOSURE_LENGTH = 2048;

/** Io params are per-invocation plumbing, never policy identity: the same
 * policy applied to the same object must hit regardless of where the
 * source file sat or which staging dir the run used. */
const FINGERPRINT_EXCLUDED_KEYS = new Set(['inputPath', 'outputDir']);

/** Deterministic JSON: objects serialized with sorted keys at every
 * depth, so `{a,b}` and `{b,a}` fingerprint identically. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * `policyFingerprint = sha256(toolName + normalized arguments + tool
 * version)` (decision D2). Arguments are normalized by dropping the
 * per-invocation io params and key-sorting the rest, so semantically
 * identical calls fingerprint identically. `toolVersion` exists to
 * invalidate cached results when a tool's transcode behavior changes
 * without any argument changing.
 */
export function computePolicyFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  toolVersion = '1',
): string {
  const tunables: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!FINGERPRINT_EXCLUDED_KEYS.has(k) && v !== undefined) {
      tunables[k] = v;
    }
  }
  return createHash('sha256')
    .update(`${toolName}\n${stableStringify(tunables)}\n${toolVersion}`)
    .digest('hex');
}

/**
 * Persistent map from `(originalSha256, policyFingerprint)` to the
 * degraded derivative's identity (decision D2). Lives at
 * `.qwen/omni/policy-cache.json`; a hit whose object still exists in
 * `objects/` lets the orchestrator skip a minutes-long transcode. The
 * existence check is the orchestrator's job — this cache only answers
 * "what did this policy produce last time".
 *
 * File mechanics (serialized ops, atomic writes, corrupt backup+rebuild,
 * unreadable-file no-op) are shared with the upload cache via
 * {@link OmniJsonCacheFile}. Entries carry no TTL: identities are
 * content-addressed and never go stale — they are invalidated
 * explicitly when the underlying object disappears (GC/corruption).
 */
export class OmniDegradationCache {
  private readonly file: OmniJsonCacheFile<DegradationCacheEntry>;

  constructor(omniRootDir: string) {
    this.file = new OmniJsonCacheFile(
      path.join(omniRootDir, 'policy-cache.json'),
      'omni:policy-cache',
    );
  }

  private key(originalSha256: string, policyFingerprint: string): string {
    return `${originalSha256}|${policyFingerprint}`;
  }

  async get(
    originalSha256: string,
    policyFingerprint: string,
  ): Promise<DegradationCacheEntry | null> {
    return this.file.access<DegradationCacheEntry | null>(null, (entries) => {
      const key = this.key(originalSha256, policyFingerprint);
      const entry = entries[key];
      if (!entry) return { result: null };
      // The cache file sits inside the workspace (`.qwen/omni/`), so a
      // hostile repository can ship a crafted one. Entries are only
      // trusted when every field that later becomes a filesystem path or
      // a model-visible text is well-formed: the hash must be exactly
      // 64-hex (it addresses the object store), the extension a single
      // dotted component (no traversal segments), and the disclosure
      // non-empty (lossy reuse without disclosure would silently break
      // the D8 invariant) and bounded (an unbounded field served
      // verbatim into model-visible content is a prompt-stuffing
      // channel). Malformed entries are dropped, not served —
      // the orchestrator then re-derives and overwrites them.
      if (
        !/^[0-9a-f]{64}$/.test(entry.degradedSha256) ||
        typeof entry.extension !== 'string' ||
        !OBJECT_EXTENSION_RE.test(entry.extension) ||
        typeof entry.disclosure !== 'string' ||
        entry.disclosure.length === 0 ||
        entry.disclosure.length > MAX_CACHED_DISCLOSURE_LENGTH ||
        typeof entry.mimeType !== 'string' ||
        entry.mimeType.length === 0 ||
        (entry.role !== undefined &&
          (typeof entry.role !== 'string' || entry.role.length === 0))
      ) {
        delete entries[key];
        return { result: null, changed: true };
      }
      return { result: entry };
    });
  }

  async put(
    originalSha256: string,
    policyFingerprint: string,
    entry: Omit<DegradationCacheEntry, 'createdAt'>,
  ): Promise<void> {
    return this.file.access(undefined, (entries) => {
      entries[this.key(originalSha256, policyFingerprint)] = {
        ...entry,
        createdAt: new Date().toISOString(),
      };
      return { result: undefined, changed: true };
    });
  }

  /** Drop every policy result derived FROM the object (source object
   * gone/corrupt — GC cascade). */
  async removeByOriginalSha256(originalSha256: string): Promise<void> {
    return this.file.access(undefined, (entries) => {
      const prefix = `${originalSha256}|`;
      let changed = false;
      for (const k of Object.keys(entries)) {
        if (k.startsWith(prefix)) {
          delete entries[k];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }

  /** Drop every entry POINTING AT the derived object (derivative
   * gone/corrupt — the next run must re-transcode, not chase a missing
   * object). */
  async removeByDegradedSha256(degradedSha256: string): Promise<void> {
    return this.file.access(undefined, (entries) => {
      let changed = false;
      for (const [k, v] of Object.entries(entries)) {
        if (v.degradedSha256 === degradedSha256) {
          delete entries[k];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }
}
