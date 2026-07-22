/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * Security-critical, escalate-by-default classifier for remote reviews.
 *
 * A remote `/review` runs on the workstation under a per-review permission
 * policy. On each ACP `permission_request` the bridge (C.2) asks this pure
 * function whether the call may auto-approve or must be escalated to a human
 * vote. A false "approve" on the wrong call is a workstation-compromise path
 * (a prompt-injected diff can steer the reviewing agent), so the ONLY rule
 * that matters is: **when in any doubt, escalate.** It is always safe to
 * escalate a call; it is never safe to approve one we cannot prove safe.
 *
 * The permission frame carries the ACP `ToolCall` shape
 * `{ kind, title, rawInput }` and NO tool-name — so we key on `kind` plus
 * `rawInput`. See docs/superpowers/specs/2026-07-20-remote-review-design.md
 * "The permission bridge".
 *
 * Shell handling uses a PER-COMMAND FLAG ALLOWLIST, not a denylist: a denylist
 * cannot prove a flag safe, so any unrecognized flag ESCALATES. This closes
 * attacker-pointed OUT-OF-tree code loads (`--config`, `--manifest-path`,
 * `-f <makefile>`, `--init-script`, `-exec`, `--prefix`, …) which a denylist
 * would miss. `node:path` is used only for pure path math (no fs I/O).
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
  /**
   * Absolute path of the review worktree. An `edit`/`write` under `autofix`
   * auto-approves ONLY if its target path resolves inside this root. `null`
   * (or a non-string) forces every edit to escalate. Wired by the bridge (C.2)
   * / saga (D.2).
   */
  worktreeRoot: string | null;
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

// ---------------------------------------------------------------------------
// Per-command flag allowlists. A command approves ONLY when every argument is
// either an allowed flag, an in-tree path value for a known path-flag, or an
// in-tree positional. Any unrecognized flag → escalate (fail-safe).
// ---------------------------------------------------------------------------

const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'cat-file',
]);
// Small curated set of read-only git presentation flags. Anything unusual
// (e.g. --ext-diff/--output/-c/--pager/--exec-path/--upload-pack) escalates.
const GIT_FLAGS: ReadonlySet<string> = new Set([
  '--stat',
  '--numstat',
  '--shortstat',
  '--name-only',
  '--name-status',
  '--oneline',
  '--summary',
  '--patch',
  '-p',
  '--no-patch',
  '-s',
  '--short',
  '--no-color',
  '--cached',
  '--staged',
  '-w',
  '--unified',
  '-U',
]);

const NPM_SUBCOMMANDS: ReadonlySet<string> = new Set(['run', 'test']);
const NPM_FLAGS: ReadonlySet<string> = new Set();

const CARGO_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'build',
  'test',
  'check',
  'clippy',
]);
const CARGO_FLAGS: ReadonlySet<string> = new Set([
  '--release',
  '--all',
  '--workspace',
  '--all-features',
  '--no-default-features',
  '--locked',
  '--offline',
  '--frozen',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
]);

const GO_SUBCOMMANDS: ReadonlySet<string> = new Set(['build', 'test', 'vet']);
// NOTE: `-exec` deliberately absent (`go test -exec /evil` is arbitrary exec).
const GO_FLAGS: ReadonlySet<string> = new Set([
  '-v',
  '-race',
  '-short',
  '-cover',
  '-count',
  '-run',
  '-tags',
]);

const MAKE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'build',
  'test',
  'check',
]);
// NOTE: `-f`/`--file`/`--makefile` deliberately absent (points make at an
// arbitrary out-of-tree Makefile).
const MAKE_FLAGS: ReadonlySet<string> = new Set([
  '-j',
  '--jobs',
  '-s',
  '--silent',
  '-k',
]);

// mvn/gradle have no fixed subcommand set (they take goals/tasks). Reject
// out-of-tree-load flags (--init-script/-I/-b/-s/--settings/-c/-D/-P) by
// omission, and reject `group:artifact:goal` plugin coordinates via the
// colon-positional guard.
const MVN_GRADLE_FLAGS: ReadonlySet<string> = new Set([
  '--offline',
  '-o',
  '--quiet',
  '-q',
  '--no-daemon',
  '--batch-mode',
  '-B',
  '--stacktrace',
  '--info',
  '--console',
]);

