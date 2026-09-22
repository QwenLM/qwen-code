// Force strict mode and setup for ESM
"use strict";
import {
  OmniJsonCacheFile
} from "./chunk-TFDCK56Y.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/upload-cache.ts
init_esbuild_shims();
import path from "node:path";
var debugLogger = createDebugLogger("omni:upload-cache");
var DEFAULT_UPLOAD_CACHE_TTL_HOURS = 47;
var MAX_UPLOAD_CACHE_TTL_HOURS = 48;
var OmniUploadCache = class {
  static {
    __name(this, "OmniUploadCache");
  }
  file;
  ttlMs;
  scope;
  constructor(omniRootDir, ttlHours = DEFAULT_UPLOAD_CACHE_TTL_HOURS, scope = "") {
    this.file = new OmniJsonCacheFile(
      path.join(omniRootDir, "upload-cache.json"),
      "omni:upload-cache"
    );
    this.ttlMs = Math.min(ttlHours, MAX_UPLOAD_CACHE_TTL_HOURS) * 36e5;
    this.scope = scope;
  }
  /** TTL of 0 (or negative) disables the cache entirely. */
  get enabled() {
    return this.ttlMs > 0;
  }
  key(sha256, model) {
    return `${sha256}|${model}|${this.scope}`;
  }
  /** Valid cached URL or null. Expired entries are pruned on read. */
  async get(sha256, model) {
    if (!this.enabled) return null;
    return this.file.access(null, (entries) => {
      const k = this.key(sha256, model);
      const entry = entries[k];
      if (!entry) return { result: null };
      const expiresAtMs = Date.parse(entry.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        delete entries[k];
        return { result: null, changed: true };
      }
      return { result: entry.ossUrl };
    });
  }
  async put(sha256, model, ossUrl) {
    if (!this.enabled) return;
    return this.file.access(void 0, (entries) => {
      const now = Date.now();
      entries[this.key(sha256, model)] = {
        ossUrl,
        uploadedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString()
      };
      for (const [k, v] of Object.entries(entries)) {
        const t = Date.parse(v.expiresAt);
        if (!Number.isFinite(t) || t <= now) delete entries[k];
      }
      return { result: void 0, changed: true };
    });
  }
  /**
   * Reverse lookup: the object hash behind a delivered oss:// URL.
   *
   * Serves the reactive server-limit fallback, which only knows the URL
   * embedded in the rejected request and must find the local object to
   * degrade. Scope-agnostic like {@link invalidateByUrl} (the caller
   * knows the URL, not the endpoint scope that minted it); expired
   * entries still resolve — the URL was just sent, so the object mapping
   * is trustworthy even if the cached URL is past its validity horizon.
   */
  async findSha256ByUrl(ossUrl) {
    return this.file.access(null, (entries) => {
      for (const [k, v] of Object.entries(entries)) {
        if (v.ossUrl === ossUrl) {
          const sha256 = k.split("|", 1)[0];
          if (sha256) return { result: sha256 };
        }
      }
      return { result: null };
    });
  }
  /**
   * Drop every entry pointing at a server-side-invalidated URL.
   *
   * Deliberately ignores the `enabled` flag: even for ttlHours-0 users
   * this must clear stale entries persisted before the cache was
   * disabled, and it serves the recovery cascade. The URL scan is
   * scope-agnostic on purpose — the caller only knows the rejected URL,
   * not which endpoint scope minted it.
   */
  async invalidateByUrl(ossUrl) {
    return this.file.access(void 0, (entries) => {
      let changed = false;
      for (const [k, v] of Object.entries(entries)) {
        if (v.ossUrl === ossUrl) {
          delete entries[k];
          changed = true;
        }
      }
      if (changed) {
        debugLogger.debug(`invalidated upload cache entries for ${ossUrl}`);
      }
      return { result: void 0, changed };
    });
  }
  /**
   * Drop all entries for an object (GC/corruption cascade). Ignores the
   * `enabled` flag for the same reason as {@link invalidateByUrl}. The
   * prefix match spans models AND scopes — intended: a corrupt object is
   * corrupt for every endpoint.
   */
  async removeBySha256(sha256) {
    return this.file.access(void 0, (entries) => {
      const prefix = `${sha256}|`;
      let changed = false;
      for (const k of Object.keys(entries)) {
        if (k.startsWith(prefix)) {
          delete entries[k];
          changed = true;
        }
      }
      return { result: void 0, changed };
    });
  }
};

export {
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
  OmniUploadCache
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
