#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local preflight for a `/verify-pr` maintainer round.
 *
 * The CI lane supplies three things a workstation does not: the PR metadata
 * snapshot (`$QWEN_VERIFY_CONTEXT`), a clone holding both the base and the head
 * OID, and the artifact directory the publication step globs. Resolving them by
 * hand is the part of the local path that fails silently — a snapshot from the
 * wrong repository, `HEAD^1` mistaken for the base on a plain PR-head checkout,
 * or a directory named without the `-verify-` infix all produce a round whose
 * report is about another PR or is discarded outright.
 *
 * This script resolves those coordinates and checks the tree the round will
 * reuse; it does not checkout a worktree, build, or execute PR code. The tree
 * check exists because the round runs the head side of its A/B in the current
 * tree: prepare refuses a HEAD other than the PR head or any uncommitted
 * change, and never stashes for the maintainer. It cannot infer containment
 * from this host process: resolving the coordinates needs `gh`, and `gh` and
 * the boundary are mutually exclusive. The caller explicitly selects an
 * execution mode. A host or VM selection needs a preflight approval recorded
 * in the host-held snapshot; a container still uses the separate
 * `--require-isolation` mode inside the boundary before executing anything.
 *
 * Usage:
 *   node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo> --execution container|vm|host [--trust-pr-head | --approval <permalink>]
 *   node scripts/verify-pr-prepare.mjs --require-isolation [--artifact-dir <round-dir>]
 *
 * Options:
 *   --repo <owner>/<repo>  required for the coordinate path: never inferred
 *                          from `origin`, because a fork's `origin` resolves the
 *                          same PR number to an unrelated PR
 *   --require-isolation    check the process this runs in and exit 4 when no
 *                          boundary is detected; run it inside the boundary
 *   --artifact-dir <dir>   with --require-isolation, a pass writes boundary-gate.json
 *                          into the round's artifact directory — the record the
 *                          checker requires beside a mode:"container" declaration
 *
 * Exit codes:
 *   0  coordinates resolved, or the boundary check passed
 *   2  usage error
 *   3  metadata, OID, tree-state, or filesystem failure (incl. writing the gate record)
 *   4  --require-isolation found no boundary — do not run PR code here
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';
import { checkBoundary } from './verify-pr-check.mjs';
import {
  inFlightRegistration,
  readState as readWatchState,
  statePath as watchStatePath,
  withStateLock,
} from './verify-pr-watch-state.mjs';

const OID = /^[0-9a-f]{40}$/;
const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const EXECUTION_MODES = ['container', 'vm', 'host'];
const PERMISSIONS = ['admin', 'maintain', 'write'];
const APPROVAL_PERMALINK =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)#issuecomment-(\d+)$/;
const APPROVAL_PREFIX = '<!-- verify-pr-boundary-approval:';
const FIELDS = [
  'number',
  'title',
  'body',
  'author',
  'baseRefName',
  'baseRefOid',
  'headRefOid',
  'isCrossRepository',
  'commits',
].join(',');

const HELP = `Usage: node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo> [--execution container] [--context-out <path>] [--local-owner] [--sponsored]
       node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo> --execution vm|host --round <n> --reason <text> --context-out <path> (--trust-pr-head | --approval <permalink> --state-root <trusted-dir>) [--attestation <text>] [--local-owner] [--sponsored]
       node scripts/verify-pr-prepare.mjs --require-isolation [--artifact-dir <round-dir>]

Resolves the coordinates a local /verify-pr round needs and writes the
metadata snapshot the round reads as $QWEN_VERIFY_CONTEXT:

  - fetches the PR snapshot with gh, from the repository you name
  - verifies the base and head OIDs exist in this clone
  - refuses a tree that is not a clean checkout of the PR head, so the round
    can reuse the current tree as the head side of the A/B; the gitignored
    install/build still needs a freshness check before it is reused
  - creates tmp/pr<n>-verify-<YYYYMMDD-HHMMSS>/ with an evidence/ subdirectory
    and a context.json holding repo, pr, baseRefOid and headRefOid
  - snapshots the PR's review threads and standing change requests beside
    the metadata, as the CI lane does; best-effort, so a failed fetch leaves
    no file and the round lists that review state as not covered
  - reports the isolation signals this process can observe

The coordinate path defaults to --execution container for compatibility with
old watch prompts; an omission never mints a host/VM approval. VM and host
must be selected explicitly with --round, --reason, --context-out and one of:
  --trust-pr-head   current maintainer trusts their own or same-repository PR
  --approval <url>  maintainer's marked issue-comment approval for another fork
The approval form also needs --state-root <absolute-trusted-dir> holding the
same in-flight head and round. VM additionally requires --attestation.
Approval verification runs before artifacts are created and writes
executionApproval into the host context; publish checks require its sha256.

The coordinate path runs on the host by construction: it needs gh, and gh and
the boundary are mutually exclusive. For container execution, run
--require-isolation inside the container as the round's first command. VM and
host never run that gate and have no boundary-gate.json.
Exit 4 means this process is not
isolated and must not execute PR code. A container marker alone does not pass:
the CLI's own Docker/Podman launcher mounts ~/.config/gcloud and the ADC file
and copies model API keys, so the check also requires the credential-free
attestation and refuses when a known credential signal is visible. The
built-in macOS sandbox (SANDBOX=sandbox-exec) never counts. With
--artifact-dir, a pass also writes boundary-gate.json there — the record the
checker requires alongside a mode:"container" declaration. The artifact tree
is PR-writable, so the record corroborates an operator who ran the gate; it
is not proof against a round that forges it.
`;

/** Returns `{owner, name}` for a GitHub repository slug, or null. */
export function parseRepo(value) {
  const match = REPO.exec(String(value ?? '').trim());
  if (!match) return null;
  return { owner: match[1], name: match[2] };
}

/**
 * Returns the artifact directory name the publication step globs. The
 * `-verify-` infix is part of that contract, not decoration.
 */
export function artifactDirName(pr, now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('');
  const clock = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  return `pr${pr}-verify-${stamp}-${clock}`;
}

/**
 * The built-in macOS sandbox announces itself with this value while its
 * default `permissive-open` profile still lets the process read host files, so
 * it is not the credential-free boundary the round needs.
 */
export const SEATBELT = 'sandbox-exec';

/**
 * Host-side emergency switch (outside PR-controlled input). When set to `1`,
 * every round is forced into `hardware-isolated`, disabling lightweight
 * trusted exceptions during incident response (§4.4).
 */
export const FORCE_HARDWARE_ENV = 'QWEN_VERIFY_FORCE_HARDWARE';

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const WRITE_PERMISSIONS = new Set(['write', 'maintain', 'admin']);
const NON_WRITE_PERMISSIONS = new Set(['read', 'triage', 'none']);

const ESCALATION_RULES = [
  {
    reason: 'dependency-manifest',
    test: (p) =>
      /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.[cm]?js|\.yarnrc(?:\.yml)?)$/i.test(
        p,
      ) || /^patches\//i.test(p),
  },
  {
    reason: 'maven-build',
    test: (p) =>
      /(?:^|\/)(?:pom\.xml|mvnw(?:\.cmd)?)$/i.test(p) ||
      /(?:^|\/)\.mvn\//i.test(p),
  },
  {
    reason: 'ci-workflow',
    test: (p) => /^\.github\/(?:workflows|actions)\//i.test(p),
  },
  {
    reason: 'verify-or-sandbox-script',
    test: (p) =>
      /^scripts\/(?:verify-pr-|sandbox|lib\/)/i.test(p) ||
      /^\.husky\//i.test(p) ||
      /(?:^|\/)(?:\.gitmodules|\.gitattributes|Dockerfile(?:\.[^/]+)?|docker-compose(?:\.[^/]+)?\.ya?ml|Makefile|esbuild\.config\.[cm]?js|eslint\.config\.[cm]?js|vitest\.config\.[cm]?[jt]s)$/i.test(
        p,
      ),
  },
  {
    reason: 'agent-control-config',
    test: (p) => /(?:^|\/)\.(?:qwen|claude)\//i.test(p),
  },
  {
    reason: 'executable-or-binary',
    test: (p) =>
      /\.(?:node|wasm|so|dylib|dll|exe|bin|sh|bash|zsh|ps1|bat|cmd)$/i.test(p),
  },
];

/**
 * Parses `git diff --raw --no-renames -z` output into changed paths plus
 * git-mode escalation sets (100755 executables, 120000 symlinks, 160000
 * submodules) and extensionless live files eligible for magic-byte sniffing.
 */
export function parseRawDiffEntries(rawStdout) {
  const changedPaths = [];
  const executablePaths = [];
  const specialModePaths = [];
  const extensionlessLivePaths = [];
  if (typeof rawStdout !== 'string' || rawStdout.length === 0) {
    return {
      changedPaths,
      executablePaths,
      specialModePaths,
      extensionlessLivePaths,
    };
  }
  const tokens = rawStdout.split('\0');
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const header = tokens[i];
    const filePath = tokens[i + 1];
    if (!header.startsWith(':') || !filePath) continue;
    const parts = header.slice(1).split(' ');
    const newMode = parts[1] ?? '';
    const status = (parts[4] ?? '').charAt(0);
    changedPaths.push(filePath);
    if (status === 'D') continue;
    if (newMode === '100755') {
      executablePaths.push(filePath);
    } else if (newMode === '120000' || newMode === '160000') {
      specialModePaths.push(filePath);
    } else if (!/\.[^/]+$/.test(basename(filePath))) {
      extensionlessLivePaths.push(filePath);
    }
  }
  return {
    changedPaths,
    executablePaths,
    specialModePaths,
    extensionlessLivePaths,
  };
}

