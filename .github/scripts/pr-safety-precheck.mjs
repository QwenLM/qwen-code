#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const SECRET_NAME_PATTERN = String.raw`secrets\.[A-Z0-9_]+|process\.env\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|_PAT)|\b(?:GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY)\b`;
const LOGGING_SINK_PATTERN = String.raw`\b(?:console\.\w+|process\.(?:stdout|stderr)\.write)\s*\(`;
const NETWORK_SINK_PATTERN = String.raw`\b(?:fetch|axios|curl|wget)\b`;

function secretSinkPattern(sinkPattern) {
  return new RegExp(
    String.raw`(?:${sinkPattern}[\s\S]{0,500}(?:${SECRET_NAME_PATTERN})|(?:${SECRET_NAME_PATTERN})[\s\S]{0,500}${sinkPattern})`,
    'i',
  );
}

const SENSITIVE_DIFF_PATTERNS = [
  ['sensitive_diff:secret_logging', secretSinkPattern(LOGGING_SINK_PATTERN)],
  ['sensitive_diff:secret_network', secretSinkPattern(NETWORK_SINK_PATTERN)],
];

// Paths that decide what CI executes or what the review agent reads as
// instructions. An untrusted author changing one is escalating authority, not
// proposing product code, so "let the full review judge it" is circular here:
// the reviewer is the target. Gate first, let a maintainer opt in.
const PROTECTED_DIR_PREFIXES = [
  '.github/',
  '.agents/',
  'scripts/',
  '.qwen/skills/',
  '.qwen/commands/',
  '.qwen/agents/',
  '.qwen/workflows/',
  '.qwen/extensions/',
  '.qwen/scripts/',
  '.qwen/rules/',
];
// Context files load hierarchically, so a nested copy steers the agent too.
// QWEN.local.md is the project-local slot the memory loader appends; both it
// and .qwen/rules/ are read only under folder trust, so they are latent
// channels today rather than live ones. Protected anyway: a lane that turns
// trust on must not silently widen what an outside PR can inject.
const PROTECTED_FILE_NAMES = new Set([
  'AGENTS.md',
  'QWEN.md',
  'QWEN.local.md',
  'CLAUDE.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.pnpmfile.mjs',
]);
const PROTECTED_FILE_PATHS = new Set(['.qwen/settings.json']);

