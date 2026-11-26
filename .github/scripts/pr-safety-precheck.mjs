#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  realpathSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

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
  '.qwen/hooks/',
  '.qwen/fork-profiles/',
  'patches/',
  'eslint-rules/',
];
// Context files load hierarchically, so a nested copy steers the agent too.
// QWEN.local.md is the project-local slot the memory loader appends; both it
// and .qwen/rules/ reach the system prompt by default, because the trust flag is
// opt-in hardening rather than an opt-out of trust (isWorkspaceTrusted returns
// true when the flag is off). The review job avoids them only because it checks
// out the default branch, so any lane that runs inside the contributed tree must
// still meet them held.
const PROTECTED_FILE_NAMES = new Set([
  'AGENTS.md',
  'QWEN.md',
  'QWEN.local.md',
  'CLAUDE.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'eslint.config.js',
  'esbuild.config.js',
  'vitest.config.ts',
  '.npmrc',
  '.pnpmfile.mjs',
  '.mcp.json',
]);
// Mirror autoMode's settings variant glob, not just the default filename.
const PROTECTED_SETTINGS_PATH = /(?:^|\/)\.qwen\/settings(?:\.[^/]+)?\.json$/;
const PROTECTED_FILE_PATHS = new Set([
  // Selected independently of the context-file loader: the CLI prefers a
  // project's output-language file and appends it through
  // getExtensionContextFilePaths(), so it reaches the system prompt too.
  '.qwen/output-language.md',
]);

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
  // Recognized shell dump forms, not a complete grammar for arbitrary input.
  // `printenv` has no option grammar, so bare and wrapped calls need no
  // terminator. The other dump commands keep theirs so `env FOO=bar cmd` and
  // `set -euo pipefail` remain ordinary work. Broader spellings are review
  // signals documented in the design, not acceptance claims of this rule.
  [
    'ambient_credential:env_dump',
    /(?:^[ \t]*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+)?|[;&|`]|\$\()\s*\(?\s*(?:env(?:\s+(?:-0|--null))?(?:\s+[A-Za-z_]\w*=\S+)*|export(?:\s+-p)?|set|(?:declare|typeset)(?:\s+-\w*[xp]\w*)?)(?=\s*(?:[|;&<>)]|\d*[<>]|$)|["'](?=\s*(?:[|;&<>)]|\d*[<>]|$)))|(?:^[ \t]*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+)?|[;&|`]|\$\()\s*\(?\s*printenv\b|\b(?:bash|sh|zsh|dash)\s+(?:--?[A-Za-z][\w-]*(?:=\S+)?\s+)*-[a-z]*c[a-z]*\s*["']?\s*(?:printenv\b|(?:env(?:\s+(?:-0|--null))?(?:\s+[A-Za-z_]\w*=\S+)*|export(?:\s+-p)?|set|(?:declare|typeset)(?:\s+-\w*[xp]\w*)?)(?=\s*(?:[|;&>]|["']|$)))/m,
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

const METADATA_HOSTNAMES = new Set([
  '100.100.100.200',
  '169.254.169.254',
  '169.254.170.2',
  '[fd00:ec2::254]',
  'metadata.google.internal',
  'metadata.goog',
]);

// The URL parser already implements inet_aton: integer, hexadecimal and
// short-form hostnames normalize to their dotted IPv4 form. Comparing the
// normalized host avoids enumerating spellings separately.
function normalizedHost(urlString) {
  const hostname = new URL(urlString).hostname;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(hostname);
  if (!mapped) return hostname;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function hasCloudMetadataHost(text) {
  for (const match of text.matchAll(
    /https?:\/\/(?:\[[a-f\d:.]+\](?::\d+)?|[^\s"'`<>\])}]+)[^\s"'`<>\])}]*/gi,
  )) {
    try {
      if (METADATA_HOSTNAMES.has(normalizedHost(match[0]))) return true;
    } catch {
      // A malformed URL is not a usable metadata host match.
    }
  }
  return false;
}

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

// A `--git` header is accepted only when comparing every possible split yields
// two equal halves; the first ` b/` is not necessarily a separator when a path
// itself contains that sequence. Mode-only and binary changes have no side
// headers, so this header is their only path source.
function diffHeaderPath(line) {
  const header = line.slice('diff --git '.length);
  for (
    let i = header.lastIndexOf('b/');
    i > 0;
    i = header.lastIndexOf('b/', i - 1)
  ) {
    const left = header.slice(0, header[i - 1] === '"' ? i - 2 : i - 1);
    const right = header.slice(header[i - 1] === '"' ? i - 1 : i);
    if (diffPath(left) === diffPath(right)) return diffPath(right);
  }
  return null;
}

// `---`/`+++` carry one unambiguous path each, but only outside hunks: a
// diff-illustrating line inside a hunk can have the same prefix.
function changedPaths(diffText) {
  const paths = new Set();
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    let path = null;
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      path = diffHeaderPath(line);
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (!inHunk) {
      const side = /^(?:---|\+\+\+) (.+)$/.exec(line);
      const rename = /^rename (?:from|to) (.+)$/.exec(line);
      if (side || rename) path = diffPath((side ?? rename)[1]);
    }
    if (path && path !== '/dev/null') paths.add(path);
  }
  return paths;
}

function isProtectedPath(path) {
  return (
    PROTECTED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    PROTECTED_SETTINGS_PATH.test(path) ||
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
    // `++` is possible content, not always a side header. Only outside hunks
    // does `+++ ` belong to the file headers.
    const hasHunkHeaders = /^@@ /m.test(diffText);
    let inHunk = !hasHunkHeaders;
    const addedLines = [];
    for (const line of diffText.split('\n')) {
      if (line.startsWith('diff --git ')) inHunk = !hasHunkHeaders;
      else if (line.startsWith('@@ ')) inHunk = true;
      else if (inHunk && line.startsWith('+')) addedLines.push(line.slice(1));
    }
    addedText = addedLines.join('\n');
    checkPatterns(addedText, SENSITIVE_DIFF_PATTERNS, reasons);
    if ([...changedPaths(diffText)].some(isProtectedPath)) {
      addReason(reasons, 'protected_path:authority_surface');
    }
  }

  const prText = `${pr?.title ?? ''}\n${pr?.body ?? ''}\n${addedText}`;
  checkPatterns(prText, SECRET_VALUE_PATTERNS, reasons);
  checkPatterns(prText, PROMPT_INJECTION_PATTERNS, reasons);
  checkPatterns(prText, AMBIENT_CREDENTIAL_PATTERNS, reasons);
  if (hasCloudMetadataHost(prText)) {
    addReason(reasons, 'ambient_credential:cloud_metadata');
  }

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

// Compare resolved URLs: `file://${argv[1]}` never matches when the checkout
// path contains a space (%20) or goes through a symlink (/tmp -> /private/tmp),
// and a silent no-output exit 0 is indistinguishable from a clean decision.
// argv[1] is absent when the module is imported rather than executed, which the
// unit tests and every direct probe do — realpathSync(undefined) throws there.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
