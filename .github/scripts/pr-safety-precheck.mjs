#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const DEFAULT_MAX_DIFF_BYTES = 256 * 1024;
const DEFAULT_MAX_DIFF_LINES = 5000;
const DEFAULT_MAX_FILES = 80;

const SENSITIVE_DIFF_PATTERNS = [
  ['sensitive_diff:pull_request_target', /\bpull_request_target\b/i],
  ['sensitive_diff:workflow_run', /\bworkflow_run\b/i],
  ['sensitive_diff:repository_dispatch', /\brepository_dispatch\b/i],
  ['sensitive_diff:write_all_permissions', /\bpermissions\s*:\s*write-all\b/i],
  ['sensitive_diff:id_token_write', /\bid-token\s*:\s*write\b/i],
  ['sensitive_diff:contents_write', /\bcontents\s*:\s*write\b/i],
  ['sensitive_diff:actions_write', /\bactions\s*:\s*write\b/i],
  [
    'sensitive_diff:self_hosted_runner',
    /\bruns-on\s*:\s*(?:\[.*)?self-hosted\b/i,
  ],
  ['sensitive_diff:secrets_context', /\bsecrets\.[A-Z0-9_]+/i],
  ['sensitive_diff:github_token', /\b(?:GITHUB_TOKEN|GH_TOKEN)\b/],
  ['sensitive_diff:openai_key', /\bOPENAI_API_KEY\b/],
  [
    'sensitive_diff:secret_identifier',
    /\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_PAT)\b/,
  ],
  [
    'sensitive_diff:curl_pipe_shell',
    /\b(?:curl|wget)\b[^\n|]*\|[^\n]*(?:sh|bash)\b/i,
  ],
  ['sensitive_diff:eval', /\beval\s*(?:\(|`|\$)/i],
  ['sensitive_diff:new_function', /\bnew\s+Function\s*\(/],
  [
    'sensitive_diff:child_process',
    /\bchild_process\b|\bexecSync\s*\(|\bexec\s*\(|\bspawn\s*\(/,
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

function filePath(file) {
  if (typeof file === 'string') return file;
  if (file && typeof file.path === 'string') return file.path;
  if (file && typeof file.filename === 'string') return file.filename;
  return '';
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function checkSensitivePath(path, reasons) {
  if (!path) {
    addReason(reasons, 'input:invalid_file_path');
    return;
  }

  if (path.startsWith('.github/')) {
    addReason(reasons, 'sensitive_path:github');
  }
  if (path.startsWith('.devcontainer/')) {
    addReason(reasons, 'sensitive_path:devcontainer');
  }
  if (/^(?:Dockerfile(?:\..*)?|docker-compose[^/]*\.ya?ml)$/i.test(path)) {
    addReason(reasons, 'sensitive_path:container');
  }
  if (
    /(^|\/)(?:\.env|\.env\.[^/]+|secrets?\.|credentials?\.|auth[^/]*|token[^/]*)/i.test(
      path,
    )
  ) {
    addReason(reasons, 'sensitive_path:secret_or_auth');
  }
}

function checkPatterns(text, patterns, reasons) {
  for (const [code, pattern] of patterns) {
    if (pattern.test(text)) addReason(reasons, code);
  }
}

export function assessPullRequestSafety({
  pr,
  diff,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  maxDiffLines = DEFAULT_MAX_DIFF_LINES,
  maxFiles = DEFAULT_MAX_FILES,
}) {
  const reasons = [];
  const headSha = typeof pr?.headRefOid === 'string' ? pr.headRefOid : '';
  const files = Array.isArray(pr?.files) ? pr.files : null;
  const diffText = typeof diff === 'string' ? diff : '';
  let addedText = '';

  if (!headSha) addReason(reasons, 'input:missing_head_sha');
  if (!files) {
    addReason(reasons, 'input:files_unavailable');
  } else {
    if (files.length > maxFiles) addReason(reasons, 'input:too_many_files');
    for (const file of files) checkSensitivePath(filePath(file), reasons);
  }

  if (!diffText) {
    addReason(reasons, 'input:diff_unavailable');
  } else {
    if (Buffer.byteLength(diffText, 'utf8') > maxDiffBytes) {
      addReason(reasons, 'input:diff_too_large');
    }
    if (diffText.split('\n').length > maxDiffLines) {
      addReason(reasons, 'input:diff_too_many_lines');
    }
    if (/Binary files .* differ/i.test(diffText)) {
      addReason(reasons, 'input:binary_diff');
    }
    addedText = diffText
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');
    checkPatterns(addedText, SENSITIVE_DIFF_PATTERNS, reasons);
  }

  const prText = `${pr?.title ?? ''}\n${pr?.body ?? ''}\n${addedText}`;
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
