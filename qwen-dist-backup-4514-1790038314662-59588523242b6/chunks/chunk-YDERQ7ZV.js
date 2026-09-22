// Force strict mode and setup for ESM
"use strict";
import {
  isPlainRecord
} from "./chunk-BQMSZSG6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/services/media-memory/config.ts
init_esbuild_shims();
var OmniMemoryConfigError = class extends Error {
  static {
    __name(this, "OmniMemoryConfigError");
  }
  constructor(message) {
    super(message);
    this.name = "OmniMemoryConfigError";
  }
};
var OMNI_MEMORY_RECALL_KINDS = [
  "metadata",
  "derived_media",
  "policy_result",
  "execution"
];
var DEFAULT_OMNI_MEMORY_CONFIG = {
  collection: { maxInlineTextBytes: 65536 },
  recall: {
    mode: "active",
    maxEntries: 12,
    maxTextChars: 24e3,
    kinds: [...OMNI_MEMORY_RECALL_KINDS],
    includeHistoricalVersions: false,
    active: { maxFilesPerCall: 8 },
    sideQuery: {
      model: null,
      timeoutMs: 3e4,
      maxCandidateEntries: 100,
      maxSelectedEntries: 12,
      maxAttempts: 1
    }
  }
};
var ROOT_KEYS = /* @__PURE__ */ new Set(["collection", "recall"]);
var COLLECTION_KEYS = /* @__PURE__ */ new Set(["maxInlineTextBytes"]);
var RECALL_KEYS = /* @__PURE__ */ new Set([
  "mode",
  "maxEntries",
  "maxTextChars",
  "kinds",
  "includeHistoricalVersions",
  "active",
  "sideQuery"
]);
var ACTIVE_KEYS = /* @__PURE__ */ new Set(["maxFilesPerCall"]);
var SIDE_QUERY_KEYS = /* @__PURE__ */ new Set([
  "model",
  "timeoutMs",
  "maxCandidateEntries",
  "maxSelectedEntries",
  "maxAttempts"
]);
function fail(message) {
  throw new OmniMemoryConfigError(message);
}
__name(fail, "fail");
function requireRecord(value, where, allowedKeys) {
  if (!isPlainRecord(value)) {
    fail(`${where}: must be an object (got ${JSON.stringify(value)})`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(
        `${where}: unknown key "${key}" (allowed: ${[...allowedKeys].join(", ")})`
      );
    }
  }
  return value;
}
__name(requireRecord, "requireRecord");
function positiveInteger(value, where) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${where}: must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return value;
}
__name(positiveInteger, "positiveInteger");
function requireBoolean(value, where) {
  if (typeof value !== "boolean") {
    fail(`${where}: must be a boolean (got ${JSON.stringify(value)})`);
  }
  return value;
}
__name(requireBoolean, "requireBoolean");
function normalizeKinds(value, where) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${where}: must be a non-empty array of entry kinds`);
  }
  const known = new Set(OMNI_MEMORY_RECALL_KINDS);
  const seen = /* @__PURE__ */ new Set();
  for (const kind of value) {
    if (typeof kind !== "string" || !known.has(kind)) {
      fail(
        `${where}: unknown entry kind ${JSON.stringify(kind)} (allowed: ${OMNI_MEMORY_RECALL_KINDS.join(", ")})`
      );
    }
    if (seen.has(kind)) {
      fail(`${where}: duplicate entry kind "${kind}"`);
    }
    seen.add(kind);
  }
  return [...seen];
}
__name(normalizeKinds, "normalizeKinds");
function normalizeOmniMemoryConfig(raw) {
  const defaults = DEFAULT_OMNI_MEMORY_CONFIG;
  if (raw !== void 0) {
    requireRecord(raw, "omni.memory", ROOT_KEYS);
  }
  let maxInlineTextBytes = defaults.collection.maxInlineTextBytes;
  if (raw?.collection !== void 0) {
    const collection = requireRecord(
      raw.collection,
      "omni.memory.collection",
      COLLECTION_KEYS
    );
    if (collection["maxInlineTextBytes"] !== void 0) {
      maxInlineTextBytes = positiveInteger(
        collection["maxInlineTextBytes"],
        "omni.memory.collection.maxInlineTextBytes"
      );
    }
  }
  const recall = { ...defaults.recall };
  recall.kinds = [...defaults.recall.kinds];
  recall.active = { ...defaults.recall.active };
  recall.sideQuery = { ...defaults.recall.sideQuery };
  if (raw?.recall !== void 0) {
    const rawRecall = requireRecord(
      raw.recall,
      "omni.memory.recall",
      RECALL_KEYS
    );
    if (rawRecall["mode"] !== void 0) {
      const mode = rawRecall["mode"];
      if (mode !== "active" && mode !== "sideQuery") {
        fail(
          `omni.memory.recall.mode: must be "active" or "sideQuery" (got ${JSON.stringify(mode)})`
        );
      }
      recall.mode = mode;
    }
    if (rawRecall["maxEntries"] !== void 0) {
      recall.maxEntries = positiveInteger(
        rawRecall["maxEntries"],
        "omni.memory.recall.maxEntries"
      );
    }
    if (rawRecall["maxTextChars"] !== void 0) {
      recall.maxTextChars = positiveInteger(
        rawRecall["maxTextChars"],
        "omni.memory.recall.maxTextChars"
      );
    }
    if (rawRecall["kinds"] !== void 0) {
      recall.kinds = normalizeKinds(
        rawRecall["kinds"],
        "omni.memory.recall.kinds"
      );
    }
    if (rawRecall["includeHistoricalVersions"] !== void 0) {
      recall.includeHistoricalVersions = requireBoolean(
        rawRecall["includeHistoricalVersions"],
        "omni.memory.recall.includeHistoricalVersions"
      );
    }
    if (rawRecall["active"] !== void 0) {
      const active = requireRecord(
        rawRecall["active"],
        "omni.memory.recall.active",
        ACTIVE_KEYS
      );
      if (active["maxFilesPerCall"] !== void 0) {
        recall.active.maxFilesPerCall = positiveInteger(
          active["maxFilesPerCall"],
          "omni.memory.recall.active.maxFilesPerCall"
        );
      }
    }
    if (rawRecall["sideQuery"] !== void 0) {
      const sq = requireRecord(
        rawRecall["sideQuery"],
        "omni.memory.recall.sideQuery",
        SIDE_QUERY_KEYS
      );
      if (sq["model"] !== void 0) {
        const model = sq["model"];
        if (model !== null && (typeof model !== "string" || model === "")) {
          fail(
            `omni.memory.recall.sideQuery.model: must be null or a non-empty string (got ${JSON.stringify(model)})`
          );
        }
        recall.sideQuery.model = model;
      }
      for (const key of [
        "timeoutMs",
        "maxCandidateEntries",
        "maxSelectedEntries",
        "maxAttempts"
      ]) {
        if (sq[key] !== void 0) {
          recall.sideQuery[key] = positiveInteger(
            sq[key],
            `omni.memory.recall.sideQuery.${key}`
          );
        }
      }
    }
  }
  if (recall.sideQuery.maxSelectedEntries > recall.maxEntries) {
    fail(
      `omni.memory.recall.sideQuery.maxSelectedEntries (${recall.sideQuery.maxSelectedEntries}) must not exceed omni.memory.recall.maxEntries (${recall.maxEntries})`
    );
  }
  if (recall.maxEntries > recall.sideQuery.maxCandidateEntries) {
    fail(
      `omni.memory.recall.maxEntries (${recall.maxEntries}) must not exceed omni.memory.recall.sideQuery.maxCandidateEntries (${recall.sideQuery.maxCandidateEntries})`
    );
  }
  return { collection: { maxInlineTextBytes }, recall };
}
__name(normalizeOmniMemoryConfig, "normalizeOmniMemoryConfig");

export {
  OmniMemoryConfigError,
  OMNI_MEMORY_RECALL_KINDS,
  DEFAULT_OMNI_MEMORY_CONFIG,
  normalizeOmniMemoryConfig
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