/**
 * Checks the first 4 bytes of a regular file without following symlinks for
 * shebang (`#!`), ELF (`\x7fELF`), Mach-O, or PE (`MZ`) executable headers.
 */
export function hasExecutableMagic(filePath) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(filePath, flags);
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    if (n >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return true; // #!
    if (n >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return true; // MZ (PE)
    if (
      n >= 4 &&
      buf[0] === 0x7f &&
      buf[1] === 0x45 &&
      buf[2] === 0x4c &&
      buf[3] === 0x46
    ) {
      return true; // ELF
    }
    if (n >= 4) {
      const hex = buf.toString('hex');
      if (
        hex === 'feedface' ||
        hex === 'cefaedfe' ||
        hex === 'feedfacf' ||
        hex === 'cffaedfe' ||
        hex === 'cafebabe'
      ) {
        return true; // Mach-O / fat binary
      }
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Returns every mandatory high-assurance escalation trigger matched by the
 * changed file paths in `base..head` (§4.3). These triggers force
 * `hardware-isolated` regardless of author trust; their absence is NOT proof
 * that other changes are benign.
 */
export function detectMandatoryEscalations(
  changedPaths = [],
  { executablePaths = [], specialModePaths = [] } = {},
) {
  const normalizePath = (p) =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const execSet = new Set(
    executablePaths
      .filter((p) => typeof p === 'string')
      .map(normalizePath)
      .filter(Boolean),
  );
  const specialSet = new Set(
    specialModePaths
      .filter((p) => typeof p === 'string')
      .map(normalizePath)
      .filter(Boolean),
  );
  const hits = [];
  for (const raw of changedPaths) {
    if (typeof raw !== 'string') continue;
    const normalized = normalizePath(raw);
    if (!normalized) continue;
    let matched = false;
    for (const rule of ESCALATION_RULES) {
      if (rule.test(normalized)) {
        hits.push({ path: normalized, reason: rule.reason });
        matched = true;
        break;
      }
    }
    if (!matched && specialSet.has(normalized)) {
      hits.push({ path: normalized, reason: 'symlink-or-submodule' });
    } else if (!matched && execSet.has(normalized)) {
      hits.push({ path: normalized, reason: 'executable-or-binary' });
    }
  }
  return hits;
}

/**
 * Classifies a round into `(prTrust, executionClass)` per §4.1–§4.4.
 * Fails closed to `hardware-isolated` on external/fork/unknown identity,
 * missing changed-file data, mandatory escalation paths, or the host-side
 * global hardware switch. `sponsored` authorizes execution budget only and
 * never lowers `executionClass`.
 */
export function classifyPrTrust({
  permission = null,
  isLocalOwner = false,
  isFork = null,
  changedPaths = null,
  executablePaths = [],
  specialModePaths = [],
  forceHardware = false,
  sponsored = false,
} = {}) {
  let prTrust;
  if (isFork === true) {
    prTrust = 'external';
  } else if (isLocalOwner === true) {
    prTrust = 'local-owner';
  } else if (typeof permission === 'string') {
    const perm = permission.trim().toLowerCase();
    if (WRITE_PERMISSIONS.has(perm)) {
      prTrust = 'collaborator';
    } else if (NON_WRITE_PERMISSIONS.has(perm)) {
      prTrust = 'external';
    } else {
      prTrust = 'unknown';
    }
  } else {
    prTrust = 'unknown';
  }

  const escalationReasons = [];
  if (forceHardware === true) {
    escalationReasons.push('global-hardware-only-switch');
  }
  if (!Array.isArray(changedPaths)) {
    escalationReasons.push('changed-files-unavailable');
  } else {
    for (const hit of detectMandatoryEscalations(changedPaths, {
      executablePaths,
      specialModePaths,
    })) {
      escalationReasons.push(`${hit.reason}:${hit.path}`);
    }
  }

  const eligibleForSharedKernel =
    (prTrust === 'local-owner' || prTrust === 'collaborator') &&
    escalationReasons.length === 0;
  const executionClass = eligibleForSharedKernel
    ? 'trusted-shared-kernel'
    : 'hardware-isolated';

  return {
    prTrust,
    executionClass,
    escalationReasons,
    sponsored: Boolean(sponsored),
  };
}

/**
 * Set this only after confirming the boundary mounts no host credentials. A
 * marker says a container exists; it cannot say the container is clean, and
 * the CLI's own Docker/Podman launcher mounts `~/.config/gcloud`, the ADC file
 * and every model API key it can see, so the two questions are separate.
 */
export const CREDENTIAL_FREE_ATTESTATION = 'QWEN_VERIFY_CREDENTIAL_FREE';

const CREDENTIAL_ENV = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'SSH_AUTH_SOCK',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'KUBECONFIG',
  // An arbitrary mount list can carry anything, so it cannot be attested to.
  'SANDBOX_MOUNTS',
];

const CREDENTIAL_PATHS = [
  ['.config/gcloud', '~/.config/gcloud'],
  ['.aws', '~/.aws'],
  ['.azure', '~/.azure'],
  ['.ssh', '~/.ssh'],
  ['.kube/config', '~/.kube/config'],
  ['.git-credentials', '~/.git-credentials'],
  ['.netrc', '~/.netrc'],
  ['.docker/config.json', '~/.docker/config.json'],
  // The persistent form of GH_TOKEN/GITHUB_TOKEN and a registry token.
  ['.config/gh', '~/.config/gh'],
  ['.npmrc', '~/.npmrc'],
];

/**
 * Known credential signals. An empty list is not proof of a clean boundary —
 * it is what the process can see — which is why the gate also needs the
 * attestation below rather than treating the absence as a pass.
 */
export function detectCredentialSignals(
  env = process.env,
  exists = existsSync,
  home = homedir(),
) {
  const signals = [];
  for (const name of CREDENTIAL_ENV) {
    if (env[name]) signals.push(name);
  }
  // An unresolvable home (null/empty) has no credential paths to scan; the
  // gate fails on it at the nonce write below. join(home, …) on a non-string
  // would throw, and on '' would scan the PR-writable CWD instead (R5-1).
  if (typeof home === 'string' && home !== '') {
    for (const [relative, label] of CREDENTIAL_PATHS) {
      if (exists(join(home, relative))) signals.push(label);
    }
  }
  return signals;
}

/**
 * Reports the isolation signals this process can observe. Only a
 * container-backed signal counts: a VM carries none of them, which is why the
 * caller decides what a missing signal means, and why the seatbelt flag is
 * reported separately rather than folded into `isolated`.
 */
export function detectIsolation(env = process.env, exists = existsSync) {
  const signals = [];
  // Observed markers are filesystem facts the process can check, not strings
  // an operator chooses. A self-chosen `container=<name>` is a DECLARATION;
  // on its own it cannot distinguish a boundary from a bare host, so the
  // gate and the checker treat it as insufficient for a container claim.
  const observed = [];
  if (env.container) signals.push(`container=${env.container}`);
  if (exists('/.dockerenv')) {
    signals.push('/.dockerenv');
    observed.push('/.dockerenv');
  }
  if (exists('/run/.containerenv')) {
    signals.push('/run/.containerenv');
    observed.push('/run/.containerenv');
  }
  // A boolean-looking value reads as "sandbox disabled"; the CLI's transport
  // writes a container name or `sandbox-exec`, neither of which is a marker.
  const sandbox = (env.SANDBOX ?? '').trim();
  const sandboxRuntime =
    sandbox &&
    !['false', 'true', '0', '1'].includes(sandbox) &&
    sandbox !== SEATBELT;
  if (sandboxRuntime) signals.push(`SANDBOX=${sandbox}`);
  return {
    isolated: signals.length > 0,
    signals,
    observed,
    sandboxRuntime: sandboxRuntime ? sandbox : null,
    seatbelt: sandbox === SEATBELT,
  };
}

/** Returns the normalized snapshot fields, or null when the shape is wrong. */
export function validateContext(json) {
  if (!json || typeof json !== 'object') return null;
  const pr = json.number;
  const base = json.baseRefOid;
  const head = json.headRefOid;
  if (!Number.isInteger(pr) || pr <= 0) return null;
  if (typeof base !== 'string' || !OID.test(base)) return null;
  if (typeof head !== 'string' || !OID.test(head)) return null;
  return {
    pr,
    base,
    head,
    baseRefName: typeof json.baseRefName === 'string' ? json.baseRefName : '',
    title: typeof json.title === 'string' ? json.title : '',
  };
}

// The CI lane's verify job runs this query and reshapes it with jq into the
// same review-threads.json; a test runs both over the same pages.
export const REVIEW_STATE_QUERY =
  'query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { latestOpinionatedReviews(first: 100) { nodes { state submittedAt url body author { login } authorAssociation commit { oid } } } reviewThreads(first: 50, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated path line originalLine comments(first: 50) { totalCount nodes { createdAt url body author { login } authorAssociation originalCommit { oid } pullRequestReview { url } } } } } } } }';

/**
 * Reshapes `gh api graphql --paginate --slurp` pages of REVIEW_STATE_QUERY into
 * the review state a round reads: every review thread, resolved ones included
 * (resolving is the author's claim, not a measurement), and each reviewer's
 * standing CHANGES_REQUESTED review. Null when the pages are not that query's
 * answer.
 */
export function reviewState(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const isObject = (value) => value !== null && typeof value === 'object';
  const pulls = pages.map((page) => page?.data?.repository?.pullRequest);
  if (
    pulls.some(
      (pull) =>
        !Array.isArray(pull?.reviewThreads?.nodes) ||
        !Array.isArray(pull?.latestOpinionatedReviews?.nodes) ||
        !pull.latestOpinionatedReviews.nodes.every(isObject) ||
        !pull.reviewThreads.nodes.every(
          (thread) =>
            isObject(thread) &&
            Array.isArray(thread.comments?.nodes) &&
            thread.comments.nodes.every(isObject),
        ),
    )
  ) {
    return null;
  }
  const who = (node) => ({
    author: node.author?.login ?? null,
    association: node.authorAssociation ?? null,
  });
  return {
    threads: pulls
      .flatMap((pull) => pull.reviewThreads.nodes)
      .map((thread) => ({
        resolved: thread.isResolved ?? null,
        outdated: thread.isOutdated ?? null,
        path: thread.path ?? null,
        line: thread.line ?? null,
        originalLine: thread.originalLine ?? null,
        commentCount: thread.comments.totalCount ?? null,
        comments: thread.comments.nodes.map((comment) => ({
          ...who(comment),
          createdAt: comment.createdAt ?? null,
          url: comment.url ?? null,
          review: comment.pullRequestReview?.url ?? null,
          commit: comment.originalCommit?.oid ?? null,
          body: comment.body ?? null,
        })),
      })),
    changeRequests: pulls[0].latestOpinionatedReviews.nodes
      .filter((review) => review.state === 'CHANGES_REQUESTED')
      .map((review) => ({
        ...who(review),
        submittedAt: review.submittedAt ?? null,
        commit: review.commit?.oid ?? null,
        url: review.url ?? null,
        body: review.body ?? null,
      })),
  };
}

/** Drops C0/C1 control characters, which a terminal would interpret. */
export function printable(text) {
  return [...String(text ?? '')]
    .filter((char) => {
      const code = char.codePointAt(0);
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    })
    .join('');
}

/** Parses argv into options, or `{error}` for a usage failure. */
export function parseArgs(argv) {
  const options = {
    pr: null,
    repo: null,
    requireIsolation: false,
    artifactDir: null,
    contextOut: null,
    execution: null,
    trustPrHead: false,
    approval: null,
    stateRoot: null,
    round: null,
    reason: null,
    attestation: null,
    localOwner: false,
    sponsored: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--require-isolation') {
      options.requireIsolation = true;
    } else if (arg === '--local-owner') {
      options.localOwner = true;
    } else if (arg === '--sponsored') {
      options.sponsored = true;
    } else if (arg === '--artifact-dir') {
      options.artifactDir = argv[(index += 1)] ?? null;
      if (!options.artifactDir) {
        return { error: '--artifact-dir needs <round-dir>' };
      }
    } else if (arg === '--context-out') {
      options.contextOut = argv[(index += 1)] ?? null;
      if (!options.contextOut) {
        return { error: '--context-out needs <host-snapshot-path>' };
      }
    } else if (arg === '--execution') {
      options.execution = argv[(index += 1)] ?? null;
      if (!options.execution) {
        return { error: '--execution needs container | vm | host' };
      }
    } else if (arg === '--trust-pr-head') {
      options.trustPrHead = true;
    } else if (arg === '--approval') {
      options.approval = argv[(index += 1)] ?? null;
      if (!options.approval) return { error: '--approval needs <permalink>' };
    } else if (arg === '--state-root') {
      options.stateRoot = argv[(index += 1)] ?? null;
      if (!options.stateRoot || !isAbsolute(options.stateRoot)) {
        return { error: '--state-root needs an absolute trusted directory' };
      }
    } else if (arg === '--round') {
      const value = argv[(index += 1)] ?? '';
      options.round = /^[1-9]\d*$/.test(value) ? Number(value) : null;
      if (!Number.isSafeInteger(options.round)) {
        return { error: '--round needs a positive integer' };
      }
    } else if (arg === '--reason') {
      options.reason = argv[(index += 1)] ?? null;
      if (!options.reason) return { error: '--reason needs non-empty text' };
    } else if (arg === '--attestation') {
      options.attestation = argv[(index += 1)] ?? null;
      if (!options.attestation) {
        return { error: '--attestation needs non-empty text' };
      }
    } else if (arg === '--repo') {
      options.repo = argv[(index += 1)] ?? null;
      if (!options.repo) return { error: '--repo needs <owner>/<repo>' };
    } else if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length);
    } else if (/^\d+$/.test(arg) && options.pr === null) {
      options.pr = Number(arg);
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  if (options.help || options.requireIsolation) {
    const coordinateOnly = [
      options.execution,
      options.approval,
      options.round,
      options.reason,
      options.attestation,
      options.contextOut,
      options.stateRoot,
    ].some((value) => value !== null);
    if (
      options.requireIsolation &&
      (coordinateOnly ||
        options.trustPrHead ||
        options.localOwner ||
        options.sponsored)
    ) {
      return {
        error:
          '--execution and approval options apply only to coordinate prepare, not --require-isolation',
      };
    }
    return options;
  }
  if (options.artifactDir !== null) {
    return { error: '--artifact-dir only applies with --require-isolation' };
  }
  options.execution ??= 'container';
  if (!EXECUTION_MODES.includes(options.execution)) {
    return { error: '--execution must be container | vm | host' };
  }
  const approvalOptions =
    options.trustPrHead ||
    options.approval !== null ||
    options.stateRoot !== null ||
    options.round !== null ||
    options.reason !== null ||
    options.attestation !== null;
  if (options.execution === 'container') {
    if (approvalOptions) {
      return {
        error: '--execution container does not take approval options',
      };
    }
  } else {
    if (options.trustPrHead === (options.approval !== null)) {
      return {
        error:
          '--execution vm | host needs exactly one of --trust-pr-head and --approval',
      };
    }
    if (options.trustPrHead && options.stateRoot !== null) {
      return { error: '--state-root applies only to --approval' };
    }
    if (options.approval !== null && options.stateRoot === null) {
      return {
        error:
          '--approval needs --state-root with a matching in-flight head and round',
      };
    }
    if (options.round === null || options.reason === null) {
      return { error: '--execution vm | host needs --round and --reason' };
    }
    if (!options.contextOut) {
      return { error: '--execution vm | host needs --context-out' };
    }
    if (options.execution === 'vm' && options.attestation === null) {
      return { error: '--execution vm needs --attestation' };
    }
    if (options.execution === 'host' && options.attestation !== null) {
      return { error: '--attestation applies only to --execution vm' };
    }
  }
  if (!Number.isInteger(options.pr) || options.pr <= 0) {
    return { error: 'a PR number is required' };
  }
  if (!parseRepo(options.repo)) {
    return { error: '--repo <owner>/<repo> is required' };
  }
  return options;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

/**
 * Best-effort collaborator permission lookup for trust classification (§4.2).
 * Never throws and never fails open: any lookup error returns permission: null,
 * which classifyPrTrust maps to prTrust="unknown" -> hardware-isolated.
 */
function fetchAuthorPermission(owner, name, login) {
  if (typeof login !== 'string' || !GITHUB_LOGIN.test(login)) {
    return { permission: null, error: 'missing or invalid author login' };
  }
  const view = run('gh', [
    'api',
    `repos/${owner}/${name}/collaborators/${login}/permission`,
  ]);
  if (view.status !== 0) {
    const detail =
      (view.stderr || '').trim().split('\n')[0] ||
      view.error?.message ||
      `exit ${view.status}`;
    return { permission: null, error: `gh api permission failed: ${detail}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(view.stdout);
  } catch {
    return {
      permission: null,
      error: 'gh api permission returned non-JSON output',
    };
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof parsed.permission === 'string'
  ) {
    return { permission: parsed.permission, error: null };
  }
  return {
    permission: null,
    error: 'gh api permission returned no permission field',
  };
}

/** `{state}` on success, `{error}` naming why the review state is unknown. */
function fetchReviewState(owner, name, pr) {
  const view = run(
    'gh',
    [
      'api',
      'graphql',
      '--paginate',
      '--slurp',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${pr}`,
      '-f',
      `query=${REVIEW_STATE_QUERY}`,
    ],
    // Every thread's comment bodies, resolved ones included, arrive before
    // the filter: one busy PR's pages measured 790 KB, near spawnSync's 1 MB
    // default.
    { maxBuffer: 256 * 1024 * 1024 },
  );
  if (view.status !== 0) {
    const detail =
      (view.stderr || '').trim().split('\n')[0] ||
      view.error?.message ||
      `exit ${view.status}`;
    return { error: `gh api graphql failed: ${detail}` };
  }
  let pages;
  try {
    pages = JSON.parse(view.stdout);
  } catch {
    return { error: 'gh api graphql returned output that is not JSON' };
  }
  const state = reviewState(pages);
  return state
    ? { state }
    : { error: 'gh api graphql returned pages without review threads' };
}

// The tree under inspection is PR-controlled and can persist hostile git
// config in .git/config: fsmonitor, hooks and clean/smudge/process filters all
// execute on an ordinary `git status`. On the host these run as the maintainer,
// outside the boundary, so every git command disables the fixed vectors and
// empties every locally defined filter before reading the tree. The fixed
// vectors come LAST in every argument list: git applies the last `-c` for a
// key, so an enumerated entry must never be able to outrank them.
export const GIT_HARDENING = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'credential.helper=',
  '-c',
  'core.excludesFile=/dev/null',
];

const FILTER_NAME = /^filter\..*\.(clean|smudge|process)$/s;
const FILTER_PREFIX_BYTES = Buffer.from('filter.', 'ascii');
const FILTER_SUFFIX_BYTES = ['.clean', '.smudge', '.process'].map((suffix) =>
  Buffer.from(suffix, 'ascii'),
);
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function isRawFilterKey(rawKey) {
  if (
    rawKey.length < FILTER_PREFIX_BYTES.length + 6 ||
    !rawKey.subarray(0, FILTER_PREFIX_BYTES.length).equals(FILTER_PREFIX_BYTES)
  ) {
    return false;
  }
  return FILTER_SUFFIX_BYTES.some(
    (suffix) =>
      rawKey.length >= FILTER_PREFIX_BYTES.length + suffix.length &&
      rawKey.subarray(rawKey.length - suffix.length).equals(suffix),
  );
}

/**
 * A filter name git allows (e.g. `filter.a=b.clean` or raw non-UTF-8 bytes)
 * that `-c key=value` cannot safely represent: git splits `-c` at the FIRST
 * `=`, and Node argv cannot pass invalid UTF-8 bytes verbatim, leaving the
 * real filter armed. The gate refuses such names instead, with their own remedy.
 */
export class UnsafeFilterNameError extends Error {
  constructor(name, detail = "contains '='") {
    super(
      `filter name ${printable(name)} ${detail} and cannot be safely disabled with -c — remove the filter from the tree's git config, or re-clone, then re-run prepare`,
    );
    this.name = 'UnsafeFilterNameError';
  }
}

function activeGitConfigScopes(root) {
  const prefix = root ? ['-C', root] : [];
  const scopes = ['--local'];
  const worktreeConfig = run('git', [
    ...prefix,
    'config',
    '--local',
    '--includes',
    '--bool',
    'extensions.worktreeConfig',
  ]);
  if (worktreeConfig.status === 0 && worktreeConfig.stdout.trim() === 'true') {
    const wtPath = run('git', [
      ...prefix,
      'rev-parse',
      '--git-path',
      'config.worktree',
    ]);
    const rawWt = singleLineOutput(wtPath);
    if (rawWt) {
      const resolvedWt = isAbsolute(rawWt)
        ? rawWt
        : resolve(root ?? process.cwd(), rawWt);
      if (existsSync(resolvedWt)) {
        scopes.push('--worktree');
      }
    }
  }
  return scopes;
}

/**
 * Empty `-c` overrides for every locally defined filter command. The filter
 * name is attacker-chosen, so the override set has to be enumerated from the
 * tree's own config instead of hardcoded. Key framing uses `--list --null` on
 * raw bytes (avoiding both UTF-8 locale regex skips on non-UTF-8 bytes and
 * lossy UTF-8 replacement to U+FFFD). Names with `=`, CR/LF, or non-UTF-8
 * bytes throw UnsafeFilterNameError — no `-c` override can represent them.
 */
export function localFilterOverrides(root) {
  const prefix = root ? ['-C', root] : [];
  const scopes = activeGitConfigScopes(root);
  const seen = new Set();
  const overrides = [];
  for (const scope of scopes) {
    const result = spawnSync(
      'git',
      [...prefix, 'config', scope, '--includes', '--null', '--list'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status === 1) continue;
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw new Error('could not enumerate local git filters');
    }
    const raw = result.stdout;
    let start = 0;
    while (start < raw.length) {
      let end = raw.indexOf(0, start);
      if (end === -1) end = raw.length;
      const entry = raw.subarray(start, end);
      start = end + 1;
      if (entry.length === 0) continue;
      const nl = entry.indexOf(0x0a);
      const rawKey = nl === -1 ? entry : entry.subarray(0, nl);
      if (!isRawFilterKey(rawKey)) continue;
      let name;
      try {
        name = STRICT_UTF8.decode(rawKey);
      } catch {
        throw new UnsafeFilterNameError(
          rawKey.toString('utf8'),
          'contains non-UTF-8 bytes',
        );
      }
      if (name.includes('=')) throw new UnsafeFilterNameError(name);
      if (!FILTER_NAME.test(name) || /[\r\n]/.test(name)) {
        throw new UnsafeFilterNameError(
          name,
          'contains unsupported characters',
        );
      }
      if (!seen.has(name)) {
        seen.add(name);
        overrides.push('-c', `${name}=`);
      }
    }
  }
  return overrides;
}

function hasCustomWorktreeConfig(root) {
  const scopes = activeGitConfigScopes(root);
  for (const scope of scopes) {
    const res = run('git', [
      ...GIT_HARDENING,
      '-C',
      root,
      'config',
      scope,
      '--includes',
      '--get-all',
      'core.worktree',
    ]);
    if (res.status === 0 && res.stdout.trim() !== '') return true;
    if (res.status !== 0 && res.status !== 1) {
      throw new Error('could not inspect core.worktree in git config');
    }
  }
  return false;
}

export function gitStatusArgs(root) {
  return [
    ...localFilterOverrides(root),
    ...GIT_HARDENING,
    '-C',
    root,
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=dirty',
  ];
}

function runGit(args, root = null) {
  const overrides = root ? localFilterOverrides(root) : localFilterOverrides();
  return run('git', [...overrides, ...GIT_HARDENING, ...args]);
}

const MAX_INFO_EXCLUDE_BYTES = 1024 * 1024;

function singleLineOutput(result) {
  if (result.status !== 0) return null;
  const trimmed = (result.stdout ?? '').replace(/\r?\n$/, '');
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * True when git's info/exclude carries active patterns. A fresh clone has
 * only the commented default there; patterns hide untracked files from the
 * clean-tree check, and unlike core.excludesFile no `-c` can neutralize this
 * file, so the gate refuses it instead of reading a steered status.
 */
export function inspectInfoExclude(root) {
  const resolved = runGit(
    ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    root,
  );
  let commonDir = singleLineOutput(resolved);
  if (!commonDir || !isAbsolute(commonDir)) {
    // Older git (< 2.31) either exits non-zero or prints two lines
    // ("--path-format=absolute\n.git") with exit 0; retry without
    // --path-format and resolve relative output against root.
    const fallback = runGit(
      ['-C', root, 'rev-parse', '--git-common-dir'],
      root,
    );
    const raw = singleLineOutput(fallback);
    if (!raw) {
      throw new Error(
        (fallback.stderr || resolved.stderr || '').trim() ||
          'could not resolve git common dir for info/exclude',
      );
    }
    commonDir = isAbsolute(raw) ? raw : resolve(root, raw);
  }
  const infoDir = join(commonDir, 'info');
  const path = join(infoDir, 'exclude');
  try {
    const dirStat = lstatSync(infoDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error(`${infoDir} must be a real directory`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { path, hostile: false };
    throw error;
  }
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { path, hostile: false };
    throw error;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`${path} must be a regular file`);
  }
  if (st.size > MAX_INFO_EXCLUDE_BYTES) {
    throw new Error(`${path} exceeds ${MAX_INFO_EXCLUDE_BYTES} bytes`);
  }
  const hostile = readFileSync(path, 'utf8')
    .split('\n')
    .some((rawLine) => {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('#')) return false;
      // gitignore(5) treats only empty / trailing-ASCII-space-only lines as
      // blank and '#' only at column 0 as a comment; leading spaces, tabs or
      // non-ASCII whitespace before '#' (or a lone tab) are active patterns.
      return line.replace(/ +$/, '') !== '';
    });
  return { path, hostile };
}

export function hasHostileInfoExclude(root) {
  return inspectInfoExclude(root).hostile;
}

function exactCheckoutError(root, context) {
  const treeHead = runGit(['-C', root, 'rev-parse', 'HEAD'], root);
  if (treeHead.status !== 0) return 'could not read HEAD in this clone';
  if (treeHead.stdout.trim() !== context.head) {
    return `current tree is at ${treeHead.stdout.trim()}, not PR head ${context.head} — run: git checkout ${context.head}, then re-run prepare`;
  }
  // The ignore channel is steerable from the same PR-controlled .git:
  // core.excludesFile is neutralized by GIT_HARDENING, but .git/info/exclude
  // has no `-c` override, so active patterns there are refused outright
  // rather than read through.
  try {
    const exclude = inspectInfoExclude(root);
    if (exclude.hostile) {
      return `${exclude.path} carries local exclude patterns, which can hide untracked files from the clean-tree check — re-clone (a fresh clone has only the commented default), or clear the file, then re-run prepare`;
    }
  } catch (error) {
    return `could not inspect git info/exclude: ${error.message}`;
  }
  // Explicit mode: a maintainer's status.showUntrackedFiles=no would otherwise
  // hide the untracked files this check exists to refuse.
  const dirty = run('git', gitStatusArgs(root));
  if (dirty.status !== 0) {
    const detail = (dirty.stderr || '').trim() || `exit ${dirty.status}`;
    return `could not read the working tree status: ${detail}`;
  }
  if (dirty.stdout.trim() !== '') {
    // Name the entries and a remedy that actually clears them: a plain
    // `git stash` leaves untracked files behind, so the advice would loop.
    const entries = dirty.stdout.trim().split('\n');
    const shown = entries.slice(0, 5).map(printable).join(', ');
    return `working tree has uncommitted changes (${shown}${entries.length > 5 ? ', …' : ''}) — commit them, or run \`git stash push --include-untracked\` (a plain \`git stash\` leaves untracked files behind), or remove them, then re-run prepare; this script never stashes for you`;
  }
  // git status trusts the index: skip-worktree / assume-unchanged entries
  // (a sparse checkout sets them en masse) hide tracked divergence from it,
  // so refuse anything that is not a plain cached 'H' entry.
  const flagged = runGit(['-C', root, 'ls-files', '-v'], root);
  if (flagged.status !== 0) {
    const detail = (flagged.stderr || '').trim() || `exit ${flagged.status}`;
    return `could not read the index flags: ${detail}`;
  }
  const opaque = flagged.stdout
    .split('\n')
    .filter((line) => line && !line.startsWith('H '));
  if (opaque.length > 0) {
    const shown = opaque.slice(0, 5).map(printable).join(', ');
    return `tracked entries hide their worktree state (${shown}${opaque.length > 5 ? ', …' : ''}) — re-clone without a sparse checkout, or clear the index flags, then re-run prepare`;
  }
  return null;
}

function report(lines) {
  process.stdout.write(`${lines.join('\n')}\n`);
}

function fail(code, message) {
  process.stderr.write(`verify-pr prepare: ${message}\n`);
  return code;
}

function ghJson(args, label) {
  const result = run('gh', args);
  if (result.status !== 0) {
    const detail =
      (result.stderr || '').trim().split('\n')[0] ||
      result.error?.message ||
      `exit ${result.status}`;
    return { error: `${label} failed: ${detail}` };
  }
  try {
    return { value: JSON.parse(result.stdout) };
  } catch {
    return { error: `${label} returned output that is not JSON` };
  }
}

function maintainerPermission(owner, name, login) {
  if (typeof login !== 'string' || login === '') {
    return { error: 'the GitHub response has no user login' };
  }
  const result = ghJson(
    [
      'api',
      `repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}/permission`,
    ],
    `permission lookup for ${login}`,
  );
  if (result.error) return result;
  const permission = result.value?.permission;
  if (!PERMISSIONS.includes(permission)) {
    return {
      error: `${login} has ${JSON.stringify(permission)} on ${owner}/${name}, not admin | maintain | write`,
    };
  }
  return { permission };
}

const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32';
const normalizeFsPath = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
const realPath = (p) => realpathSync.native(p);
function isSameOrWithin(root, candidate) {
  const normRoot = normalizeFsPath(root);
  const normCandidate = normalizeFsPath(candidate);
  return (
    normCandidate === normRoot ||
    normCandidate.startsWith(normRoot.endsWith(sep) ? normRoot : normRoot + sep)
  );
}

function registeredRoundApproval(options, snapshot, owner, name, cloneRoot) {
  let stateRoot;
  try {
    stateRoot = realPath(options.stateRoot);
    const realClone = realPath(cloneRoot);
    if (isSameOrWithin(realClone, stateRoot)) {
      return {
        error: '--state-root must be a trusted directory outside the PR clone',
      };
    }
    const path = watchStatePath(stateRoot, snapshot.number);
    // A trusted root can hold a nested .qwen/tmp symlink back into the PR
    // clone; canonicalize the leaf's whole route before accepting the file.
    const resolvedPath = realPath(path);
    if (isSameOrWithin(realClone, resolvedPath)) {
      return {
        error: '--state-root must be a trusted directory outside the PR clone',
      };
    }
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
      return {
        error: `the watch registration must be a single-link regular file: ${path}`,
      };
    }
  } catch (error) {
    return {
      error: `could not read the watch registration: ${error.message}; a comment approval needs an actual head/round registration, not unregistered repeated execution`,
    };
  }
  let state;
  try {
    state = readWatchState(stateRoot, snapshot.number);
  } catch (error) {
    return { error: `could not read the watch registration: ${error.message}` };
  }
  const registration = inFlightRegistration(
    state,
    snapshot.headRefOid,
    options.round,
  );
  if (
    state?.pr !== snapshot.number ||
    typeof state?.repo !== 'string' ||
    state.repo.toLowerCase() !== `${owner}/${name}`.toLowerCase() ||
    !registration
  ) {
    return {
      error: `--approval needs one in-flight registration for ${owner}/${name}#${snapshot.number} at head ${snapshot.headRefOid}, round ${options.round}; register before waiting, then use the matching fresh round instead of reusing a completed approval`,
    };
  }
  return {
    registrationNonce:
      typeof registration.registrationNonce === 'string'
        ? registration.registrationNonce
        : null,
  };
}

