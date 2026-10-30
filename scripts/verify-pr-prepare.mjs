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
 * change, and never stashes for the maintainer. It also cannot gate on
 * isolation: resolving the coordinates needs `gh`, and `gh` and the boundary
 * are mutually exclusive, so this path always runs on the host. The gate is
 * the separate `--require-isolation` mode, meant to run inside the boundary
 * before the round executes anything.
 *
 * Usage:
 *   node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo>
 *   node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo> --expect-head <sha>
 *   node scripts/verify-pr-prepare.mjs --require-isolation
 *
 * Options:
 *   --repo <owner>/<repo>  required for the coordinate path: never inferred
 *                          from `origin`, because a fork's `origin` resolves the
 *                          same PR number to an unrelated PR
 *   --expect-head <sha>    the full commit id the round was asked to verify.
 *                          Refuses (exit 5) when the PR's live head is not that
 *                          commit, BEFORE anything is fetched, created or run.
 *                          An automated handoff carries the head its review
 *                          read; without this the round would silently verify
 *                          whatever the PR has advanced to since
 *   --require-isolation    check the process this runs in and exit 4 when no
 *                          boundary is detected; run it inside the boundary
 *
 * Exit codes:
 *   0  coordinates resolved, or the boundary check passed
 *   2  usage error
 *   3  metadata, OID, tree-state, or filesystem failure
 *   4  --require-isolation found no boundary — do not run PR code here
 *   5  the live head is not --expect-head — do not verify a different commit
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

const OID = /^[0-9a-f]{40}$/;
const EXPECT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const FIELDS = [
  'number',
  'title',
  'body',
  'author',
  'baseRefName',
  'baseRefOid',
  'headRefOid',
  'commits',
].join(',');

