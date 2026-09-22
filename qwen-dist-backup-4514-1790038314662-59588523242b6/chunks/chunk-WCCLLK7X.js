// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/replayWindowLimits.ts
init_esbuild_shims();
var DEFAULT_COMPACTED_REPLAY_MAX_BYTES = 4 * 1024 * 1024;
var MAX_COMPACTED_REPLAY_MAX_BYTES = 256 * 1024 * 1024;
var DEFAULT_MAX_JOURNAL_EVENTS = 1e4;
var DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
var JOURNAL_GROWTH_HARD_CAP_BYTES = 256 * 1024 * 1024;
function normalizeCompactedReplayMaxBytes(value) {
  if (value === void 0) return DEFAULT_COMPACTED_REPLAY_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COMPACTED_REPLAY_MAX_BYTES) {
    throw new TypeError(
      `Invalid compactedReplayMaxBytes: ${value}. Must be a positive safe integer in [1, ${MAX_COMPACTED_REPLAY_MAX_BYTES}].`
    );
  }
  return value;
}
__name(normalizeCompactedReplayMaxBytes, "normalizeCompactedReplayMaxBytes");
function normalizeMaxJournalEvents(value) {
  if (value === void 0) return DEFAULT_MAX_JOURNAL_EVENTS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `Invalid maxJournalEvents: ${value}. Must be a positive safe integer.`
    );
  }
  return value;
}
__name(normalizeMaxJournalEvents, "normalizeMaxJournalEvents");
function normalizeMaxJournalBytes(value) {
  if (value === void 0) return DEFAULT_MAX_JOURNAL_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `Invalid maxJournalBytes: ${value}. Must be a positive safe integer.`
    );
  }
  return value;
}
__name(normalizeMaxJournalBytes, "normalizeMaxJournalBytes");
function normalizeJournalGrowthPoolBytes(value) {
  if (value === void 0) return void 0;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `Invalid journalGrowthPoolBytes: ${value}. Must be a positive safe integer.`
    );
  }
  return value;
}
__name(normalizeJournalGrowthPoolBytes, "normalizeJournalGrowthPoolBytes");

export {
  DEFAULT_COMPACTED_REPLAY_MAX_BYTES,
  MAX_COMPACTED_REPLAY_MAX_BYTES,
  DEFAULT_MAX_JOURNAL_EVENTS,
  DEFAULT_MAX_JOURNAL_BYTES,
  JOURNAL_GROWTH_HARD_CAP_BYTES,
  normalizeCompactedReplayMaxBytes,
  normalizeMaxJournalEvents,
  normalizeMaxJournalBytes,
  normalizeJournalGrowthPoolBytes
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
