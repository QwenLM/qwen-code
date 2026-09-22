// Force strict mode and setup for ESM
"use strict";
import {
  stringWidth
} from "./chunk-2MIN6GRR.js";
import {
  ansiRegex,
  stripAnsi
} from "./chunk-TWPJO254.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/textUtils.ts
init_esbuild_shims();
import { stripVTControlCharacters } from "node:util";
var getAsciiArtWidth = /* @__PURE__ */ __name((asciiArt) => {
  if (!asciiArt) {
    return 0;
  }
  const lines = asciiArt.split("\n");
  return Math.max(...lines.map((line) => getCachedStringWidth(line)));
}, "getAsciiArtWidth");
var codePointsCache = /* @__PURE__ */ new Map();
var MAX_STRING_LENGTH_TO_CACHE = 1e3;
var TEXT_CACHE_MAX_ENTRIES = 500;
function evictOldestTextCacheEntry(cache) {
  if (cache.size >= TEXT_CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== void 0) {
      cache.delete(firstKey);
    }
  }
}
__name(evictOldestTextCacheEntry, "evictOldestTextCacheEntry");
function toCodePoints(str) {
  let isAscii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) {
      isAscii = false;
      break;
    }
  }
  if (isAscii) {
    return str.split("");
  }
  if (str.length <= MAX_STRING_LENGTH_TO_CACHE) {
    const cached = codePointsCache.get(str);
    if (cached) {
      return cached;
    }
  }
  const result = Array.from(str);
  if (str.length <= MAX_STRING_LENGTH_TO_CACHE) {
    evictOldestTextCacheEntry(codePointsCache);
    codePointsCache.set(str, result);
  }
  return result;
}
__name(toCodePoints, "toCodePoints");
function cpLen(str) {
  return toCodePoints(str).length;
}
__name(cpLen, "cpLen");
function cpSlice(str, start, end) {
  const arr = toCodePoints(str).slice(start, end);
  return arr.join("");
}
__name(cpSlice, "cpSlice");
function stripUnsafeCharacters(str) {
  const strippedAnsi = stripAnsi(str);
  const strippedVT = stripVTControlCharacters(strippedAnsi);
  return toCodePoints(strippedVT).filter((char) => {
    const code = char.codePointAt(0);
    if (code === void 0) return false;
    if (code === 9 || code === 10 || code === 13) return true;
    if (code >= 0 && code <= 31) return false;
    if (code >= 128 && code <= 159) return false;
    return true;
  }).join("");
}
__name(stripUnsafeCharacters, "stripUnsafeCharacters");
var stringWidthCache = /* @__PURE__ */ new Map();
var getCachedStringWidth = /* @__PURE__ */ __name((str) => {
  if (/^[\x20-\x7E]*$/.test(str)) {
    return str.length;
  }
  if (str.length > MAX_STRING_LENGTH_TO_CACHE) {
    return stringWidth(str);
  }
  if (stringWidthCache.has(str)) {
    return stringWidthCache.get(str);
  }
  const width = stringWidth(str);
  evictOldestTextCacheEntry(stringWidthCache);
  stringWidthCache.set(str, width);
  return width;
}, "getCachedStringWidth");
var graphemeSegmenter = new Intl.Segmenter(void 0, {
  granularity: "grapheme"
});
function truncateToWidth(text, maxWidth) {
  if (maxWidth <= 0) {
    return "";
  }
  if (getCachedStringWidth(text) <= maxWidth) {
    return text;
  }
  const ellipsis = "\u2026";
  const budget = Math.max(0, maxWidth - getCachedStringWidth(ellipsis));
  let width = 0;
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = getCachedStringWidth(segment);
    if (width + segmentWidth > budget) {
      break;
    }
    result += segment;
    width += segmentWidth;
  }
  return `${result}${ellipsis}`;
}
__name(truncateToWidth, "truncateToWidth");
var regex = ansiRegex();
var BARE_C0_CONTROL_CHARS_REGEX = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
var BIDI_OVERRIDE_CHARS_REGEX = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
function sanitizeTerminalText(value) {
  return escapeAnsiCtrlCodes(value).replace(BARE_C0_CONTROL_CHARS_REGEX, "").replace(BIDI_OVERRIDE_CHARS_REGEX, "");
}
__name(sanitizeTerminalText, "sanitizeTerminalText");
function escapeAnsiCtrlCodes(obj) {
  if (typeof obj === "string") {
    if (obj.search(regex) === -1) {
      return obj;
    }
    regex.lastIndex = 0;
    return obj.replace(
      regex,
      (match) => JSON.stringify(match).slice(1, -1)
    );
  }
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  const record = obj;
  if (!Array.isArray(obj) && typeof record["data"] === "string" && typeof record["mimeType"] === "string" && record["mimeType"].toLowerCase().startsWith("image/")) {
    return obj;
  }
  if (Array.isArray(obj)) {
    let newArr = null;
    for (let i = 0; i < obj.length; i++) {
      const value = obj[i];
      const escapedValue = escapeAnsiCtrlCodes(value);
      if (escapedValue !== value) {
        if (newArr === null) {
          newArr = [...obj];
        }
        newArr[i] = escapedValue;
      }
    }
    return newArr !== null ? newArr : obj;
  }
  let newObj = null;
  const keys = Object.keys(obj);
  for (const key of keys) {
    const value = obj[key];
    const escapedValue = escapeAnsiCtrlCodes(value);
    if (escapedValue !== value) {
      if (newObj === null) {
        newObj = { ...obj };
      }
      newObj[key] = escapedValue;
    }
  }
  return newObj !== null ? newObj : obj;
}
__name(escapeAnsiCtrlCodes, "escapeAnsiCtrlCodes");
var SENSITIVE_PATTERNS = [
  // API keys with common prefixes
  {
    pattern: /(sk-[a-zA-Z0-9]{20,})/g,
    replacement: "sk-***REDACTED***"
  },
  {
    pattern: /(api[_-]?key[_-]?[=:]\s*)[a-zA-Z0-9_-]{20,}/gi,
    replacement: "$1***REDACTED***"
  },
  // Bearer tokens
  {
    pattern: /(Bearer\s+)[a-zA-Z0-9._-]+/gi,
    replacement: "$1***REDACTED***"
  },
  // Generic tokens
  {
    pattern: /(token[_-]?[=:]\s*)[a-zA-Z0-9._-]{10,}/gi,
    replacement: "$1***REDACTED***"
  },
  // Passwords in connection strings or assignments
  {
    pattern: /(password[_-]?[=:]\s*)[^\s]+/gi,
    replacement: "$1***REDACTED***"
  },
  {
    pattern: /(pwd[_-]?[=:]\s*)[^\s]+/gi,
    replacement: "$1***REDACTED***"
  },
  // AWS keys
  {
    pattern: /(AKIA[A-Z0-9]{16})/g,
    replacement: "***REDACTED***"
  },
  // Generic secret patterns
  {
    pattern: /(secret[_-]?[=:]\s*)[a-zA-Z0-9._-]{10,}/gi,
    replacement: "$1***REDACTED***"
  }
];
function sanitizeSensitiveText(text, maxLength = 200) {
  let result = text;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  if (result.length > maxLength) {
    if (maxLength <= 3) {
      return result.slice(0, maxLength);
    }
    return result.slice(0, maxLength - 3) + "...";
  }
  return result;
}
__name(sanitizeSensitiveText, "sanitizeSensitiveText");
var FILENAME_CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
var MULTILINE_CONTROL_CHARS_REGEX = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
function escapeControlChar(ch) {
  switch (ch) {
    case "\b":
      return "\\b";
    case "	":
      return "\\t";
    case "\n":
      return "\\n";
    case "\f":
      return "\\f";
    case "\r":
      return "\\r";
    default: {
      const code = ch.charCodeAt(0);
      return `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
}
__name(escapeControlChar, "escapeControlChar");
function sanitizeFilenameForDisplay(name) {
  return escapeAnsiCtrlCodes(name).replace(
    FILENAME_CONTROL_CHARS_REGEX,
    escapeControlChar
  );
}
__name(sanitizeFilenameForDisplay, "sanitizeFilenameForDisplay");
function sanitizeMultilineForDisplay(text) {
  return escapeAnsiCtrlCodes(text).replace(
    MULTILINE_CONTROL_CHARS_REGEX,
    escapeControlChar
  );
}
__name(sanitizeMultilineForDisplay, "sanitizeMultilineForDisplay");

export {
  getAsciiArtWidth,
  toCodePoints,
  cpLen,
  cpSlice,
  stripUnsafeCharacters,
  getCachedStringWidth,
  truncateToWidth,
  sanitizeTerminalText,
  escapeAnsiCtrlCodes,
  sanitizeSensitiveText,
  sanitizeFilenameForDisplay,
  sanitizeMultilineForDisplay
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
