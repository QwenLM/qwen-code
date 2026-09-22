// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/i18n/languages.ts
init_esbuild_shims();
var SUPPORTED_LANGUAGES = [
  {
    code: "en",
    id: "en-US",
    fullName: "English",
    nativeName: "English"
  },
  {
    code: "zh-TW",
    id: "zh-TW",
    fullName: "Traditional Chinese",
    nativeName: "\u7E41\u9AD4\u4E2D\u6587",
    strictParity: true
  },
  {
    code: "zh",
    id: "zh-CN",
    fullName: "Chinese",
    nativeName: "\u4E2D\u6587",
    strictParity: true
  },
  {
    code: "ru",
    id: "ru-RU",
    fullName: "Russian",
    nativeName: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439"
  },
  {
    code: "de",
    id: "de-DE",
    fullName: "German",
    nativeName: "Deutsch"
  },
  {
    code: "ja",
    id: "ja-JP",
    fullName: "Japanese",
    nativeName: "\u65E5\u672C\u8A9E"
  },
  {
    code: "pt",
    id: "pt-BR",
    fullName: "Portuguese",
    nativeName: "Portugu\xEAs"
  },
  {
    code: "fr",
    id: "fr-FR",
    fullName: "French",
    nativeName: "Fran\xE7ais"
  },
  {
    code: "ca",
    id: "ca-ES",
    fullName: "Catalan",
    nativeName: "Catal\xE0"
  }
];
function normalizeLanguageCandidate(input) {
  return input.trim().replace(/_/g, "-").toLowerCase();
}
__name(normalizeLanguageCandidate, "normalizeLanguageCandidate");
function matchesLocaleToken(candidate, token) {
  return candidate === token || candidate.startsWith(`${token}-`) || candidate.startsWith(`${token}.`) || candidate.startsWith(`${token}@`);
}
__name(matchesLocaleToken, "matchesLocaleToken");
function getMatchedLocaleTokenLength(candidate, language) {
  const code = language.code.toLowerCase();
  const id = language.id.toLowerCase();
  if (matchesLocaleToken(candidate, id)) {
    return id.length;
  }
  if (matchesLocaleToken(candidate, code)) {
    return code.length;
  }
  return void 0;
}
__name(getMatchedLocaleTokenLength, "getMatchedLocaleTokenLength");
function resolveSupportedLanguage(input) {
  const normalized = normalizeLanguageCandidate(input);
  if (!normalized) {
    return void 0;
  }
  let bestMatch;
  for (const language of SUPPORTED_LANGUAGES) {
    if (normalized === language.fullName.toLowerCase() || language.nativeName && normalized === language.nativeName.toLowerCase()) {
      return language.code;
    }
    const tokenLength = getMatchedLocaleTokenLength(normalized, language);
    if (tokenLength !== void 0 && (!bestMatch || tokenLength > bestMatch.tokenLength)) {
      bestMatch = { code: language.code, tokenLength };
    }
  }
  return bestMatch?.code;
}
__name(resolveSupportedLanguage, "resolveSupportedLanguage");
function getLanguageNameFromLocale(locale) {
  const resolved = resolveSupportedLanguage(locale);
  const lang = resolved ? SUPPORTED_LANGUAGES.find((language) => language.code === resolved) : void 0;
  return lang?.fullName || "English";
}
__name(getLanguageNameFromLocale, "getLanguageNameFromLocale");
function getLanguageSettingsOptions() {
  return [
    { value: "auto", label: "Auto (detect from system)" },
    ...SUPPORTED_LANGUAGES.map((l) => ({
      value: l.code,
      label: l.nativeName ? `${l.nativeName} (${l.fullName})` : `${l.fullName} (${l.id})`
    }))
  ];
}
__name(getLanguageSettingsOptions, "getLanguageSettingsOptions");
function getSupportedLanguageIds(separator = "|") {
  return SUPPORTED_LANGUAGES.map((l) => l.id).join(separator);
}
__name(getSupportedLanguageIds, "getSupportedLanguageIds");

export {
  SUPPORTED_LANGUAGES,
  resolveSupportedLanguage,
  getLanguageNameFromLocale,
  getLanguageSettingsOptions,
  getSupportedLanguageIds
};
/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */
