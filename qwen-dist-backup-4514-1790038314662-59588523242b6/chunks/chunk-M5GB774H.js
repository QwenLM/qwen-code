// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/logRedaction.ts
init_esbuild_shims();
var REDACTED = "<redacted>";
var CREDENTIAL_PATTERNS = [
  // Bearer tokens (Feishu, Weixin, Daemon SDK).
  // Charset covers RFC 6750 token68 plus base64 (+, /, =, ~, .).
  {
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: `$1${REDACTED}`
  },
  // QQ Bot tokens (uses "QQBot" prefix instead of "Bearer")
  {
    pattern: /(QQBot\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: `$1${REDACTED}`
  },
  // Authorization header catch-all (Basic and single-credential schemes).
  // Matches "<scheme> <credential>" (up to 2 tokens). Multi-parameter
  // schemes like Digest are only partially redacted — acceptable since
  // channel SDKs use Bearer/Basic exclusively.
  // Must come after Bearer/QQBot so those get the more specific replacement.
  {
    pattern: /(Authorization:\s*)\S+(?:\s+\S+)?/gi,
    replacement: `$1${REDACTED}`
  },
  // DingTalk custom access token header
  {
    pattern: /(x-acs-dingtalk-access-token:\s*)\S+/gi,
    replacement: `$1${REDACTED}`
  },
  // API keys with common prefixes (≥20 chars to avoid false positives on
  // short test fixtures like "sk-test"). Includes hyphens for compound
  // prefixes like sk-proj-, sk-ant-api03-.
  {
    pattern: /sk-[a-zA-Z0-9-]{20,}/g,
    replacement: `sk-${REDACTED}`
  },
  // GitHub / GitLab / Slack tokens.
  // Includes github_pat_ (fine-grained PATs) and ghu_ (app user tokens).
  // Slack tokens use hyphens as separators.
  // The [b]/[p] classes avoid embedding Slack token prefixes that vsce flags.
  {
    pattern: /(?:ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[b]-|xox[p]-)[a-zA-Z0-9_-]{20,}/g,
    replacement: REDACTED
  },
  // AWS access key IDs (permanent AKIA + temporary STS ASIA)
  {
    pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    replacement: REDACTED
  },
  // Key=value assignments for simple secret names (token=, secret=, etc.)
  {
    pattern: /((?:api[_-]?key|token|secret|password|pwd)[_-]?[=:]\s*)\S{10,}/gi,
    replacement: `$1${REDACTED}`
  },
  // Compound env-var keys ending in _KEY, _TOKEN, _SECRET, or _PASSWORD
  // (e.g. AWS_SECRET_ACCESS_KEY=, QWEN_DAEMON_TOKEN=).
  // Segment lengths are capped to prevent quadratic backtracking on long
  // all-uppercase input.
  {
    pattern: /([A-Z][A-Z0-9]{0,50}(?:_[A-Z0-9]{1,50}){0,10}_(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)\S{10,}/g,
    replacement: `$1${REDACTED}`
  },
  // JSON-quoted secret fields: "token":"...", "client_secret":"...", etc.
  // Uses an explicit key list to avoid backtracking on quoted content.
  {
    pattern: /("(?:api_key|api-key|apikey|token|secret|password|pwd|access_token|client_secret|app_secret|authorization)"\s*:\s*")[^"]{10,}(")/gi,
    replacement: `$1${REDACTED}$2`
  },
  // URL-embedded credentials (scheme://user:pass@host)
  {
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^/\s]+@)+/gi,
    replacement: `$1${REDACTED}@`
  }
];
function redactLogCredentials(line) {
  let result = line;
  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
__name(redactLogCredentials, "redactLogCredentials");

export {
  redactLogCredentials
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
