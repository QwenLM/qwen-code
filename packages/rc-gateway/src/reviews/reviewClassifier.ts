/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Security-critical, escalate-by-default classifier for remote reviews.
 *
 * A remote `/review` runs on the workstation under a per-review permission
 * policy. On each ACP `permission_request` the bridge (C.2) asks this pure
 * function whether the call may auto-approve or must be escalated to a human
 * vote. A false "approve" on the wrong call is a workstation-compromise path
 * (a prompt-injected diff can steer the reviewing agent), so the ONLY rule
 * that matters is: **when in any doubt, escalate.** It is always safe to
 * escalate a call; it is never safe to approve one we are unsure about.
 *
 * The permission frame carries the ACP `ToolCall` shape
 * `{ kind, title, rawInput }` and NO tool-name — so we key on `kind` plus
 * `rawInput`. See docs/superpowers/specs/2026-07-20-remote-review-design.md
 * "The permission bridge".
 */

export interface ReviewToolCall {
  kind?: string;
  title?: string;
  rawInput?: Record<string, unknown>;
}

export interface ReviewPolicy {
  /** false = vote mode: escalate everything. */
  autoApprove: boolean;
  autofix: boolean;
  comment: boolean;
}

export type ReviewDecision = 'approve' | 'escalate';

/**
 * Only these characters may appear in an auto-approvable shell command.
 * Anything else forces escalation. The class is a LITERAL-space whitelist
 * (note: not `\s`, so tab and newline are excluded). It rejects every shell
 * metacharacter — `; & | $ \` < > ( ) { } ' " \ * ? ! ~ # % ^ + [ ] newline
 * tab` — which defeats substitution/redirection/chaining/globbing smuggling
 * like `git diff; rm -rf /`, `echo $(cat secret)`, or `` git diff `id` ``.
 */
const SAFE_SHELL_CHARS = /^[A-Za-z0-9 _\-./=:@,]+$/;

/**
 * Flags that turn an otherwise-read-only allowlisted command into an
 * arbitrary-code-execution or arbitrary-file-write primitive. Escalated no
 * matter which allowlisted command carries them. Categories:
 *  - git config / external-diff / textconv / pager machinery runs arbitrary
 *    programs: `-c`, `--config-env`, `--ext-diff`, `--textconv`, `--pager`,
 *    `--open-files-in-pager`, `--exec-path`, `--exec`.
 *  - git remote-exec transports: `--upload-pack`, `--receive-pack`.
 *  - arbitrary file write: `--output`/`-o`/`-O`, `--output-file`, and tsc's
 *    emit-path flags (`--outFile`, `--outDir`, `--out`, `--declarationDir`,
 *    `--tsBuildInfoFile`, `--generateTrace`).
 */
const DANGEROUS_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '-o',
  '-O',
  '--config-env',
  '--ext-diff',
  '--textconv',
  '--pager',
  '--open-files-in-pager',
  '--exec-path',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  '--output',
  '--output-file',
  '--outFile',
  '--outDir',
  '--out',
  '--declarationDir',
  '--tsBuildInfoFile',
  '--generateTrace',
]);

/**
 * argv[0] → allowed argv[1] verbs. `true` = any subcommand allowed (project
 * build wrappers whose recipes are, by design, the reviewed tree's own code —
 * see the threat model's accepted "build/test runs the PR author's code"
 * residual). Only genuinely read-only git subcommands are listed; `branch`
 * (create/delete/rename) is deliberately absent, and `npm ci`/`npm exec`/
 * `pnpm exec` (network install / arbitrary-binary run) are deliberately absent.
 */
const SHELL_ALLOWLIST: Record<string, ReadonlySet<string> | true> = {
  git: new Set([
    'status',
    'diff',
    'log',
    'show',
    'rev-parse',
    'ls-files',
    'cat-file',
  ]),
  npm: new Set(['run', 'test']),
  pnpm: new Set(['run', 'test']),
  yarn: new Set(['run', 'test']),
  npx: new Set(['tsc', 'vitest', 'jest', 'eslint']),
  cargo: new Set(['build', 'test', 'check', 'clippy']),
  go: new Set(['build', 'test', 'vet']),
  mvn: true,
  './mvnw': true,
  mvnw: true,
  gradle: true,
  './gradlew': true,
  gradlew: true,
  make: new Set(['build', 'test', 'check']),
  tsc: true,
  qwen: new Set(['review']),
  mkdir: true, // gated below to paths under a real `.qwen` segment, no `..`.
};

