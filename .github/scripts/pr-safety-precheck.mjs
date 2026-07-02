#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const SENSITIVE_DIFF_PATTERNS = [
  [
    'sensitive_diff:secret_logging',
    /\b(?:console\.(?:log|error|info|warn)|process\.(?:stdout|stderr)\.write)\s*\([^\n]*(?:secrets\.[A-Z0-9_]+|process\.env\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_PAT)|\b(?:GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY)\b)/i,
  ],
  [
    'sensitive_diff:secret_network',
    /\b(?:fetch|axios|curl|wget)\b[^\n]*(?:secrets\.[A-Z0-9_]+|process\.env\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_PAT)|\b(?:GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY)\b)/i,
  ],
];

const SECRET_VALUE_PATTERNS = [
  ['secret_value:private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    'secret_value:github_token',
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  ],
  ['secret_value:openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['secret_value:aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['secret_value:slack_token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  [
    'secret_value:bearer_token',
    /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  ],
  [
    'secret_value:access_token_param',
    /\baccess_token=[A-Za-z0-9._~+/=-]{20,}\b/i,
  ],
  [
    'secret_value:assignment',
    /\b(?:api[_-]?key|token|secret|password|pat)\b[^=\n:]{0,32}(?:=|:)\s*['"][A-Za-z0-9._~+/=-]{20,}['"]/i,
  ],
];

const PROMPT_INJECTION_PATTERNS = [
  [
    'prompt_injection:ignore_previous',
    /ignore (?:all )?(?:previous|above) instructions/i,
  ],
  ['prompt_injection:system_prompt', /\bsystem prompt\b/i],
  ['prompt_injection:developer_message', /\bdeveloper message\b/i],
  [
    'prompt_injection:print_secrets',
    /\b(?:print|dump|exfiltrate|reveal)\b[^\n]*(?:secret|token|key)s?\b/i,
  ],
  ['prompt_injection:run_gh', /\brun\b[^\n]*\bgh\b/i],
  ['prompt_injection:approve_pr', /\bapprove (?:this )?pr\b/i],
  [
    'prompt_injection:qwen_command',
    /@qwen-code\s+\/(?:triage|review|resolve|tmux)\b/i,
  ],
];

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function checkPatterns(text, patterns, reasons) {
  for (const [code, pattern] of patterns) {
    if (pattern.test(text)) addReason(reasons, code);
  }
}

export function assessPullRequestSafety({ pr, diff }) {
  const reasons = [];
  const headSha = typeof pr?.headRefOid === 'string' ? pr.headRefOid : '';
  const diffText = typeof diff === 'string' ? diff : '';
  let addedText = '';

  if (!headSha) addReason(reasons, 'input:missing_head_sha');

  if (!diffText) {
    addReason(reasons, 'input:diff_unavailable');
  } else {
    addedText = diffText
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');
    checkPatterns(addedText, SENSITIVE_DIFF_PATTERNS, reasons);
  }

  const prText = `${pr?.title ?? ''}\n${pr?.body ?? ''}\n${addedText}`;
  checkPatterns(prText, SECRET_VALUE_PATTERNS, reasons);
  checkPatterns(prText, PROMPT_INJECTION_PATTERNS, reasons);

  return {
    decision: reasons.length === 0 ? 'allow_triage' : 'manual_required',
    head_sha: headSha,
    reason_codes: reasons,
  };
}

export function renderManualRequiredComment(result) {
  const reasons = result.reason_codes.length
    ? result.reason_codes.map((reason) => `- \`${reason}\``).join('\n')
    : '- `unknown`';

  return `<!-- qwen-pr-precheck:manual-required -->
Qwen precheck requires maintainer approval before automated triage/review.

Head SHA: \`${result.head_sha || 'unknown'}\`

Reason:
${reasons}

A maintainer with write access can inspect the PR and manually request a run with \`@qwen-code /triage\` or \`@qwen-code /review\`. A new push requires a fresh precheck.`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function writeGithubOutput(path, result) {
  if (!path) return;
  appendFileSync(path, [`decision=${result.decision}`, ''].join('\n'));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr) throw new Error('Missing --pr');
  if (!args.diff) throw new Error('Missing --diff');

  const pr = JSON.parse(readFileSync(args.pr, 'utf8'));
  const diff = readFileSync(args.diff, 'utf8');
  const result = assessPullRequestSafety({ pr, diff });

  if (args.comment) {
    writeFileSync(
      args.comment,
      result.decision === 'manual_required'
        ? renderManualRequiredComment(result)
        : '',
    );
  }
  writeGithubOutput(args.output ?? process.env.GITHUB_OUTPUT, result);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