// tsc is pinned: typecheck/emit-control flags plus `-p/--project <in-tree>`.
// Emit-path flags (--outFile/--outDir/--out/--declarationDir/…) are absent.
const TSC_FLAGS: ReadonlySet<string> = new Set([
  '--noEmit',
  '--noEmitOnError',
  '--pretty',
  '--strict',
  '--incremental',
  '--skipLibCheck',
  '--build',
  '-b',
]);
const TSC_PATH_FLAGS: ReadonlySet<string> = new Set(['-p', '--project']);

// The fork's review CLI subcommands the skill actually invokes.
const QWEN_REVIEW_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'fetch-pr',
  'cleanup',
]);
const QWEN_FLAGS: ReadonlySet<string> = new Set(['--remote']);

/**
 * `gh api` paths that post a PR review comment (the sole sanctioned `gh`
 * mutation).
 */
const GH_REVIEW_PATH = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/(reviews|comments)$/;
// Allowed `gh api` flags (each with a value constraint below). Anything else
// (`--input`, `--jq`, `-i`, …) escalates.
const GH_FIELD_FLAGS: ReadonlySet<string> = new Set([
  '-f',
  '-F',
  '--field',
  '--raw-field',
]);
const GH_HEADER_FLAGS: ReadonlySet<string> = new Set(['-H', '--header']);
const GH_METHOD_FLAGS: ReadonlySet<string> = new Set(['-X', '--method']);

/** Split `--flag=value` into `[name, value]`; `[token, undefined]` if no `=`. */
function splitEq(t: string): [string, string | undefined] {
  const i = t.indexOf('=');
  return i === -1 ? [t, undefined] : [t.slice(0, i), t.slice(i + 1)];
}

/**
 * A path token that stays inside the (worktree-relative) tree: relative, with
 * no `..` path segment. Absolute paths and `..` traversal escalate.
 */
function isInTreePathToken(t: string): boolean {
  if (t.length === 0) return false;
  if (t.startsWith('/')) return false; // absolute
  if (t.split('/').includes('..')) return false; // traversal
  return true;
}

interface ArgSpec {
  flags: ReadonlySet<string>;
  pathFlags?: ReadonlySet<string>;
  rejectColonPositional?: boolean;
}

/**
 * Validate the argument tail of an allowlisted command: allowed flags only,
 * in-tree path-flag values, in-tree positionals. Escalate on anything else.
 */
function validateShellArgs(tokens: string[], spec: ArgSpec): ReviewDecision {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      const [name, attached] = splitEq(t);
      if (spec.pathFlags?.has(name)) {
        const val = attached ?? tokens[++i];
        if (val === undefined || !isInTreePathToken(val)) return 'escalate';
        continue;
      }
      if (spec.flags.has(name)) continue;
      return 'escalate';
    }
    // positional
    if (spec.rejectColonPositional && t.includes(':')) return 'escalate';
    if (!isInTreePathToken(t)) return 'escalate';
  }
  return 'approve';
}

function classifyGh(argv: string[], policy: ReviewPolicy): ReviewDecision {
  if (!policy.comment) return 'escalate';
  if (argv[1] !== 'api') return 'escalate';
  const rest = argv.slice(2);
  // `gh api` executes exactly ONE endpoint: the FIRST bare positional. Pin it
  // to a review/comment path (a "some token matches" check is decoy-bypassable
  // via `gh api <bad-endpoint> repos/o/r/pulls/1/reviews`).
  let endpoint: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith('-')) {
      const [name, attached] = splitEq(t);
      if (GH_METHOD_FLAGS.has(name)) {
        const val = attached ?? rest[++i];
        if (val !== 'POST') return 'escalate'; // only POST a review
        continue;
      }
      if (GH_FIELD_FLAGS.has(name)) {
        const val = attached ?? rest[++i];
        // `@` = read-file-from-disk (e.g. `-F body=@/home/user/.ssh/id_rsa`),
        // an exfiltration primitive.
        if (val === undefined || val.includes('@')) return 'escalate';
        continue;
      }
      if (GH_HEADER_FLAGS.has(name)) {
        const val = attached ?? rest[++i];
        if (val === undefined) return 'escalate';
        continue;
      }
      return 'escalate'; // unknown gh flag (--input, --jq, …)
    }
    if (endpoint === undefined) endpoint = t; // first bare positional
  }
  if (endpoint === undefined || !GH_REVIEW_PATH.test(endpoint)) {
    return 'escalate';
  }
  return 'approve';
}

