// Force strict mode and setup for ESM
"use strict";
import {
  STANDALONE_SESSION_SOURCE_TYPE
} from "./chunk-N4QWUPDM.js";
import {
  normalizeSessionIdForLookup
} from "./chunk-ZEZKIS2K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/runtime/live-session-source.ts
init_esbuild_shims();
var LIVE_SESSION_SOURCE_PREFIX = "realtime_voice:";
function isReservedLiveSessionSource(source) {
  return source.sourceType === "default" && source.sourceId?.startsWith(LIVE_SESSION_SOURCE_PREFIX) === true;
}
__name(isReservedLiveSessionSource, "isReservedLiveSessionSource");
function isCompatibleLiveSessionSource(source) {
  const sourceId = source.sourceId;
  return isReservedLiveSessionSource(source) && typeof sourceId === "string" && sourceId.length > LIVE_SESSION_SOURCE_PREFIX.length;
}
__name(isCompatibleLiveSessionSource, "isCompatibleLiveSessionSource");
function isReservedStandaloneSessionSource(source) {
  return source.sourceType === STANDALONE_SESSION_SOURCE_TYPE;
}
__name(isReservedStandaloneSessionSource, "isReservedStandaloneSessionSource");
function isCompatibleLegacyStandaloneSource(source) {
  return source.sourceId === void 0 && (source.sourceType === void 0 || source.sourceType === "default");
}
__name(isCompatibleLegacyStandaloneSource, "isCompatibleLegacyStandaloneSource");
function classifyTopLevelConversationSource(metadata) {
  if (metadata.parentSessionId !== void 0) return void 0;
  if (isCompatibleLiveSessionSource(metadata)) {
    return { kind: "live", persistence: "explicit", metadata };
  }
  if (isReservedStandaloneSessionSource(metadata) && metadata.sourceId === void 0) {
    return { kind: "standalone", persistence: "explicit", metadata };
  }
  if (isCompatibleLegacyStandaloneSource(metadata)) {
    return { kind: "standalone", persistence: "legacy", metadata };
  }
  return void 0;
}
__name(classifyTopLevelConversationSource, "classifyTopLevelConversationSource");
var SAFE_TRANSCRIPT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
var WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
async function readExistingMetadata(sessionId, store) {
  if (!SAFE_TRANSCRIPT_NAME_PATTERN.test(sessionId) || WINDOWS_DEVICE_NAME_PATTERN.test(sessionId)) {
    return void 0;
  }
  return await store.readCreationMetadataIfReadable(sessionId, "active") ?? await store.readCreationMetadataIfReadable(sessionId, "archived");
}
__name(readExistingMetadata, "readExistingMetadata");
async function readLoadableConversationSession(sessionId, store) {
  const metadata = await readExistingMetadata(sessionId, store);
  if (!metadata) return void 0;
  const topLevel = classifyTopLevelConversationSource(metadata);
  if (topLevel) return topLevel;
  const parentSessionId = metadata.parentSessionId;
  if (parentSessionId === void 0 || normalizeSessionIdForLookup(parentSessionId) === normalizeSessionIdForLookup(sessionId)) {
    return void 0;
  }
  if (isReservedStandaloneSessionSource(metadata) && metadata.sourceId === void 0) {
    const parent2 = await readExistingMetadata(parentSessionId, store);
    if (parent2 === void 0) {
      return { kind: "standalone", persistence: "explicit", metadata };
    }
    const parentSource2 = classifyTopLevelConversationSource(parent2);
    if (parentSource2?.kind !== "standalone") return void 0;
    return {
      kind: "standalone",
      persistence: "explicit",
      parentSource: {
        kind: parentSource2.kind,
        persistence: parentSource2.persistence
      },
      metadata
    };
  }
  if (metadata.sourceType !== void 0 || metadata.sourceId !== void 0) {
    return void 0;
  }
  const parent = await readExistingMetadata(parentSessionId, store);
  if (!parent) return void 0;
  const parentSource = classifyTopLevelConversationSource(parent);
  if (!parentSource) return void 0;
  return {
    kind: parentSource.kind,
    persistence: "legacy",
    parentSource: {
      kind: parentSource.kind,
      persistence: parentSource.persistence
    },
    metadata
  };
}
__name(readLoadableConversationSession, "readLoadableConversationSession");
async function readLoadableLiveConversationMetadata(sessionId, store) {
  const result = await readLoadableConversationSession(sessionId, store);
  if (!result || result.kind === "standalone" && result.persistence === "explicit") {
    return void 0;
  }
  if (result.kind === "standalone" && result.metadata.parentSessionId !== void 0) {
    if (result.parentSource?.kind !== "standalone" || result.parentSource.persistence !== "legacy") {
      return void 0;
    }
  }
  return result.metadata;
}
__name(readLoadableLiveConversationMetadata, "readLoadableLiveConversationMetadata");

export {
  LIVE_SESSION_SOURCE_PREFIX,
  isReservedLiveSessionSource,
  isCompatibleLiveSessionSource,
  isReservedStandaloneSessionSource,
  classifyTopLevelConversationSource,
  readLoadableConversationSession,
  readLoadableLiveConversationMetadata
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