// Extract column-0 approval markers using a fail-closed rule rather than
// replicating CommonMark's full block/container grammar: an approval comment
// must not be preceded by any code-fence delimiter (``` / ~~~), GFM display
// math delimiter ($$), or raw HTML block/tag opener (including inside list
// items or blockquotes). Without preceding fences, math blocks, or HTML
// blocks, a column-0 single-line HTML comment is guaranteed by CommonMark
// 0.31.2 to be a top-level HTML comment, never text inside a fenced code
// block, indented code block, blockquote, list item, math block, or HTML block
// (types 1–7).
function directApprovalMarkers(body) {
  const markers = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^<!-- verify-pr-boundary-approval: (\{[^\n]*\}) -->$/.exec(
      line,
    );
    if (match && !match[1].includes('-->')) {
      markers.push(match[1]);
      continue;
    }
    if (
      /`{3,}|~{3,}|\$\$/.test(line) ||
      /^(?:[ \t>*+-]|\d+[.)])*<(?:!|\?|[A-Za-z/])/.test(line)
    ) {
      break;
    }
  }
  return markers;
}

function commentApproval(options, snapshot, owner, name, cloneRoot) {
  const match = APPROVAL_PERMALINK.exec(options.approval);
  if (
    !match ||
    match[1].toLowerCase() !== owner.toLowerCase() ||
    match[2].toLowerCase() !== name.toLowerCase() ||
    match[3] !== String(snapshot.number)
  ) {
    return {
      error: '--approval must be an issue-comment permalink on this PR',
    };
  }
  const commentId = Number(match[4]);
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    return { error: '--approval has no valid numeric issue-comment id' };
  }
  const registered = registeredRoundApproval(
    options,
    snapshot,
    owner,
    name,
    cloneRoot,
  );
  if (registered.error) return registered;
  const response = ghJson(
    ['api', `repos/${owner}/${name}/issues/comments/${commentId}`],
    'approval comment lookup',
  );
  if (response.error) return response;
  const comment = response.value;
  if (comment?.id !== commentId) {
    return { error: 'the approval API returned a different issue-comment id' };
  }
  const issue =
    /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(
      comment?.issue_url ?? '',
    );
  if (
    !issue ||
    issue[1].toLowerCase() !== owner.toLowerCase() ||
    issue[2].toLowerCase() !== name.toLowerCase() ||
    issue[3] !== String(snapshot.number)
  ) {
    return { error: 'the approval comment does not belong to this PR' };
  }
  const body = comment?.body;
  const login = comment?.user?.login;
  if (typeof body !== 'string' || typeof login !== 'string' || !login) {
    return { error: 'the approval comment has no body or author login' };
  }
  const prefixCount = body.split(APPROVAL_PREFIX).length - 1;
  const markers = directApprovalMarkers(body);
  if (prefixCount !== 1 || markers.length !== 1) {
    return {
      error:
        'the approval comment needs exactly one well-formed verify-pr-boundary-approval marker as a direct full line outside quotes and code examples',
    };
  }
  let marker;
  try {
    marker = JSON.parse(markers[0]);
  } catch {
    return { error: 'the approval marker is not valid JSON' };
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      registered.registrationNonce ?? '',
    )
  ) {
    return {
      error:
        'this legacy in-flight registration has no registrationNonce; release and restart it with the current watch-state helper, then obtain a fresh marked approval for that new registration instead of reusing an old approval marker',
    };
  }
  const markerKeys = Object.keys(marker ?? {}).sort();
  if (
    markerKeys.join(',') !== 'head,mode,registrationNonce,round' ||
    marker.mode !== options.execution ||
    marker.head !== snapshot.headRefOid ||
    marker.round !== options.round ||
    marker.registrationNonce !== registered.registrationNonce
  ) {
    return {
      error:
        'the approval marker must contain only mode, head, round and registrationNonce matching this execution, trusted head, round and current in-flight registration; a released, completed or other-state-root registration needs a fresh marked approval',
    };
  }
  const allowed = maintainerPermission(owner, name, login);
  if (allowed.error) return allowed;
  return {
    approval: {
      mode: options.execution === 'host' ? 'waived' : 'vm',
      source: 'comment',
      by: login,
      basis: 'maintainer-comment',
      permission: allowed.permission,
      approval: options.approval,
      comment: {
        id: commentId,
        bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      },
      head: snapshot.headRefOid,
      round: options.round,
      registrationNonce: registered.registrationNonce,
      reason: options.reason,
      ...(options.execution === 'vm'
        ? { attestation: options.attestation }
        : {}),
    },
  };
}

function singleLinkFileError(path, label) {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return `could not inspect the ${label} path ${path}: ${error.message}`;
  }
  if (st.isSymbolicLink()) {
    return `refusing to write the ${label} through a symlink: ${path}`;
  }
  if (!st.isFile() || st.nlink !== 1) {
    return `refusing to write the ${label} through a non-single-link file: ${path}`;
  }
  return null;
}

function captureWriteRecord(path, label, next, expectedParent = null) {
  const record = {
    path,
    label,
    next,
    expectedParent,
    previous: null,
    touched: false,
  };
  const leafError = singleLinkFileError(path, label);
  if (leafError) return { error: leafError };
  try {
    record.parentReal = realPath(dirname(path));
  } catch (error) {
    return { error: `could not inspect the ${label} parent: ${error.message}` };
  }
  if (
    record.expectedParent !== null &&
    normalizeFsPath(record.parentReal) !==
      normalizeFsPath(record.expectedParent)
  ) {
    return {
      error: `refusing to write the ${label} through a redirected parent directory: ${path}`,
    };
  }
  try {
    const existing = lstatSync(path);
    if (existing.size > 16 * 1024 * 1024) {
      return {
        error: `could not preserve the ${label} at ${path}: file exceeds 16 MiB`,
      };
    }
    record.previous = readFileSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return {
        error: `could not preserve the ${label} at ${path}: ${error.message}`,
      };
    }
  }
  return { record };
}

function writeRecordError(record) {
  const leafError = singleLinkFileError(record.path, record.label);
  if (leafError) return leafError;
  try {
    const parentReal = realPath(dirname(record.path));
    if (
      normalizeFsPath(parentReal) !== normalizeFsPath(record.parentReal) ||
      (record.expectedParent !== null &&
        normalizeFsPath(parentReal) !== normalizeFsPath(record.expectedParent))
    ) {
      return `refusing to write the ${record.label} through a redirected parent directory: ${record.path}`;
    }
  } catch (error) {
    return `could not inspect the ${record.label} parent: ${error.message}`;
  }
  return null;
}

function commitWriteRecords(records) {
  const rollback = (cause) => {
    const failures = [];
    for (const record of records.toReversed()) {
      if (!record.touched) continue;
      try {
        const pathError = writeRecordError(record);
        if (pathError) throw new Error(pathError);
        let current = null;
        try {
          current = readFileSync(record.path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (current === null && record.previous === null) continue;
        if (
          current !== null &&
          record.previous !== null &&
          current.equals(record.previous)
        ) {
          continue;
        }
        if (record.previous === null) rmSync(record.path, { force: true });
        else writeFileSync(record.path, record.previous);
      } catch (error) {
        failures.push(`${record.label} ${record.path}: ${error.message}`);
      }
    }
    return {
      error: `${cause}${failures.length > 0 ? `; restore failed for ${failures.join('; ')}` : ''}`,
    };
  };
  for (const record of records) {
    const pathError = writeRecordError(record);
    if (pathError) return rollback(pathError);
    record.touched = true;
    try {
      if (record.next === null) rmSync(record.path, { force: true });
      else writeFileSync(record.path, record.next);
    } catch (error) {
      return rollback(
        `could not write the ${record.label} to ${record.path}: ${error.message}`,
      );
    }
  }
  return {};
}

function localTrustApproval(options, snapshot, owner, name) {
  const current = ghJson(['api', 'user'], 'current-user lookup');
  if (current.error) return current;
  const login = current.value?.login;
  if (typeof login !== 'string' || !login) {
    return { error: 'current-user lookup returned no login' };
  }
  const own = snapshot.author?.login === login;
  const sameRepository = snapshot.isCrossRepository === false;
  if (!own && !sameRepository) {
    return {
      error:
        "--trust-pr-head is limited to the current user's own PR or a same-repository PR; another fork needs --approval",
    };
  }
  const allowed = maintainerPermission(owner, name, login);
  if (allowed.error) return allowed;
  return {
    approval: {
      mode: options.execution === 'host' ? 'waived' : 'vm',
      source: 'local-trust',
      by: login,
      basis: own ? 'own-pr' : 'same-repository',
      permission: allowed.permission,
      head: snapshot.headRefOid,
      round: options.round,
      reason: options.reason,
      ...(options.execution === 'vm'
        ? { attestation: options.attestation }
        : {}),
    },
  };
}

function resolveExecutionApproval(options, snapshot, owner, name, cloneRoot) {
  const result = options.trustPrHead
    ? localTrustApproval(options, snapshot, owner, name)
    : commentApproval(options, snapshot, owner, name, cloneRoot);
  if (result.error) return result;
  const { errors } = checkBoundary(JSON.stringify(result.approval), null, {
    coordinates: { owner, repo: name, number: snapshot.number },
  });
  if (errors.length > 0) return { error: errors.join('; ') };
  return result;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    process.stderr.write(`verify-pr prepare: ${options.error}\n\n${HELP}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.requireIsolation) return requireBoundary(options.artifactDir);

  const { owner, name } = parseRepo(options.repo);
  const slug = `${owner}/${name}`;

  let toplevel;
  try {
    toplevel = runGit(['rev-parse', '--show-toplevel']);
  } catch (error) {
    // A hostile filter name is a refusal with its own remedy, not a missing
    // worktree; it must surface before any guarded status could run it.
    if (error instanceof UnsafeFilterNameError) {
      return fail(3, error.message);
    }
    return fail(3, 'not inside a git worktree — run this from the clone');
  }
  if (toplevel.status !== 0) {
    return fail(3, 'not inside a git worktree — run this from the clone');
  }
  const root = toplevel.stdout.trim();
  let rootFilterOverrides;
  try {
    if (hasCustomWorktreeConfig(root)) {
      return fail(
        3,
        'git config sets core.worktree, which redirects the working tree root — re-clone or clear core.worktree, then re-run prepare',
      );
    }
    rootFilterOverrides = localFilterOverrides(root);
  } catch (error) {
    return fail(3, error.message);
  }
  const runGitRoot = (args) =>
    run('git', [...rootFilterOverrides, ...GIT_HARDENING, '-C', root, ...args]);

  const view = run('gh', [
    'pr',
    'view',
    String(options.pr),
    '--repo',
    slug,
    '--json',
    FIELDS,
  ]);
  if (view.status !== 0) {
    const detail =
      (view.stderr || '').trim() ||
      view.error?.message ||
      `exit ${view.status}`;
    return fail(3, `gh pr view failed: ${detail}`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(view.stdout);
  } catch {
    return fail(3, 'gh pr view returned output that is not JSON');
  }
  const context = validateContext(snapshot);
  if (!context) {
    return fail(
      3,
      'gh returned a snapshot without a numeric PR and two 40-character OIDs',
    );
  }

  const probes = [
    ['base', context.base, context.baseRefName || context.base],
    ['head', context.head, `pull/${context.pr}/head`],
  ];
  for (const [label, oid, ref] of probes) {
    if (runGitRoot(['cat-file', '-e', `${oid}^{commit}`]).status !== 0) {
      return fail(
        3,
        `${label} ${oid} is not in this clone — run: git fetch https://github.com/${slug}.git ${ref}`,
      );
    }
  }

  // The round runs the head side of its A/B in this tree, so a HEAD other
  // than the PR head or an uncommitted change would measure code the report
  // does not name. Checked before the artifact directory exists, so a refusal
  // leaves nothing behind. The same hardened check runs again after the last
  // network response, immediately before authority writes.
  let initialTreeError;
  try {
    initialTreeError = exactCheckoutError(root, context);
  } catch (error) {
    return fail(3, error.message);
  }
  if (initialTreeError) return fail(3, initialTreeError);

  let executionApproval = null;
  if (options.execution !== 'container') {
    const approved = resolveExecutionApproval(
      options,
      snapshot,
      owner,
      name,
      root,
    );
    if (approved.error) {
      return fail(3, `execution approval: ${approved.error}`);
    }
    executionApproval = approved.approval;
  }

  const contextDir = join(root, 'tmp', 'verify-context');
  const contextPath = join(contextDir, `pr${context.pr}.json`);
  const artifacts = join(root, 'tmp', artifactDirName(context.pr));
  let artifactCanonical = null;
  // The tmp/ container is PR-controlled: a PR-committed symlink there would
  // redirect every mkdir/write below before any leaf guard runs (R5-1). Refuse
  // it before anything is created. A fresh clone has no tmp/ — that is fine.
  const tmpDir = join(root, 'tmp');
  try {
    if (lstatSync(tmpDir).isSymbolicLink()) {
      return fail(
        3,
        `refusing to write the host snapshot through a symlink: ${tmpDir}`,
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return fail(3, `could not inspect ${tmpDir}: ${error.message}`);
    }
  }
  try {
    mkdirSync(contextDir, { recursive: true });
    // Recursive, so a retry within the same second lands in the directory this
    // script just made instead of failing on it.
    mkdirSync(artifacts, { recursive: true });
  } catch (error) {
    return fail(3, `could not create the artifact directory: ${error.message}`);
  }
  try {
    artifactCanonical = realPath(artifacts);
    if (
      !lstatSync(artifacts).isDirectory() ||
      lstatSync(artifacts).isSymbolicLink() ||
      normalizeFsPath(artifactCanonical) !==
        normalizeFsPath(join(realPath(tmpDir), basename(artifacts)))
    ) {
      return fail(
        3,
        `refusing to write through a non-directory or redirected artifact directory: ${artifacts}`,
      );
    }
  } catch (error) {
    return fail(
      3,
      `could not validate the artifact directory: ${error.message}`,
    );
  }
  try {
    mkdirSync(join(artifacts, 'evidence'), { recursive: true });
  } catch (error) {
    return fail(3, `could not create the artifact directory: ${error.message}`);
  }
  // Classify PR trust and mandatory hardware-isolation escalations host-side
  // before writing the digest-bound snapshot (§4.1–§4.4). Failure to read
  // permission or changed files fails closed to hardware-isolated.
  // Use `--raw --no-renames -z` (NUL-delimited, never C-quoted) so non-ASCII
  // filenames cannot bypass prefix rules via core.quotePath=true AND git file
  // modes (100755 executables, 120000 symlinks, 160000 submodules) are captured
  // in the same command. Extensionless 100644 files are also magic-sniffed
  // (4 bytes, O_NOFOLLOW) for shebang/ELF/Mach-O/PE headers.
  const diffRes = runGitRoot([
    'diff',
    '--raw',
    '--no-renames',
    '--ignore-submodules=none',
    '-z',
    `${context.base}..${context.head}`,
  ]);
  let changedPaths = null;
  let executablePaths = [];
  let specialModePaths = [];
  if (diffRes.status === 0) {
    const parsedDiff = parseRawDiffEntries(diffRes.stdout);
    changedPaths = parsedDiff.changedPaths;
    executablePaths = [...parsedDiff.executablePaths];
    specialModePaths = [...parsedDiff.specialModePaths];
    for (const rel of parsedDiff.extensionlessLivePaths) {
      if (hasExecutableMagic(join(root, rel))) {
        executablePaths.push(rel);
      }
    }
  }
  const authorPerm = fetchAuthorPermission(owner, name, snapshot.author?.login);
  const trust = classifyPrTrust({
    permission: authorPerm.permission,
    isLocalOwner: options.localOwner,
    isFork: snapshot.isCrossRepository === true ? true : null,
    changedPaths,
    executablePaths,
    specialModePaths,
    forceHardware: process.env[FORCE_HARDWARE_ENV] === '1',
    sponsored: options.sponsored,
  });
  const trustClassification = {
    ...trust,
    headRefOid: context.head,
    permission: authorPerm.permission,
    ...(authorPerm.error ? { permissionError: authorPerm.error } : {}),
  };

  // The host-held snapshot carries the slug too: the checker compares a
  // waiver's approval permalink against these coordinates, and gh's field
  // selector has no repo member, so it is added where the snapshot is
  // written, not to FIELDS.
  const contextBytes = `${JSON.stringify(
    {
      ...snapshot,
      repo: slug,
      trustClassification,
      ...(executionApproval ? { executionApproval } : {}),
    },
    null,
    2,
  )}\n`;

  // Network access never happens under the registration lock. The write
  // stage below rechecks the registration after these calls complete.
  const reviewPath = join(contextDir, `pr${context.pr}-review-threads.json`);
  const review = fetchReviewState(owner, name, context.pr);

  const writeRound = () => {
    if (executionApproval?.source === 'comment') {
      const current = registeredRoundApproval(
        options,
        snapshot,
        owner,
        name,
        root,
      );
      if (
        current.error ||
        current.registrationNonce !== executionApproval.registrationNonce
      ) {
        return fail(
          3,
          `execution approval: ${current.error ?? 'the in-flight registration changed while approval was being resolved; obtain a fresh marked approval for the current registration'}`,
        );
      }
    }

    // The review-state GraphQL response was the final network activity. A
    // checkout changed while that response was in flight must not supply an
    // execution approval or a host snapshot under the earlier clean-tree OK.
    const finalTreeError = exactCheckoutError(root, context);
    if (finalTreeError) return fail(3, finalTreeError);

    // The snapshot dir/file live in the PR-controlled tree: a symlink at
    // either path redirects the host-side write, and a hard link at the
    // snapshot path would truncate a file the round does not own.
    for (const p of [contextDir, contextPath]) {
      let st;
      try {
        st = lstatSync(p);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          return fail(
            3,
            `could not inspect the snapshot path ${p}: ${error.message}`,
          );
        }
        continue;
      }
      if (st.isSymbolicLink()) {
        return fail(
          3,
          `refusing to write the host snapshot through a symlink: ${p}`,
        );
      }
      if (p === contextPath && (!st.isFile() || st.nlink !== 1)) {
        return fail(
          3,
          `refusing to write the host snapshot through a non-single-link file: ${p}`,
        );
      }
    }
    // Structural fix (R5-1): the authoritative snapshot also goes to a host
    // destination outside the clone (--context-out). Validate its real parent
    // before preserving any bytes; a failed prepare must leave the prior
    // authority files untouched or restore them exactly.
    let reportedContextPath = contextPath;
    let outPath = null;
    let outParentCanonical = null;
    if (options.contextOut) {
      outPath = resolve(options.contextOut);
      const realRoot = realPath(root);
      if (isSameOrWithin(realRoot, outPath)) {
        return fail(
          3,
          `refusing to write the host snapshot inside the PR clone: ${outPath}`,
        );
      }
      try {
        const parent = dirname(outPath);
        let existingParent = parent;
        while (!existsSync(existingParent)) {
          const next = dirname(existingParent);
          if (next === existingParent) break;
          existingParent = next;
        }
        const realExisting = realPath(existingParent);
        if (isSameOrWithin(realRoot, realExisting)) {
          return fail(
            3,
            `refusing to write the host snapshot inside the PR clone: ${outPath}`,
          );
        }
        mkdirSync(parent, { recursive: true });
        const realParent = realPath(parent);
        if (isSameOrWithin(realRoot, realParent)) {
          return fail(
            3,
            `refusing to write the host snapshot inside the PR clone: ${outPath}`,
          );
        }
        outParentCanonical = realParent;
        if (executionApproval?.source === 'comment') {
          const statePath = watchStatePath(options.stateRoot, context.pr);
          const protectedPaths = [statePath, `${statePath}.lock`];
          const canonicalOut = normalizeFsPath(
            join(realParent, basename(outPath)),
          );
          for (const protectedPath of protectedPaths) {
            const canonicalProtected = normalizeFsPath(
              join(realPath(dirname(protectedPath)), basename(protectedPath)),
            );
            let sameFile = false;
            try {
              const outputStat = statSync(outPath);
              const protectedStat = statSync(protectedPath);
              sameFile =
                outputStat.dev === protectedStat.dev &&
                outputStat.ino === protectedStat.ino;
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
            if (canonicalOut === canonicalProtected || sameFile) {
              return fail(
                3,
                `--context-out must not overwrite the live watch state or its lock: ${outPath}`,
              );
            }
          }
        }
      } catch (error) {
        return fail(
          3,
          `could not write the host snapshot to ${outPath}: ${error.message}`,
        );
      }
      reportedContextPath = outPath;
    }
    const artifactContextPath = join(artifacts, 'context.json');
    const boundaryPath = join(artifacts, 'boundary.json');
    let contextDirCanonical;
    try {
      const tmpStat = lstatSync(tmpDir);
      if (tmpStat.isSymbolicLink() || !tmpStat.isDirectory()) {
        return fail(
          3,
          `refusing to write through a redirected tmp container: ${tmpDir}`,
        );
      }
      contextDirCanonical = join(realPath(root), 'tmp', 'verify-context');
      if (
        normalizeFsPath(realPath(contextDir)) !==
        normalizeFsPath(contextDirCanonical)
      ) {
        return fail(
          3,
          `refusing to write through a redirected context directory: ${contextDir}`,
        );
      }
    } catch (error) {
      return fail(
        3,
        `could not validate the context directory ${contextDir}: ${error.message}`,
      );
    }
    try {
      const st = lstatSync(boundaryPath);
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
        return fail(
          3,
          `refusing to write the execution approval through a non-single-link file: ${boundaryPath}`,
        );
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return fail(
          3,
          `could not inspect the execution approval path ${boundaryPath}: ${error.message}`,
        );
      }
    }
    const planned = [
      {
        path: contextPath,
        label: 'host snapshot',
        expectedParent: contextDirCanonical,
        next: contextBytes,
      },
      {
        path: artifactContextPath,
        label: 'artifact context',
        expectedParent: artifactCanonical,
        next: `${JSON.stringify({
          repo: slug,
          pr: context.pr,
          baseRefOid: context.base,
          headRefOid: context.head,
        })}\n`,
      },
      // A same-directory container retry must not retain an earlier host/VM
      // approval. Deleting it stays in this rollback group on later failure.
      {
        path: boundaryPath,
        label: 'execution approval',
        expectedParent: artifactCanonical,
        next: executionApproval
          ? `${JSON.stringify(executionApproval, null, 2)}\n`
          : null,
      },
      // Best-effort, like the lane: a missing review file means "unknown", so
      // an earlier prepare's copy must not outlive a failed fetch. Its
      // replacement or removal participates in the same rollback group as the
      // authority files.
      {
        path: reviewPath,
        label: 'review snapshot',
        expectedParent: contextDirCanonical,
        next: review.state
          ? `${JSON.stringify(review.state, null, 2)}\n`
          : null,
      },
    ];
    if (outPath) {
      planned.unshift({
        path: outPath,
        label: 'host snapshot',
        expectedParent: outParentCanonical,
        next: contextBytes,
      });
    }
    const records = [];
    for (const item of planned) {
      const { record, error } = captureWriteRecord(
        item.path,
        item.label,
        item.next,
        item.expectedParent,
      );
      if (error) return fail(3, error);
      records.push(record);
    }
    const { error } = commitWriteRecords(records);
    if (error) return fail(3, error);
    // The digest binds the snapshot's content for the checker
    // (--context-sha256): it is computed only after every write succeeded.
    const contextSha256 = createHash('sha256')
      .update(contextBytes, 'utf8')
      .digest('hex');
    return { contextSha256, reportedContextPath };
  };

  let written;
  try {
    written =
      executionApproval?.source === 'comment'
        ? withStateLock(options.stateRoot, context.pr, writeRound)
        : writeRound();
  } catch (error) {
    return fail(3, `could not finish the prepare writes: ${error.message}`);
  }
  if (written.locked) {
    return fail(
      3,
      'execution approval: the watch-state lock is held by another invocation; while that holder may be active, retry shortly. If the holder is confirmed killed, verify the owner token in the .lock file beside the state JSON and manually remove only that stale .lock file — never the state JSON itself; do not treat the previous approval as current',
    );
  }
  if (typeof written === 'number') return written;
  const { contextSha256, reportedContextPath } = written;

  const isolation = detectIsolation();
  // The title comes from an untrusted fork, and a control character would reach
  // the maintainer's terminal from a tool whose job is to protect it.
  const title = printable(context.title).replace(/\s+/g, ' ').trim();
  report([
    'verify-pr prepare',
    `  repo       ${slug}`,
    `  pr         #${context.pr}${title ? ` ${title}` : ''}`,
    `  base       ${context.base}`,
    `  head       ${context.head}`,
    '  tree       at PR head, clean — reuse this tree; verify or refresh its install/build first',
    `  context    ${reportedContextPath}`,
    `  context-sha256  ${contextSha256}`,
    review.state
      ? `  review     ${reviewPath} (${review.state.threads.filter((thread) => !thread.resolved).length} of ${review.state.threads.length} threads unresolved, ${review.state.changeRequests.length} change requests)`
      : `  review     not written — ${printable(review.error)}; the round lists review findings as not covered`,
    `  artifacts  ${artifacts}`,
    `  execution  ${options.execution}${executionApproval ? ` (${executionApproval.source}, head ${executionApproval.head}, round ${executionApproval.round})` : ''}`,
    `  trust      ${trust.prTrust} -> ${trust.executionClass}${trust.escalationReasons.length > 0 ? ` (${trust.escalationReasons.slice(0, 3).join(', ')}${trust.escalationReasons.length > 3 ? ', …' : ''})` : ''}`,
    `  isolation  ${isolation.isolated ? isolation.signals.join(', ') : 'none detected'}`,
  ]);
  if (isolation.seatbelt) {
    report([
      '  seatbelt   SANDBOX=sandbox-exec (default profile allows host reads —',
      '             not a boundary)',
    ]);
  }
  if (options.execution === 'container') {
    report([
      '',
      `Next: build the round in ${artifacts}. This preflight ran on the host,`,
      'because resolving the coordinates needs `gh` and `gh` is mutually',
      'exclusive with the boundary. Before executing PR code, run inside the',
      "boundary — the container recipe's spelling (step 5), with the clone",
      'mounted at /work:',
      '',
      `  node /trusted-scripts/verify-pr-prepare.mjs --require-isolation --artifact-dir "/work/tmp/${basename(artifacts)}"`,
      '',
      'The path is the in-container one: the gate runs from the read-only',
      "/trusted-scripts mount, never the PR head's own copy of the script,",
      'and the record lands in the mounted artifact directory so it survives',
      'the container. For host or VM execution, keep the current head/round',
      'in-flight registration and re-run prepare BEFORE the battery with',
      '--execution host|vm and its applicable approval arguments; prepare writes',
      'boundary.json. Do not release a registration merely to change modes.',
      'Never hand-write a host/VM declaration after the battery. The container',
      'gate writes boundary-gate.json into the artifact directory; the checker',
      'requires that record alongside the container declaration.',
    ]);
  } else if (options.execution === 'vm') {
    report([
      '',
      `Next: run the round for this exact head in the attested VM. The`,
      `${executionApproval.source} approval is recorded for round ${executionApproval.round}.`,
      'A VM runs NO --require-isolation gate and has no boundary-gate.json;',
      'its validated executionApproval is already in boundary.json.',
    ]);
  } else {
    report([
      '',
      `Next: run the host round only for this exact head and round ${executionApproval.round}.`,
      `The explicit ${executionApproval.source} decision was validated before artifacts`,
      'were created. Keep that approval only for this round, and disclose the',
      'host waiver in the report; this preflight is not an execution sandbox.',
    ]);
  }
  return 0;
}

/**
 * The in-boundary check, and the only place its answer means anything: the
 * coordinate path necessarily runs on the host, so a gate there would fire
 * every round and teach the maintainer to ignore it.
 *
 * On a pass with `artifactDir`, writes `boundary-gate.json` there: the
 * record that the gate actually ran and exited 0, which the checker
 * requires alongside a `mode:"container"` declaration. The declaration is
 * a value a round can mint for itself; this record ties it to a gate run.
 * (The artifact tree is PR-writable, so the record corroborates against an
 * operator who skipped the gate — the incident's shape — not against PR
 * code that forges it; the CI publisher writes its own lane record.)
 */
export function requireBoundary(artifactDir = null, options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  // Resolve home lazily and defensively: os.homedir() throws SystemError when
  // the UID has no passwd entry and HOME is unset (the arbitrary-UID container
  // shape --user <uid>:<gid> invites), and returns '' when HOME is set but
  // empty. Evaluating it in a default parameter let the throw escape as exit 1
  // before invalidateRecord could run, leaving a stale pass record behind;
  // both shapes must reach the gate's exit-3 refusal below (R5-1).
  let home = options.home;
  if (home === undefined) {
    try {
      home = homedir();
    } catch {
      home = null;
    }
  }
  const recordPath = artifactDir
    ? join(artifactDir, 'boundary-gate.json')
    : null;
  // A failed re-run must not leave an earlier pass's record behind: the
  // checker would still accept the container declaration against evidence
  // that predates the refusal. Every non-pass exit invalidates the record.
  const invalidateRecord = () => {
    if (!recordPath) return;
    try {
      rmSync(recordPath, { force: true });
    } catch {
      // Best-effort; the refusal exit is the contract.
    }
  };
  const isolation = detectIsolation(env, exists);
  const credentials = detectCredentialSignals(env, exists, home);
  const attested = env[CREDENTIAL_FREE_ATTESTATION] === '1';

  // A refusal from OUTSIDE any boundary does not contradict a record minted
  // INSIDE one: a host-side sanity re-run must not destroy the in-container
  // gate record (R10-30). Only a refusal that contradicts the record — an
  // attested boundary leaking credentials, or a failed record write —
  // invalidates it (below).
  if (!isolation.isolated) {
    const detail = isolation.seatbelt
      ? 'SANDBOX=sandbox-exec is the built-in macOS sandbox, whose default profile still reads host files'
      : 'no container marker was found';
    process.stderr.write(
      `verify-pr boundary: ${detail} — do not execute PR code in this process\n`,
    );
    return 4;
  }

  // A self-chosen `container=<name>` string — or an inherited `SANDBOX=`
  // string — is a declaration, not an observed boundary: on a bare host it
  // would mint a container claim with no isolation, and the checker refuses
  // every non-ci-lane record whose observed list is empty, so such a pass
  // could never be published anyway (R11-1). The gate needs an OBSERVED
  // filesystem marker; a launcher container always carries one. Host/VM
  // execution instead needs prepare's approved declaration before the battery.
  if (isolation.observed.length === 0) {
    process.stderr.write(
      `verify-pr boundary: only a declared marker (${isolation.signals.join(', ')}) — a self-chosen container= or SANDBOX= string is not an observed boundary; run inside a real container. For host/VM execution keep the delivered head/round registration, choose --execution host|vm explicitly, and rerun prepare with its approved approval arguments BEFORE the battery; never hand-write the declaration\n`,
    );
    return 4;
  }

  const refusals = [];
  if (!attested) {
    refusals.push(
      `${CREDENTIAL_FREE_ATTESTATION}=1 is not set: a marker says a container exists, not that it carries no host credentials`,
    );
  }
  if (credentials.length > 0) {
    refusals.push(
      `credential signals contradict a credential-free boundary: ${credentials.join(', ')}`,
    );
  }
  if (refusals.length > 0) {
    process.stderr.write(
      `verify-pr boundary: ${isolation.signals.join(', ')} but ${refusals.join('; ')} — do not execute PR code here\n`,
    );
    invalidateRecord();
    return 4;
  }
  if (artifactDir) {
    // A per-round nonce ties the declaration to execution inside THIS
    // container (R16-1). The plaintext is written to a container-local path
    // (the process home, NOT the shared artifact mount) so the round must
    // read it from inside the container and echo it into its raw harness
    // logs; the checker refuses mode:"container" unless a log line's sha256
    // matches the record. Only the HASH rides the gate record: a host
    // battery cannot recover the plaintext from the hash, so it cannot copy
    // it out of the PR-writable record into a forged log line. Like the
    // record itself, this corroborates an operator who ran the round in the
    // container — it is not proof against a round that forges both.
    const nonce = randomBytes(16).toString('hex');
    const record = {
      gate: 'require-isolation',
      passed: true,
      at: new Date().toISOString(),
      signals: isolation.signals,
      // Observed filesystem markers, kept apart from the declared strings:
      // the checker requires one to back a container claim.
      observed: isolation.observed,
      credentialFree: true,
      nonceSha256: createHash('sha256').update(nonce).digest('hex'),
    };
    // An unresolvable $HOME (no passwd entry for this UID with HOME unset, or
    // HOME set but empty) cannot host the container-local plaintext:
    // join('', …) would write it into the PR-writable CWD instead, and a
    // homedir() throw would escape as exit 1. Refuse with exit 3 and
    // invalidate any stale record before the pass line (R5-1).
    if (typeof home !== 'string' || home === '') {
      invalidateRecord();
      return fail(
        3,
        'could not resolve a container-local $HOME (no passwd entry for this UID and HOME unset or empty): the nonce plaintext cannot be written outside the PR-writable mount, so the round cannot declare mode:"container"',
      );
    }
    // The plaintext must exist somewhere the battery can read it, or the
    // record's hash binds a nonce nobody can echo and the round is silently
    // uncertifiable after the whole battery ran (R1-4). Fail the gate now,
    // before the pass line, naming $HOME. This refusal is reached only inside
    // the boundary (a host re-run exits 4 above), so invalidating the record
    // here does not contradict a record minted inside one.
    const noncePath = join(home, '.qwen-verify-nonce');
    try {
      writeFileSync(noncePath, `${nonce}\n`);
    } catch (error) {
      invalidateRecord();
      return fail(
        3,
        `could not write the container-local nonce to ${noncePath} ($HOME unwritable or absent): the round cannot declare mode:"container" without it: ${error.message}`,
      );
    }
    const tmp = `${recordPath}.${process.pid}.tmp`;
    // A filesystem failure here is the documented exit-3 path, not an
    // uncaught throw after the pass line: a driver keyed on exit 4 must
    // not proceed on a pass the record never landed.
    try {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
      renameSync(tmp, recordPath);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best-effort: force only covers ENOENT, and a cleanup failure
        // (ENOTDIR on a non-directory parent) must not mask the original.
      }
      invalidateRecord();
      return fail(3, `could not write the gate record: ${error.message}`);
    }
  }
  report([
    `verify-pr boundary: ${isolation.signals.join(', ')}; credential-free per attestation, no known credential signal`,
  ]);
  return 0;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
