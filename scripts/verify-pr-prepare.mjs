#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
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
 * This script resolves those coordinates and nothing else. It does not checkout
 * a worktree, build, or execute PR code; deciding whether this host may run
 * that code is the round's business, and the isolation report below is the
 * input to that decision.
 *
 * Usage:
 *   node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo> [--allow-host]
 *
 * Options:
 *   --repo <owner>/<repo>  required: never inferred from `origin`, because a
 *                          fork's `origin` resolves the same PR number to an
 *                          unrelated PR
 *   --allow-host           exit 0 even when no isolation boundary is detected,
 *                          for a host the detector cannot see (a VM)
 *
 * Exit codes:
 *   0  prepared, an isolation boundary was detected (or --allow-host)
 *   2  usage error
 *   3  metadata, OID, or filesystem failure
 *   4  prepared, but no isolation boundary was detected — do not run PR code
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OID = /^[0-9a-f]{40}$/;
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

const HELP = `Usage: node scripts/verify-pr-prepare.mjs <pr> --repo <owner>/<repo> [--allow-host]

Resolves the coordinates a local /verify-pr round needs and writes the
metadata snapshot the round reads as $QWEN_VERIFY_CONTEXT:

  - fetches the PR snapshot with gh, from the repository you name
  - verifies the base and head OIDs exist in this clone
  - creates tmp/pr<n>-verify-<YYYYMMDD-HHMMSS>/ with an evidence/ subdirectory
  - reports whether an isolation boundary was detected

Exit 4 means the coordinates are ready but this process does not look isolated:
do not execute PR code here. Trigger the sandboxed lane instead:

  gh pr comment <pr> --repo <owner>/<repo> --body '@qwen-code /verify'

Pass --allow-host only when the boundary exists somewhere the detector cannot
see it, such as a VM.
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
 * Reports the isolation signals this process can observe. A false negative is
 * possible (a VM carries none of them), which is why the caller may override
 * with --allow-host; a false positive would need one of these variables or
 * files to exist on the host for another reason.
 */
export function detectIsolation(env = process.env, exists = existsSync) {
  const signals = [];
  if (env.SANDBOX) signals.push(`SANDBOX=${env.SANDBOX}`);
  if (env.container) signals.push(`container=${env.container}`);
  if (exists('/.dockerenv')) signals.push('/.dockerenv');
  if (exists('/run/.containerenv')) signals.push('/run/.containerenv');
  return { isolated: signals.length > 0, signals };
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

/** Parses argv into options, or `{error}` for a usage failure. */
export function parseArgs(argv) {
  const options = { pr: null, repo: null, allowHost: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--allow-host') {
      options.allowHost = true;
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
  if (options.help) return options;
  if (!Number.isInteger(options.pr) || options.pr <= 0) {
    return { error: 'a PR number is required' };
  }
  if (!parseRepo(options.repo)) {
    return { error: '--repo <owner>/<repo> is required' };
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
        `${label} ${oid} is not in this clone — run: git fetch origin ${ref}`,
      );
    }
  }

  const contextDir = join(root, 'tmp', 'verify-context');
  const contextPath = join(contextDir, `pr${context.pr}.json`);
  const artifacts = join(root, 'tmp', artifactDirName(context.pr));
  try {
    mkdirSync(contextDir, { recursive: true });
    // Recursive, so a retry in the same second — exit 4, then --allow-host —
    // lands in the directory this script just made instead of failing on it.
    mkdirSync(artifacts, { recursive: true });
    mkdirSync(join(artifacts, 'evidence'), { recursive: true });
  } catch (error) {
    return fail(3, `could not create the artifact directory: ${error.message}`);
  }
  writeFileSync(contextPath, `${JSON.stringify(snapshot, null, 2)}\n`);

  const isolation = detectIsolation();
  const title = context.title.replace(/\s+/g, ' ').trim();
  report([
    'verify-pr prepare',
    `  repo       ${slug}`,
    `  pr         #${context.pr}${title ? ` ${title}` : ''}`,
    `  base       ${context.base}`,
    `  head       ${context.head}`,
    `  context    ${contextPath}`,
    `  artifacts  ${artifacts}`,
    `  isolation  ${isolation.isolated ? isolation.signals.join(', ') : 'none detected'}`,
  ]);

  if (isolation.isolated || options.allowHost) {
    report([
      '',
      `Next: build the round in ${artifacts}; the snapshot above is the whole`,
      'world for metadata (no network calls from inside the boundary).',
    ]);
    return 0;
  }

  report([
    '',
    'No isolation boundary detected. Do not execute PR code in this working',
    'copy. Run the round in a credential-free container or VM, or trigger the',
    'sandboxed lane:',
    '',
    `  gh pr comment ${context.pr} --repo ${slug} --body '@qwen-code /verify'`,
    '',
    'Pass --allow-host only when the boundary exists somewhere the detector',
    'cannot see it (a VM).',
  ]);
  return 4;
}

/**
 * Whether this module is the executed entry point. `import.meta.url` is a
 * percent-encoded file URL, so comparing it to a plain `file://` + path breaks
 * on spaces or non-ASCII characters, and Node resolves the entry module's
 * symlinks while `argv[1]` keeps the path the shell was given.
 */
function isEntryPoint(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return (
      realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