/**
 * A `mkdir` (the review skill's `mkdir -p <cwd>/.qwen/reviews`) auto-approves
 * ONLY when every target path resolves INSIDE the review worktree — the SAME
 * string-level confinement `classifyEdit` applies, so an empty-dir mutation can
 * no longer land out-of-tree (`mkdir -p /home/victim/.qwen/x` used to approve on
 * the mere presence of a `.qwen` segment). `worktreeRoot` null/empty → escalate
 * (cannot confine). The legitimate absolute (`<worktree>/.qwen/reviews`) and
 * relative (`.qwen/reviews`) forms both still approve.
 */
function classifyMkdir(argv: string[], policy: ReviewPolicy): ReviewDecision {
  const { worktreeRoot } = policy;
  if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0) {
    return 'escalate';
  }
  const rootAbs = resolve(worktreeRoot);
  const paths = argv.slice(1).filter((t) => !t.startsWith('-'));
  if (paths.length === 0) return 'escalate';
  for (const p of paths) {
    const segs = p.split('/');
    if (segs.includes('..')) return 'escalate'; // traversal escapes .qwen
    if (!segs.includes('.qwen')) return 'escalate'; // must be under a real .qwen
    if (!isInsideRoot(rootAbs, p)) return 'escalate'; // out-of-tree target
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

  switch (cmd) {
    case 'gh':
      return classifyGh(argv, policy);
    case 'mkdir':
      return classifyMkdir(argv, policy);
    case 'git':
      if (!GIT_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: GIT_FLAGS });
    case 'npm':
    case 'pnpm':
    case 'yarn':
      if (!NPM_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: NPM_FLAGS });
    case 'cargo':
      if (!CARGO_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: CARGO_FLAGS });
    case 'go':
      if (!GO_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: GO_FLAGS });
    case 'make':
      if (!MAKE_SUBCOMMANDS.has(argv[1])) return 'escalate';
      return validateShellArgs(argv.slice(2), { flags: MAKE_FLAGS });
    case 'mvn':
    case 'mvnw':
    case './mvnw':
    case 'gradle':
    case 'gradlew':
    case './gradlew':
      return validateShellArgs(argv.slice(1), {
        flags: MVN_GRADLE_FLAGS,
        rejectColonPositional: true,
      });
    case 'tsc':
      return validateShellArgs(argv.slice(1), {
        flags: TSC_FLAGS,
        pathFlags: TSC_PATH_FLAGS,
      });
    case 'qwen':
      if (argv[1] !== 'review') return 'escalate';
      if (!QWEN_REVIEW_SUBCOMMANDS.has(argv[2])) return 'escalate';
      return validateShellArgs(argv.slice(3), { flags: QWEN_FLAGS });
    default:
      return 'escalate';
  }
}

// Every path-like field an `edit`/`write` (Kind.Edit) tool can carry:
// `edit`/`write_file` use `file_path`, `notebook_edit` uses `notebook_path`.
// `path`/`filePath`/`absolute_path` are included defensively so a divergent
// decoy field can never slip an out-of-tree write past confinement.
//
// Exported so the permission bridge (C.2) confines the SAME field set with its
// `fs.realpath` symlink check — the two layers must never drift (a field the
// classifier string-confines but the bridge does not realpath-verify would be a
// hole). See reviewPermissionBridge.ts Guard 2.
export const EDIT_PATH_FIELDS = [
  'file_path',
  'notebook_path',
  'path',
  'filePath',
  'absolute_path',
] as const;

