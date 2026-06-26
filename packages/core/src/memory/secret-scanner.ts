/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Secret scanner for team memory.
 *
 * Team memory is committed to the repository and shared with every
 * collaborator, so credentials must never be written into it. This scans
 * content for high-confidence credential patterns before a write is allowed.
 *
 * Rules are a curated subset of gitleaks (https://github.com/gitleaks/gitleaks,
 * MIT) — only patterns with distinctive prefixes and near-zero false-positive
 * rates. gitleaks uses Go regex; inline `(?i)` / mode groups are not portable
 * to JS, so affected rules are rewritten with explicit character classes.
 */

interface SecretRule {
  /** gitleaks rule ID (kebab-case), used in labels */
  id: string;
  /** Regex source, compiled lazily on first scan */
  source: string;
  /** Optional JS regex flags (rules are case-sensitive unless set) */
  flags?: string;
}

export interface SecretMatch {
  /** Rule ID that matched (e.g. "github-pat") */
  ruleId: string;
  /** Human-readable label derived from the rule ID */
  label: string;
}

const SECRET_RULES: readonly SecretRule[] = [
  // Cloud providers
  {
    id: 'aws-access-token',
    source: '\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b',
  },
  {
    id: 'alibaba-cloud-access-key',
    source: '\\b(LTAI[a-zA-Z0-9]{12,20})\\b',
  },
  // A distinctive prefix + a high-entropy length is enough to identify these;
  // no trailing delimiter is required (requiring one missed secrets followed by
  // `.` `,` `)` `}` — common in prose and code samples).
  {
    id: 'gcp-api-key',
    source: 'AIza[\\w-]{35}',
  },
  {
    id: 'digitalocean-pat',
    source: 'dop_v1_[a-f0-9]{64}',
  },

  // AI APIs
  {
    id: 'anthropic-api-key',
    source: 'sk-ant-[a-zA-Z0-9_-]{20,}',
  },
  {
    // New project/service/admin prefixes, the T3BlbkFJ-marker format, and the
    // retired bare `sk-` + 48 base62 chars (archived legacy keys).
    id: 'openai-api-key',
    source:
      'sk-(?:proj|svcacct|admin)-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9-]{20,}T3BlbkFJ[a-zA-Z0-9-]{20,}|sk-[a-zA-Z0-9]{48}',
  },
  {
    id: 'huggingface-access-token',
    source: 'hf_[a-zA-Z0-9]{34,}',
  },

  // Version control
  { id: 'github-pat', source: 'ghp_[0-9a-zA-Z]{36}' },
  { id: 'github-fine-grained-pat', source: 'github_pat_\\w{82}' },
  { id: 'github-app-token', source: '(?:ghu|ghs)_[0-9a-zA-Z]{36}' },
  { id: 'github-oauth', source: 'gho_[0-9a-zA-Z]{36}' },
  { id: 'gitlab-pat', source: 'glpat-[\\w-]{20}' },

  // Communication
  {
    id: 'slack-bot-token',
    source: 'xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*',
  },
  {
    id: 'slack-app-token',
    source: 'xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+',
    flags: 'i',
  },

  // Dev tooling
  { id: 'npm-access-token', source: 'npm_[a-zA-Z0-9]{36}' },
  {
    id: 'stripe-access-token',
    source: '(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}',
  },

  // Crypto
  {
    id: 'private-key',
    source:
      '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----',
    flags: 'i',
  },
];

let compiledRules: Array<{ id: string; re: RegExp }> | null = null;

function getCompiledRules(): Array<{ id: string; re: RegExp }> {
  compiledRules ??= SECRET_RULES.map((r) => ({
    id: r.id,
    re: new RegExp(r.source, r.flags),
  }));
  return compiledRules;
}

const LABEL_SPECIAL_CASE: Record<string, string> = {
  aws: 'AWS',
  gcp: 'GCP',
  api: 'API',
  pat: 'PAT',
  oauth: 'OAuth',
  npm: 'NPM',
  github: 'GitHub',
  gitlab: 'GitLab',
  openai: 'OpenAI',
  digitalocean: 'DigitalOcean',
  huggingface: 'HuggingFace',
  alibaba: 'Alibaba',
};

/** Convert a kebab-case rule ID to a readable label (e.g. "github-pat" → "GitHub PAT"). */
function ruleIdToLabel(ruleId: string): string {
  return ruleId
    .split('-')
    .map(
      (part) =>
        LABEL_SPECIAL_CASE[part] ??
        part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(' ');
}

/**
 * Scan content for credential patterns. Returns one match per rule that fired
 * (deduplicated by rule ID). The matched value is never returned — only which
 * rule fired — so secret values are never logged or surfaced.
 */
export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const rule of getCompiledRules()) {
    if (rule.re.test(content)) {
      matches.push({ ruleId: rule.id, label: ruleIdToLabel(rule.id) });
    }
  }
  return matches;
}