/**
 * `gh api` paths that post a PR review comment (the sole sanctioned `gh`
 * mutation). Anything else — `gh repo delete`, `gh secret set`,
 * `gh api user`, a non-reviews endpoint — escalates.
 */
const GH_REVIEW_PATH = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/(reviews|comments)$/;

/** True if a token is a command-injection / file-write flag (bare, `=`-valued,
 * or short-attached like `-o/tmp/x`). */
function isDangerousFlag(tok: string): boolean {
  const bare = tok.split('=', 1)[0];
  if (DANGEROUS_FLAGS.has(bare)) return true;
  // attached short-flag values: -oFILE, -OFILE, -cKEY=VAL
  if (/^-[coO]./.test(tok)) return true;
  return false;
}

function classifyGh(argv: string[], policy: ReviewPolicy): ReviewDecision {
  if (!policy.comment) return 'escalate';
  if (argv[1] !== 'api') return 'escalate';
  const rest = argv.slice(2);
  // `gh api` executes exactly ONE endpoint: the FIRST bare positional. We must
  // pin that positional to a review/comment path — a mere "some token looks
  // like a review path" check is decoy-bypassable
  // (`gh api <bad-endpoint> repos/o/r/pulls/1/reviews`).
  let endpoint: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    // Reject any non-POST HTTP method override (`-X DELETE`, `--method PUT`,
    // `-XDELETE`, `--method=GET`, …); consume the separate-token value.
    if (t === '-X' || t === '--method') {
      if (rest[i + 1] !== 'POST') return 'escalate';
      i++;
      continue;
    }
    const m = t.match(/^(?:-X|--method=)(.+)$/);
    if (m) {
      if (m[1] !== 'POST') return 'escalate';
      continue;
    }
    if (t.startsWith('-')) continue; // some other flag
    if (endpoint === undefined) endpoint = t; // first bare positional = endpoint
  }
  if (endpoint === undefined || !GH_REVIEW_PATH.test(endpoint)) {
    return 'escalate';
  }
  return 'approve';
}

function classifyMkdir(argv: string[]): ReviewDecision {
  const paths = argv.slice(1).filter((t) => !t.startsWith('-'));
  if (paths.length === 0) return 'escalate';
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.includes('..')) return 'escalate'; // traversal escapes .qwen
    if (!segs.includes('.qwen')) return 'escalate'; // must be under a real .qwen
  }
  return 'approve';
}

function classifyShell(command: unknown, policy: ReviewPolicy): ReviewDecision {
  if (typeof command !== 'string') return 'escalate';
  const trimmed = command.trim();
  if (trimmed.length === 0) return 'escalate';
  // Metacharacter gate on the raw string (before any tokenization).
  if (!SAFE_SHELL_CHARS.test(command)) return 'escalate';

  const argv = trimmed.split(/\s+/);
  const cmd = argv[0];
  if (cmd === undefined || cmd.length === 0) return 'escalate';

  // Global dangerous-flag scan: any command-injection / file-write flag on
  // ANY allowlisted command forces escalation (defeats e.g.
  // `git diff --ext-diff`, `git diff --output=/etc/x`, `tsc --outFile ...`).
  for (const tok of argv.slice(1)) {
    if (isDangerousFlag(tok)) return 'escalate';
  }

  // The PR-comment post is a narrowly-scoped `gh api` invocation.
  if (cmd === 'gh') return classifyGh(argv, policy);
  // mkdir is allowed only for creating dirs under a real `.qwen` segment.
  if (cmd === 'mkdir') return classifyMkdir(argv);

  const allowed = SHELL_ALLOWLIST[cmd];
  if (allowed === undefined) return 'escalate';
  if (allowed === true) return 'approve';
  return argv[1] !== undefined && allowed.has(argv[1]) ? 'approve' : 'escalate';
}

export function classifyReviewToolCall(
  toolCall: ReviewToolCall,
  policy: ReviewPolicy,
): ReviewDecision {
  // Vote mode: escalate everything — nothing auto-approves.
  if (!policy.autoApprove) return 'escalate';
  switch (toolCall.kind) {
    case 'read':
    case 'search':
      return 'approve';
    case 'edit':
      return policy.autofix ? 'approve' : 'escalate';
    case 'execute':
      return classifyShell(toolCall.rawInput?.['command'], policy);
    case 'fetch': // exfiltration vector
    case 'other': // agent fanout / lsp / MCP — indistinguishable, escalate
    default:
      return 'escalate';
  }
}