/** True iff `p` resolves (string-level only) inside `rootAbs`. */
function isInsideRoot(rootAbs: string, p: string): boolean {
  const targetAbs = resolve(rootAbs, p);
  const rel = relative(rootAbs, targetAbs);
  if (rel.length === 0) return true; // path === root (degenerate, inside)
  if (isAbsolute(rel)) return false; // different filesystem root
  if (rel === '..' || rel.startsWith('..' + sep)) return false; // escapes
  return true;
}

/**
 * An `edit`/`write` under `autofix` may auto-approve ONLY when its target path
 * resolves inside the review worktree. EVERY present path field is confined —
 * not first-wins — so a divergent decoy (`{file_path:'src/a.ts',
 * path:'/etc/passwd'}`) cannot slip through. Escalate if no path field is
 * present, or if any present one is non-string/empty or resolves outside.
 *
 * SECURITY CAVEAT — STRING-LEVEL ONLY: this uses `path.resolve` and does NOT
 * resolve symlinks. A symlink committed *inside* the worktree (e.g.
 * `evil -> /home/user/.ssh/authorized_keys`) resolves "inside" by path math yet
 * the write follows it OUTSIDE the worktree. A pure function has no fs and
 * cannot detect this. The caller (the permission bridge, C.2) MUST
 * `fs.realpath`-verify the edit target — or its parent dir, for a
 * not-yet-existing file — against the realpath'd worktree root before honoring
 * an `approve` for an `edit`/write. The classifier alone does NOT guarantee the
 * write lands inside the worktree.
 */
function classifyEdit(
  rawInput: Record<string, unknown> | undefined,
  worktreeRoot: string | null,
): ReviewDecision {
  if (typeof worktreeRoot !== 'string' || worktreeRoot.length === 0) {
    return 'escalate';
  }
  const rootAbs = resolve(worktreeRoot);
  let sawPath = false;
  for (const key of EDIT_PATH_FIELDS) {
    const v = rawInput?.[key];
    if (v === undefined || v === null) continue; // field absent
    sawPath = true;
    if (typeof v !== 'string' || v.length === 0) return 'escalate';
    if (!isInsideRoot(rootAbs, v)) return 'escalate';
  }
  if (!sawPath) return 'escalate'; // no path to confine
  return 'approve';
}

/**
 * Classify a single review tool call into `approve` (auto-approve) or
 * `escalate` (human vote).
 *
 * TRUST BOUNDARY — this classifier trusts the INTEGRITY of `toolCall.kind`: the
 * daemon assigns it from each tool's registered `Kind` enum, NOT from the model
 * or the reviewed diff, so keying auto-approval on `kind` is sound. C.2 must
 * confirm this assumption holds for the frames it feeds in (a spoofable `kind`
 * would break the `read`/`search`-approve-on-kind-alone shortcut below).
 *
 * SECURITY CAVEAT — an `edit` approval is STRING-LEVEL path confinement only and
 * does NOT resolve symlinks; the bridge (C.2) MUST `fs.realpath`-verify the edit
 * target against the worktree root before honoring it. See `classifyEdit`.
 */
export function classifyReviewToolCall(
  toolCall: ReviewToolCall,
  policy: ReviewPolicy,
): ReviewDecision {
  // Vote mode: escalate everything — nothing auto-approves.
  if (!policy.autoApprove) return 'escalate';
  switch (toolCall.kind) {
    // read/search approve on `kind` alone with no payload inspection — safe
    // ONLY because the daemon sets `kind` from the tool's registered Kind (see
    // the trust-boundary note above), not from attacker-influenced input.
    case 'read':
    case 'search':
      return 'approve';
    case 'edit':
      return policy.autofix
        ? classifyEdit(toolCall.rawInput, policy.worktreeRoot)
        : 'escalate';
    case 'execute':
      return classifyShell(toolCall.rawInput?.['command'], policy);
    case 'fetch': // exfiltration vector
    case 'other': // agent fanout / lsp / MCP — indistinguishable, escalate
    default:
      return 'escalate';
  }
}
