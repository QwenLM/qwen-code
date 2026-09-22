// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/dist/session-source.js
init_esbuild_shims();
var SESSION_SOURCE_META_KEY = "qwen.session.source";
var SESSION_SOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
var MAX_SESSION_SOURCE_ID_LENGTH = 256;
var STANDALONE_SESSION_SOURCE_TYPE = "standalone";
var DAEMON_OWNED_STANDALONE_CREATION_KEY = "daemonOwnedStandaloneCreation";
function isReservedStandaloneSessionSourceType(sourceType) {
  return sourceType === STANDALONE_SESSION_SOURCE_TYPE;
}
__name(isReservedStandaloneSessionSourceType, "isReservedStandaloneSessionSourceType");
var SCHEDULED_TASK_RUN_SOURCE_TYPE = "default";
var SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX = "scheduled_task_run:";
function isScheduledTaskRunSource(source) {
  return source.sourceType === SCHEDULED_TASK_RUN_SOURCE_TYPE && source.sourceId?.startsWith(SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX) === true;
}
__name(isScheduledTaskRunSource, "isScheduledTaskRunSource");
function parseSessionSource(sourceType, sourceId) {
  if (sourceType === void 0 && sourceId === void 0)
    return {};
  if (typeof sourceType !== "string" || !SESSION_SOURCE_TYPE_PATTERN.test(sourceType)) {
    return {
      error: "`sourceType` must match [a-z][a-z0-9_-]{0,63} when provided"
    };
  }
  if (sourceId === void 0)
    return { sourceType };
  if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > MAX_SESSION_SOURCE_ID_LENGTH || [...sourceId].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    return {
      error: `\`sourceId\` must be a non-empty string of at most ${MAX_SESSION_SOURCE_ID_LENGTH} characters without control characters`
    };
  }
  return { sourceType, sourceId };
}
__name(parseSessionSource, "parseSessionSource");

export {
  SESSION_SOURCE_META_KEY,
  STANDALONE_SESSION_SOURCE_TYPE,
  DAEMON_OWNED_STANDALONE_CREATION_KEY,
  isReservedStandaloneSessionSourceType,
  isScheduledTaskRunSource,
  parseSessionSource
};
