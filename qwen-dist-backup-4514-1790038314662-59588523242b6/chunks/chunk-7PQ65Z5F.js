// Force strict mode and setup for ESM
"use strict";
import {
  isTeamAutoMemPath
} from "./chunk-RVT5L74D.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/memory/team-memory-secret-guard.ts
init_esbuild_shims();

// packages/core/src/memory/secret-scanner.ts
init_esbuild_shims();
var SECRET_RULES = [
  // Cloud providers
  {
    id: "aws-access-token",
    // Suffix is base62 ([A-Z0-9]) per gitleaks; base32 [A-Z2-7] missed 0/1/8/9.
    source: "\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\\b"
  },
  {
    id: "alibaba-cloud-access-key",
    source: "\\b(LTAI[a-zA-Z0-9]{12,20})\\b"
  },
  // A distinctive prefix + a high-entropy length is enough to identify these;
  // no trailing delimiter is required (requiring one missed secrets followed by
  // `.` `,` `)` `}` — common in prose and code samples).
  {
    id: "gcp-api-key",
    source: "AIza[\\w-]{35}"
  },
  {
    // Google OAuth client secret (GOCSPX- prefix + 24 base64url chars).
    id: "gcp-oauth-client-secret",
    source: "GOCSPX-[\\w-]{24}"
  },
  {
    id: "digitalocean-pat",
    source: "dop_v1_[a-f0-9]{64}"
  },
  // AI APIs
  {
    id: "anthropic-api-key",
    source: "sk-ant-[a-zA-Z0-9_-]{20,}"
  },
  {
    // New project/service/admin prefixes, the T3BlbkFJ-marker format, and the
    // retired bare `sk-` + 48 base62 chars (archived legacy keys).
    // Both classes around the T3BlbkFJ literal are upper-bounded ({20,512}, like
    // `private-key`): two unbounded {20,} quantifiers around a literal that may
    // be absent backtrack in O(n²) on crafted `sk-…` input (ReDoS). Real keys
    // are far shorter than the bound, so genuine matches are unaffected.
    id: "openai-api-key",
    source: "sk-(?:proj|svcacct|admin)-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9_-]{20,512}T3BlbkFJ[a-zA-Z0-9_-]{20,512}|sk-[a-zA-Z0-9]{48}"
  },
  {
    id: "huggingface-access-token",
    source: "hf_[a-zA-Z0-9]{34,}"
  },
  // Version control
  { id: "github-pat", source: "ghp_[0-9a-zA-Z]{36}" },
  { id: "github-fine-grained-pat", source: "github_pat_\\w{82}" },
  { id: "github-app-token", source: "(?:ghu|ghs)_[0-9a-zA-Z]{36}" },
  { id: "github-oauth", source: "gho_[0-9a-zA-Z]{36}" },
  { id: "gitlab-pat", source: "glpat-[\\w-]{20}" },
  // Communication
  {
    id: "slack-bot-token",
    // The [b] class avoids embedding a Slack token prefix that vsce flags.
    source: "xox[b]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*"
  },
  {
    id: "slack-app-token",
    source: "xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+",
    flags: "i"
  },
  {
    // SendGrid API key: SG. + 22-char id . + 43-char secret (gitleaks).
    id: "sendgrid-api-token",
    source: "SG\\.[\\w-]{22}\\.[\\w-]{43}"
  },
  // Dev tooling
  { id: "npm-access-token", source: "npm_[a-zA-Z0-9]{36}" },
  {
    id: "stripe-access-token",
    source: "(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}"
  },
  // Crypto
  {
    id: "private-key",
    source: "-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,16384}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----",
    flags: "i"
  }
];
var compiledRules = null;
function getCompiledRules() {
  compiledRules ??= SECRET_RULES.map((r) => ({
    id: r.id,
    re: new RegExp(r.source, r.flags)
  }));
  return compiledRules;
}
__name(getCompiledRules, "getCompiledRules");
var LABEL_SPECIAL_CASE = {
  aws: "AWS",
  gcp: "GCP",
  api: "API",
  pat: "PAT",
  oauth: "OAuth",
  npm: "NPM",
  github: "GitHub",
  gitlab: "GitLab",
  openai: "OpenAI",
  digitalocean: "DigitalOcean",
  huggingface: "HuggingFace",
  alibaba: "Alibaba",
  sendgrid: "SendGrid"
};
function ruleIdToLabel(ruleId) {
  return ruleId.split("-").map(
    (part) => LABEL_SPECIAL_CASE[part] ?? part.charAt(0).toUpperCase() + part.slice(1)
  ).join(" ");
}
__name(ruleIdToLabel, "ruleIdToLabel");
function scanForSecrets(content) {
  const matches = [];
  for (const rule of getCompiledRules()) {
    if (rule.re.test(content)) {
      matches.push({ ruleId: rule.id, label: ruleIdToLabel(rule.id) });
    }
  }
  return matches;
}
__name(scanForSecrets, "scanForSecrets");

// packages/core/src/memory/team-memory-secret-guard.ts
var debugLogger = createDebugLogger("TEAM_MEMORY_SECRET_GUARD");
function checkTeamMemorySecrets(filePath, content, projectRoot) {
  if (!isTeamAutoMemPath(filePath, projectRoot)) {
    return null;
  }
  const matches = scanForSecrets(content);
  if (matches.length === 0) {
    return null;
  }
  debugLogger.debug(
    `Blocked team-memory write; matched rules: ${matches.map((m) => m.ruleId).join(", ")}`
  );
  const labels = matches.map((m) => m.label).join(", ");
  return `Content contains potential secrets (${labels}) and cannot be written to team memory. Team memory is shared with all repository collaborators. Remove the sensitive content and try again.`;
}
__name(checkTeamMemorySecrets, "checkTeamMemorySecrets");

export {
  scanForSecrets,
  checkTeamMemorySecrets
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
