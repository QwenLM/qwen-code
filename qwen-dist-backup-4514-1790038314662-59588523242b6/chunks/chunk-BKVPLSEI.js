// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/disclosure.ts
init_esbuild_shims();
var OMNI_DISCLOSURE_TEXT_PREFIX = "\u3010\u5A92\u4F53\u964D\u8D28\u3011";
function escapeAnnotationName(name) {
  return name.replaceAll("\\", "\\\\").replaceAll("\uFF1A", "\\\uFF1A");
}
__name(escapeAnnotationName, "escapeAnnotationName");
function unescapeAnnotationName(escaped) {
  return escaped.replace(/\\([\s\S])/g, "$1");
}
__name(unescapeAnnotationName, "unescapeAnnotationName");
function splitAnnotationBody(body) {
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\uFF1A") {
      return {
        name: unescapeAnnotationName(body.slice(0, i)),
        payload: body.slice(i + 1)
      };
    }
  }
  return void 0;
}
__name(splitAnnotationBody, "splitAnnotationBody");
function isKeyframeTimestampLabel(text) {
  return /^<\d{1,2}:\d{2}(?::\d{2})?>$/.test(text);
}
__name(isKeyframeTimestampLabel, "isKeyframeTimestampLabel");
function formatDisclosureText(displayName, disclosure) {
  if (isKeyframeTimestampLabel(disclosure)) {
    return disclosure;
  }
  return `${OMNI_DISCLOSURE_TEXT_PREFIX}${escapeAnnotationName(displayName)}\uFF1A${disclosure}`;
}
__name(formatDisclosureText, "formatDisclosureText");
function isDisclosureText(text) {
  return text.startsWith(OMNI_DISCLOSURE_TEXT_PREFIX) || isKeyframeTimestampLabel(text);
}
__name(isDisclosureText, "isDisclosureText");
var OMNI_OMISSION_TEXT_PREFIX = "\u3010\u5A92\u4F53\u7701\u7565\u3011";
function formatOmissionText(displayName, reason) {
  return `${OMNI_OMISSION_TEXT_PREFIX}${escapeAnnotationName(displayName)}\uFF1A${reason}`;
}
__name(formatOmissionText, "formatOmissionText");
var OMNI_TRANSCRIPT_TEXT_PREFIX = "\u3010\u5A92\u4F53\u8F6C\u5199\u3011";
function formatTranscriptText(displayName, transcript) {
  return `${OMNI_TRANSCRIPT_TEXT_PREFIX}${escapeAnnotationName(displayName)}\uFF1A${transcript}`;
}
__name(formatTranscriptText, "formatTranscriptText");
var OMNI_RESOURCE_HANDLE_TEXT_PREFIX = "\u3010\u5A92\u4F53\u8D44\u6E90\u3011";
var OMNI_RESOURCE_PATH_TEXT_PREFIX = "\u3010\u5A92\u4F53\u8DEF\u5F84\u3011";
function formatResourceHandleText(displayName, resourceId) {
  return `${OMNI_RESOURCE_HANDLE_TEXT_PREFIX}${escapeAnnotationName(displayName)}\uFF1A${resourceId}`;
}
__name(formatResourceHandleText, "formatResourceHandleText");
function parseResourceHandleText(text) {
  if (!text.startsWith(OMNI_RESOURCE_HANDLE_TEXT_PREFIX)) return void 0;
  const split = splitAnnotationBody(
    text.slice(OMNI_RESOURCE_HANDLE_TEXT_PREFIX.length)
  );
  if (!split) return void 0;
  return /^media-\d+-[0-9a-f]+$/.test(split.payload) ? split.payload : void 0;
}
__name(parseResourceHandleText, "parseResourceHandleText");
function formatResourcePathText(absolutePath) {
  return `${OMNI_RESOURCE_PATH_TEXT_PREFIX}${absolutePath}`;
}
__name(formatResourcePathText, "formatResourcePathText");
function isAbsolutePathLike(p) {
  return p.startsWith("/") || // POSIX
  /^[A-Za-z]:[\\/]/.test(p) || // Windows drive
  p.startsWith("\\\\");
}
__name(isAbsolutePathLike, "isAbsolutePathLike");
function parseResourcePathText(text) {
  if (!text.startsWith(OMNI_RESOURCE_PATH_TEXT_PREFIX)) return void 0;
  const path = text.slice(OMNI_RESOURCE_PATH_TEXT_PREFIX.length);
  return isAbsolutePathLike(path) ? path : void 0;
}
__name(parseResourcePathText, "parseResourcePathText");
function harnessPathAnnotationPart(absolutePath) {
  return {
    text: formatResourcePathText(absolutePath),
    omniHarnessAnnotation: true
  };
}
__name(harnessPathAnnotationPart, "harnessPathAnnotationPart");
function isHarnessAnnotationPart(part) {
  return typeof part === "object" && part !== null && part.omniHarnessAnnotation === true;
}
__name(isHarnessAnnotationPart, "isHarnessAnnotationPart");

export {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  unescapeAnnotationName,
  splitAnnotationBody,
  formatDisclosureText,
  isDisclosureText,
  OMNI_OMISSION_TEXT_PREFIX,
  formatOmissionText,
  OMNI_TRANSCRIPT_TEXT_PREFIX,
  formatTranscriptText,
  OMNI_RESOURCE_HANDLE_TEXT_PREFIX,
  OMNI_RESOURCE_PATH_TEXT_PREFIX,
  formatResourceHandleText,
  parseResourceHandleText,
  parseResourcePathText,
  harnessPathAnnotationPart,
  isHarnessAnnotationPart
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