const HELP = `Usage: node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo> [--expect-head <sha>]
       node scripts/verify-pr-prepare.mjs --require-isolation

Resolves the coordinates a local /verify-pr round needs and writes the
metadata snapshot the round reads as $QWEN_VERIFY_CONTEXT:

  - fetches the PR snapshot with gh, from the repository you name
  - verifies the base and head OIDs exist in this clone
  - refuses a tree that is not a clean checkout of the PR head, so the round
    can reuse the current tree as the head side of the A/B; the gitignored
    install/build still needs a freshness check before it is reused
  - creates tmp/pr<n>-verify-<YYYYMMDD-HHMMSS>/ with an evidence/ subdirectory
    and a context.json holding repo, pr, baseRefOid and headRefOid
  - reports the isolation signals this process can observe

The coordinate path runs on the host by construction: it needs gh, and gh and
the boundary are mutually exclusive. Run --require-isolation inside the
boundary, as the round's first command; exit 4 means this process is not
isolated and must not execute PR code. A container marker alone does not pass:
the CLI's own Docker/Podman launcher mounts ~/.config/gcloud and the ADC file
and copies model API keys, so the check also requires the credential-free
attestation and refuses when a known credential signal is visible. The
built-in macOS sandbox (SANDBOX=sandbox-exec) never counts.
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
  for (const [relative, label] of CREDENTIAL_PATHS) {
    if (exists(join(home, relative))) signals.push(label);
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
  if (env.container) signals.push(`container=${env.container}`);
  if (exists('/.dockerenv')) signals.push('/.dockerenv');
  if (exists('/run/.containerenv')) signals.push('/run/.containerenv');
  // A boolean-looking value reads as "sandbox disabled"; the CLI's transport
  // writes a container name or `sandbox-exec`, neither of which is a marker.
  const sandbox = (env.SANDBOX ?? '').trim();
  if (sandbox && !['false', 'true', '0', '1'].includes(sandbox)) {
    if (sandbox !== SEATBELT) signals.push(`SANDBOX=${sandbox}`);
  }
  return {
    isolated: signals.length > 0,
    signals,
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
    expectHead: null,
    requireIsolation: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--require-isolation') {
      options.requireIsolation = true;
    } else if (arg === '--repo') {
      options.repo = argv[(index += 1)] ?? null;
      if (!options.repo) return { error: '--repo needs <owner>/<repo>' };
    } else if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length);
    } else if (arg === '--expect-head') {
      options.expectHead = argv[(index += 1)] ?? null;
      if (!options.expectHead) {
        return { error: '--expect-head needs <sha>' };
      }
    } else if (arg.startsWith('--expect-head=')) {
      options.expectHead = arg.slice('--expect-head='.length);
    } else if (/^\d+$/.test(arg) && options.pr === null) {
      options.pr = Number(arg);
    } else {
      return { error: `unexpected argument: ${arg}` };
    }
  }
  if (options.help || options.requireIsolation) return options;
  if (!Number.isInteger(options.pr) || options.pr <= 0) {
    return { error: 'a PR number is required' };
  }
  if (!parseRepo(options.repo)) {
    return { error: '--repo <owner>/<repo> is required' };
  }
  if (options.expectHead !== null) {
    options.expectHead = options.expectHead.toLowerCase();
    if (!EXPECT_HEAD.test(options.expectHead)) {
      return {
        error: '--expect-head must be a full 40- or 64-character hex commit id',
      };
    }
  }
  return options;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function report(lines) {
  process.stdout.write(`${lines.join('\n')}\n`);
}

function fail(code, message) {
  process.stderr.write(`verify-pr prepare: ${message}\n`);
  return code;
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
  if (options.requireIsolation) return requireBoundary();

  const { owner, name } = parseRepo(options.repo);
  const slug = `${owner}/${name}`;

  const toplevel = run('git', ['rev-parse', '--show-toplevel']);
  if (toplevel.status !== 0) {
    return fail(3, 'not inside a git worktree — run this from the clone');
  }
  const root = toplevel.stdout.trim();

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

  // The head gate runs before any fetch, directory creation or execution: a
  // round asked to verify one commit must not quietly verify another. Checking
  // only before the spawn would still leave the window between the spawn and
  // this preparation, which is exactly where an automated handoff can go stale.
  if (options.expectHead && context.head !== options.expectHead) {
    return fail(
      5,
      `the PR head moved: this round was asked to verify ${options.expectHead} but ${slug}#${context.pr} is now at ${context.head} — re-review the new head before verifying it`,
    );
  }

  const probes = [
    ['base', context.base, context.baseRefName || context.base],
    ['head', context.head, `pull/${context.pr}/head`],
  ];
  for (const [label, oid, ref] of probes) {
    if (
      run('git', ['-C', root, 'cat-file', '-e', `${oid}^{commit}`]).status !== 0
    ) {
      return fail(
        3,
        `${label} ${oid} is not in this clone — run: git fetch https://github.com/${slug}.git ${ref}`,
      );
    }
  }

  // The round runs the head side of its A/B in this tree, so a HEAD other
  // than the PR head or an uncommitted change would measure code the report
  // does not name. Checked before the artifact directory exists, so a refusal
  // leaves nothing behind.
  const treeHead = run('git', ['-C', root, 'rev-parse', 'HEAD']);
  if (treeHead.status !== 0) {
    return fail(3, 'could not read HEAD in this clone');
  }
  if (treeHead.stdout.trim() !== context.head) {
    return fail(
      3,
      `current tree is at ${treeHead.stdout.trim()}, not PR head ${context.head} — run: git checkout ${context.head}, then re-run prepare`,
    );
  }
  // Explicit mode: a maintainer's status.showUntrackedFiles=no would otherwise
  // hide the untracked files this check exists to refuse.
  const dirty = run('git', [
    '-C',
    root,
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ]);
  if (dirty.status !== 0) {
    const detail = (dirty.stderr || '').trim() || `exit ${dirty.status}`;
    return fail(3, `could not read the working tree status: ${detail}`);
  }
  if (dirty.stdout.trim() !== '') {
    // Name the entries and a remedy that actually clears them: a plain
    // `git stash` leaves untracked files behind, so the advice would loop.
    const entries = dirty.stdout.trim().split('\n');
    const shown = entries.slice(0, 5).map(printable).join(', ');
    return fail(
      3,
      `working tree has uncommitted changes (${shown}${entries.length > 5 ? ', …' : ''}) — commit them, or run \`git stash push --include-untracked\` (a plain \`git stash\` leaves untracked files behind), or remove them, then re-run prepare; this script never stashes for you`,
    );
  }
  // git status trusts the index: skip-worktree / assume-unchanged entries
  // (a sparse checkout sets them en masse) hide tracked divergence from it,
  // so refuse anything that is not a plain cached 'H' entry.
  const flagged = run('git', ['-C', root, 'ls-files', '-v']);
  if (flagged.status !== 0) {
    const detail = (flagged.stderr || '').trim() || `exit ${flagged.status}`;
    return fail(3, `could not read the index flags: ${detail}`);
  }
  const opaque = flagged.stdout
    .split('\n')
    .filter((line) => line && !line.startsWith('H '));
  if (opaque.length > 0) {
    const shown = opaque.slice(0, 5).map(printable).join(', ');
    return fail(
      3,
      `tracked entries hide their worktree state (${shown}${opaque.length > 5 ? ', …' : ''}) — re-clone without a sparse checkout, or clear the index flags, then re-run prepare`,
    );
  }

  const contextDir = join(root, 'tmp', 'verify-context');
  const contextPath = join(contextDir, `pr${context.pr}.json`);
  const artifacts = join(root, 'tmp', artifactDirName(context.pr));
  try {
    mkdirSync(contextDir, { recursive: true });
    // Recursive, so a retry within the same second lands in the directory this
    // script just made instead of failing on it.
    mkdirSync(artifacts, { recursive: true });
    mkdirSync(join(artifacts, 'evidence'), { recursive: true });
  } catch (error) {
    return fail(3, `could not create the artifact directory: ${error.message}`);
  }
  writeFileSync(contextPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(
    join(artifacts, 'context.json'),
    `${JSON.stringify({
      repo: slug,
      pr: context.pr,
      baseRefOid: context.base,
      headRefOid: context.head,
    })}\n`,
  );

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
    `  context    ${contextPath}`,
    `  artifacts  ${artifacts}`,
    `  isolation  ${isolation.isolated ? isolation.signals.join(', ') : 'none detected'}`,
  ]);
  if (isolation.seatbelt) {
    report([
      '  seatbelt   SANDBOX=sandbox-exec (default profile allows host reads —',
      '             not a boundary)',
    ]);
  }
  report([
    '',
    `Next: build the round in ${artifacts}. This preflight ran on the host,`,
    'because resolving the coordinates needs `gh` and `gh` is mutually',
    'exclusive with the boundary. Before executing PR code, run inside it:',
    '',
    '  node scripts/verify-pr-prepare.mjs --require-isolation',
  ]);
  return 0;
}

/**
 * The in-boundary check, and the only place its answer means anything: the
 * coordinate path necessarily runs on the host, so a gate there would fire
 * every round and teach the maintainer to ignore it.
 */
function requireBoundary() {
  const isolation = detectIsolation();
  const credentials = detectCredentialSignals();
  const attested = process.env[CREDENTIAL_FREE_ATTESTATION] === '1';

  if (!isolation.isolated) {
    const detail = isolation.seatbelt
      ? 'SANDBOX=sandbox-exec is the built-in macOS sandbox, whose default profile still reads host files'
      : 'no container marker was found';
    process.stderr.write(
      `verify-pr boundary: ${detail} — do not execute PR code in this process\n`,
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
    return 4;
  }
  report([
    `verify-pr boundary: ${isolation.signals.join(', ')}; credential-free per attestation, no known credential signal`,
  ]);
  return 0;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
