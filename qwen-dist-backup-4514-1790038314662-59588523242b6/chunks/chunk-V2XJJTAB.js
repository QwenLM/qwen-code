// Force strict mode and setup for ESM
"use strict";
import {
  combineAbortSignals
} from "./chunk-DJ2GSRLV.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/upload.ts
init_esbuild_shims();
import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import path from "node:path";
var OSS_URL_PREFIX = "oss://";
var DEFAULT_ORIGIN = "https://dashscope.aliyuncs.com";
var GET_POLICY_TIMEOUT_MS = 3e4;
var UPLOAD_TIMEOUT_MS = 15 * 6e4;
var CREDENTIAL_TTL_MS = 24e4;
var credentialCache = /* @__PURE__ */ new Map();
function resetCredentialCacheForTests() {
  credentialCache.clear();
}
__name(resetCredentialCacheForTests, "resetCredentialCacheForTests");
function sanitizeFileName(name) {
  const cleaned = name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned.slice(-100) : "file";
}
__name(sanitizeFileName, "sanitizeFileName");
function uploadsOriginFromBaseUrl(baseUrl) {
  if (!baseUrl) return DEFAULT_ORIGIN;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}
__name(uploadsOriginFromBaseUrl, "uploadsOriginFromBaseUrl");
async function summarizeHttpFailure(res) {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body);
    const code = parsed.code ?? parsed.error?.code;
    const message = parsed.message ?? parsed.error?.message;
    const detail = [code, message].filter((v) => typeof v === "string" && v.length > 0).join(": ").slice(0, 160);
    if (detail) return `HTTP ${res.status} (${detail})`;
  } catch {
  }
  return `HTTP ${res.status}`;
}
__name(summarizeHttpFailure, "summarizeHttpFailure");
function rethrowIfAborted(err, signal) {
  if (signal?.aborted) throw err;
}
__name(rethrowIfAborted, "rethrowIfAborted");
function abortReason(signal) {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}
__name(abortReason, "abortReason");
function raceWithSignal(shared, signal) {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = /* @__PURE__ */ __name(() => reject(abortReason(signal)), "onAbort");
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}
__name(raceWithSignal, "raceWithSignal");
var DashScopeUploader = class {
  static {
    __name(this, "DashScopeUploader");
  }
  apiKey;
  origin;
  fetchFn;
  constructor(options) {
    this.apiKey = options.apiKey;
    this.origin = uploadsOriginFromBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
  }
  /** Fetch a short-lived upload policy bound to `model`, reusing a cached
   * credential within its validity window. */
  async getPolicy(model, signal) {
    const keyDigest = createHash("sha256").update(this.apiKey).digest("hex").slice(0, 16);
    const cacheKey = `${this.origin}|${model}|${keyDigest}`;
    const cached = credentialCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CREDENTIAL_TTL_MS) {
      return raceWithSignal(cached.policy, signal);
    }
    const entry = {
      fetchedAt: Date.now(),
      policy: this.fetchPolicy(model)
    };
    credentialCache.set(cacheKey, entry);
    entry.policy.catch(() => {
      if (credentialCache.get(cacheKey) === entry) {
        credentialCache.delete(cacheKey);
      }
    });
    return raceWithSignal(entry.policy, signal);
  }
  /** Uncached policy fetch. Runs solely under the internal timeout; caller
   * signals are handled per-caller in getPolicy so one caller's abort never
   * contaminates the shared cached promise. */
  async fetchPolicy(model) {
    const url = new URL("/api/v1/uploads", this.origin);
    url.searchParams.set("action", "getPolicy");
    url.searchParams.set("model", model);
    const combined = combineAbortSignals([], {
      timeoutMs: GET_POLICY_TIMEOUT_MS
    });
    let failureSummary;
    let payload;
    try {
      const res = await this.fetchFn(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: combined.signal
      });
      if (res.ok) {
        try {
          payload = await res.json();
        } catch (err) {
          if (combined.signal.aborted) throw err;
          payload = void 0;
        }
      } else {
        failureSummary = await summarizeHttpFailure(res);
      }
    } catch (err) {
      throw new Error(
        `DashScope upload getPolicy request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      combined.cleanup();
    }
    if (failureSummary) {
      throw new Error(`DashScope upload getPolicy failed: ${failureSummary}`);
    }
    const data = payload?.data;
    if (!data?.policy || !data.signature || !data.upload_dir || !data.upload_host || !data.oss_access_key_id || !data.x_oss_object_acl || !data.x_oss_forbid_overwrite) {
      throw new Error(
        "DashScope upload getPolicy returned an incomplete policy payload."
      );
    }
    return data;
  }
  /**
   * Upload a local file under a fresh policy for `model`. Returns the
   * `oss://` URL DashScope resolves at inference time.
   */
  async uploadFile(params) {
    const { filePath, model, mimeType, signal } = params;
    const policy = await this.getPolicy(model, signal);
    const key = `${policy.upload_dir}/${randomUUID().slice(0, 8)}-${sanitizeFileName(
      path.basename(filePath)
    )}`;
    const form = new FormData();
    form.append("OSSAccessKeyId", policy.oss_access_key_id);
    form.append("Signature", policy.signature);
    form.append("policy", policy.policy);
    form.append("x-oss-object-acl", policy.x_oss_object_acl);
    form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
    form.append("key", key);
    form.append("success_action_status", "200");
    let blob;
    try {
      blob = await openAsBlob(filePath, { type: mimeType });
    } catch (err) {
      throw new Error(
        `Failed to open file for upload: ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    form.append("file", blob, path.basename(filePath));
    const combined = combineAbortSignals([signal], {
      timeoutMs: UPLOAD_TIMEOUT_MS
    });
    let failureSummary;
    try {
      const res = await this.fetchFn(policy.upload_host, {
        method: "POST",
        body: form,
        signal: combined.signal
      });
      if (res.ok) {
        await res.body?.cancel().catch(() => {
        });
      } else {
        failureSummary = await summarizeHttpFailure(res);
      }
    } catch (err) {
      rethrowIfAborted(err, signal);
      throw new Error(
        `DashScope media upload failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      combined.cleanup();
    }
    if (failureSummary) {
      throw new Error(`DashScope media upload failed: ${failureSummary}`);
    }
    return `${OSS_URL_PREFIX}${key}`;
  }
};

export {
  OSS_URL_PREFIX,
  resetCredentialCacheForTests,
  DashScopeUploader
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