// Credentials the runner holds ambiently, reachable without naming a single
// GitHub secret. #18362 read these from a CI script and #18364 asked the agent
// to read them; neither payload names `secrets.*`, so the sink pairs above
// cannot see them. The source itself is the signal.
const AMBIENT_CREDENTIAL_PATTERNS = [
  [
    'ambient_credential:cloud_metadata',
    /100\.100\.100\.200|169\.254\.169\.254|169\.254\.170\.2|fd00:ec2::254|metadata\.google\.internal|metadata\.goog/i,
  ],
  [
    'ambient_credential:proc_environ',
    /\/proc\/(?:self|thread-self|\d+|\$\$|\$\{?\w+\}?)(?:\/task\/(?:\d+|\$\$|\$\{?\w+\}?))?\/environ/,
  ],
  // Every shape that prints the whole environment. The dump commands share one
  // terminator lookahead, applied once outside their alternation: an operator, a
  // closing paren (so `$(env)` works), end of line, or a quote that closes the
  // wrapper and is followed by the same — that last case is what reaches a dump
  // placed after the first command of a `-c` string (`bash -c "cd repo; env"`).
  // `printenv` needs no terminator since it has no option grammar. An assignment
  // prefix is allowed because `env FOO=bar` with no utility is itself a dump,
  // while `env FOO=bar cmd` still stops at the utility. Flags may precede `-c`.
  // Remaining disclosed gaps: option grammar such as `env -u NAME`, and command
  // prefixes outside the anchor set such as `time env` or `command env`.
  [
    'ambient_credential:env_dump',
    /(?:^|[;&|(`]|\$\()\s*(?:env(?:\s+(?:-0|--null))?(?:\s+[A-Za-z_]\w*=\S+)*|export(?:\s+-p)?|set|(?:declare|typeset)(?:\s+-\w*[xp]\w*)?)(?=\s*(?:[|;&>)]|$)|["'](?=\s*(?:[|;&>)]|$)))|(?:^|[;&|(`]|\$\()\s*printenv\b|\b(?:bash|sh|zsh|dash)\s+(?:--?[A-Za-z][\w-]*(?:=\S+)?\s+)*-[a-z]*c[a-z]*\s*["']\s*(?:env(?:\s+(?:-0|--null))?(?:\s+[A-Za-z_]\w*=\S+)*|printenv\b|export(?:\s+-p)?|set|(?:declare|typeset)(?:\s+-\w*[xp]\w*)?)(?=\s*(?:[|;&>]|["']|$))/m,
  ],
  // `.credentials` needs a boundary that admits every spelling of a file read
  // — bare, quoted (including a markdown code span's backtick), or after a
  // separator — while refusing property access. The allowed set is enumerated
  // rather than negated: a negated class also admits `?` and `)`, which gated
  // ordinary TypeScript such as `a?.credentials` and `(await
  // client).credentials`. A dot is excluded so `{ ...credentials }` stays
  // ungated.
  [
    'ambient_credential:credential_file',
    /\.aws\/credentials|\.docker\/config\.json|\.config\/gcloud|\.kube\/config|\.ssh\/id_[a-z0-9]+|\.netrc\b|\.git-credentials|(?:^|[/\\\s"'`])\.credentials\b/,
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
    'secret_value:url_credentials',
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]{20,}@/i,
  ],
  [
    'secret_value:assignment',
    /(?:^|[^A-Za-z0-9])(?:[A-Z0-9_-]*(?:api[_-]?key|token|secret|password|pat))\b[^=\n:]{0,32}(?::?=|:)\s*['"`][A-Za-z0-9._~+/=-]{20,}['"`]/i,
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

// Git quotes a path containing a tab, a newline or (with core.quotePath) a
// non-ASCII byte. Left quoted, `.github/...` no longer matches a prefix test,
// so a file added under a protected directory with such a name would walk past
// the gate. Unquote before testing; the escapes sit after the prefix.
function diffPath(raw) {
  const unquoted =
    raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.replace(/^[ab]\//, '');
}

// `---`/`+++` carry one unambiguous path each, so they cover deletions, renames
// and paths containing spaces. The `diff --git` header also covers mode-only
// changes, which emit no side headers.
function changedPaths(diffText) {
  const paths = new Set();
  for (const line of diffText.split('\n')) {
    const header = /^diff --git .*? ("?b\/.+)$/.exec(line);
    const side = /^(?:---|\+\+\+) (.+)$/.exec(line);
    const rename = /^rename (?:from|to) (.+)$/.exec(line);
    const raw = header?.[1] ?? side?.[1] ?? rename?.[1];
    if (!raw) continue;
    const path = diffPath(raw);
    if (path !== '/dev/null') paths.add(path);
  }
  return paths;
}

function isProtectedPath(path) {
  return (
    PROTECTED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    PROTECTED_FILE_PATHS.has(path) ||
    PROTECTED_FILE_NAMES.has(path.slice(path.lastIndexOf('/') + 1))
  );
}

export function assessPullRequestSafety({
  pr,
  diff,
  trustedAuthor = false,
  diffTruncated = false,
  metadataUnavailable = false,
}) {
  const reasons = [];
  const headSha = typeof pr?.headRefOid === 'string' ? pr.headRefOid : '';
  const diffText = typeof diff === 'string' ? diff : '';
  let addedText = '';

  if (!headSha) addReason(reasons, 'input:missing_head_sha');

  if (trustedAuthor && reasons.length === 0) {
    return {
      decision: 'allow_triage',
      head_sha: headSha,
      reason_codes: [],
    };
  }

  // A capped diff hides whatever sits past the cap, so a partial read must not
  // be reported as a clean one.
  if (diffTruncated) addReason(reasons, 'input:diff_truncated');

  // Without the title and body the body-only channel is simply not scanned, so
  // an API failure would silently reopen the exact hole this gate closes.
  if (metadataUnavailable) addReason(reasons, 'input:metadata_unavailable');

  if (!diffText) {
    addReason(reasons, 'input:diff_unavailable');
  } else {
    addedText = diffText
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');
    checkPatterns(addedText, SENSITIVE_DIFF_PATTERNS, reasons);
    if ([...changedPaths(diffText)].some(isProtectedPath)) {
      addReason(reasons, 'protected_path:authority_surface');
    }
  }

  const prText = `${pr?.title ?? ''}\n${pr?.body ?? ''}\n${addedText}`;
  checkPatterns(prText, SECRET_VALUE_PATTERNS, reasons);
  checkPatterns(prText, PROMPT_INJECTION_PATTERNS, reasons);
  checkPatterns(prText, AMBIENT_CREDENTIAL_PATTERNS, reasons);

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
  const trustedAuthor = args['trusted-author'] === 'true';
  const diffTruncated = args['diff-truncated'] === 'true';
  const metadataUnavailable = args['metadata-unavailable'] === 'true';
  const result = assessPullRequestSafety({
    pr,
    diff,
    trustedAuthor,
    diffTruncated,
    metadataUnavailable,
  });

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
