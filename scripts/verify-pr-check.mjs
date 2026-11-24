#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Applies the publisher's consistency rules to a `/verify-pr` round.
 *
 * The CI publish job runs this file from its trusted checkout and does not
 * trust a verdict it refuses, so a `merge-ready` report carrying `fail: 7`
 * degrades to "no usable structured verdict". A local round has no publisher,
 * so the skill runs it before posting: the one step of that path a machine
 * should own.
 *
 * Usage:
 *   node scripts/verify-pr-check.mjs <artifact-dir>
 *
 * Exit codes: 0 when no error was found (warnings may still print), 1 on any
 * error, 2 on a usage error.
 */

import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isEntryPoint } from './lib/entry-point.js';

export const VERDICTS = ['merge-ready', 'findings', 'blocked', 'inconclusive'];

/**
 * How the round isolated the untrusted PR code. `container` is a
 * credential-free boundary the isolation gate passed; `waived` is a
 * maintainer's explicit decision to run on the host, recorded so a host
 * round is a visible exception instead of a silent default.
 */
export const BOUNDARY_MODES = ['container', 'microvm', 'vm', 'waived'];
export const PR_TRUST_LEVELS = [
  'local-owner',
  'collaborator',
  'external',
  'unknown',
];
export const EXECUTION_CLASSES = ['hardware-isolated', 'trusted-shared-kernel'];
export const HARDWARE_BACKENDS = ['firecracker', 'vfkit', 'provider-vm'];
export const LIGHTWEIGHT_BACKENDS = ['container'];
export const EXECUTION_RECORD_SCHEMA = 'verify-pr-exec-record-v1';

/**
 * Who caused a failed assertion. `pr` is the only one that can stamp a defect
 * on the PR: an `environment` red belongs in an expected-red assertion once an
 * A/A control proves both arms fail, and a `harness` fault is `inconclusive`.
 */
export const ATTRIBUTIONS = ['pr', 'harness', 'environment'];

/**
 * Above this many assertions, a round has almost certainly folded an existing
 * test suite into its own counts. The four such rounds among 18 recent CI
 * artifacts (3918 to 7737) each counted whole workspace suites; one counted
 * them again for every mutant run, so 7737 held a few dozen checks of its own.
 */
const SUITE_SIZED_TOTAL = 1000;

const KEBAB_PNG = /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;
const OID = /^[0-9a-f]{7,40}$/;
// GFM renders an ATX heading indented up to three spaces as a heading too
// (four spaces become a code block), so the indent is part of the shape,
// not a way around it.
const HEADING = /^ {0,3}#{1,6}\s/;
// A heading is a short title; past this it is a paragraph wearing a heading's
// font size. GitHub renders an H1 at 2em, so a long heading line is a wall of
// giant text however well-formed the Markdown is.
const HEADING_TITLE_MAX = 120;
const FOOTER =
  /^_— .+ via Qwen Code \/verify-pr \(v[^;]+; skill [0-9a-f]{12}\)_$/;

const HELP = `Usage: node scripts/verify-pr-check.mjs [--context <snapshot>] [--context-root <pr-clone>] [--context-sha256 <digest>] [--execution-record <record>] [--execution-record-sha256 <digest>] [--publish-lane] <artifact-dir>

Checks a local round against the rules the CI publisher enforces:

  - report.md, verdict.txt and assertions.json exist and carry content
  - verdict.txt is exactly one of merge-ready | findings | blocked | inconclusive
  - assertions.json holds non-negative integers, a positive total, and
    total == pass + fail
  - assertions.json gates, when present, lists { suite, pass, fail } entries
    (skipped optional) with non-negative integer counts up to 2^53-1
  - a merge-ready verdict carries no failed assertion
  - a findings/blocked verdict whose failures ledger attributes no failure to
    the PR is a contradiction: expected reds are passes
  - a mutations.json claiming per-commit coverage covers every commit it lists,
    and lists at least one commit (an empty set makes the claim vacuous)
  - boundary.json declares where the untrusted PR code ran: mode container
    with a non-empty detail, backed by the boundary-gate.json record a passing
    --require-isolation --artifact-dir gate run wrote, or a VM/waived
    executionApproval written by prepare. Local-trust records carry source,
    basis, authenticated by/permission, head and round without a public URL;
    comment approvals carry the validated permalink and comment metadata.
    Both must deeply equal the host-held --context executionApproval, bind
    its bytes with --context-sha256, and match the trusted head; prepare has
    already registered comment approvals to an in-flight head and round.
    Host/VM publication requires a valid owner/repo slug and positive pr or
    number in that snapshot; the artifact name/context cannot fill either.
    The approval permalink must cite that PR. This host-coordinate binding
    also requires a real artifact directory, not a symlink or other
    non-directory; pass the resolved path. A shape-only waiver or a PR-side
    record alone is refused.
    The CI publish job's own ci-lane record is honored only under
    --publish-lane, the flag the publish job passes (an argv claim, not an
    authenticated identity). On the CI entry path ($QWEN_VERIFY_CONTEXT
    set) an absent declaration — or a container declaration whose gate record
    is absent — is only a warning: the publish job (CI lane) or the host check
    step (container recipe) writes both before the verdict is trusted
  - an unreadable artifact (a directory, a non-regular file such as a FIFO or
    symlink, or a permission-denied file in its place) is reported as
    unreadable, not silently treated as absent

and warns (without failing) when the report does not lead with its verdict and
head OID, when the verdict line is a heading (GitHub renders the whole
paragraph as one giant H1), when evidence/ carries no kebab-case PNG capture,
when a round with failures carries no failures ledger at all, when over
${SUITE_SIZED_TOTAL} assertions come with no gate results (an existing test suite
counted as the round's own), when the Methodology's **Boundary.** disclosure
is empty, still a template, or contradicts the recorded mode, or when
comment.md — the exact body a local round posts, optional — repeats the
heading shape or lacks the attribution footer.

With --context <snapshot>, the head-OID check reads that file instead of the
round's own context.json. Pass a copy the round never saw: the artifact
directory is writable by the PR code the round executed, so a --context path
inside the PR-writable tree is refused — it cannot supply the coordinates
that judge its waiver. Pass --context-root <pr-clone> (the host-held PR clone
path, which must contain the artifact dir) to name that tree explicitly; the
trust root must come from the host, never from git state inside the tree the
round controls. Without it, a pr<n>-verify-<ts> dir under tmp/ falls back to
the clone root (the tmp container's parent); a plain dir is its own root.

The path and link-count guards only refuse a context that is demonstrably
round-controlled (inside the trust root, or a hard link retaining a second
name); a single-link file outside the root is NOT proof the host wrote it.
Pass --context-sha256 <digest> — the sha256 that verify-pr-prepare.mjs prints
host-side when it writes the snapshot — to bind the content: the check refuses
a --context whose bytes do not match, so a rewritten or substituted snapshot
is rejected even when its path and link count look clean.

Exit codes: 0 no errors, 1 errors found, 2 usage.
`;

// The artifact directory is writable by the PR code the round executed, so
// a path may be a directory or otherwise unreadable. Degrade to a sentinel
// instead of crashing with EISDIR before any check runs — but an unreadable
// artifact is NOT an absent one: main() reports it as an error, so a damaged
// mutations.json or comment.md cannot silently drop its check.
const UNREADABLE = '\u0000unreadable';
// Artifacts are reports and JSON, never bulk data; a PR-planted sparse file
// of arbitrary size must not be read whole into memory (R12 deferred).
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
function readIfExists(path) {
  // lstat, not existsSync + readFileSync: a FIFO blocks open(2) forever with
  // no writer, and a symlink to /dev/zero reads without end — neither raises
  // the synchronous error the catch below relies on. A non-regular file in
  // this PR-writable tree is a refusal, not a hang. A symlink is non-regular
  // too: it can point outside the tree, so it is refused rather than followed.
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_ARTIFACT_BYTES) return UNREADABLE;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return UNREADABLE;
  }
}

// A filesystem root contains every path on its volume: '/' on POSIX, a drive
// root like 'C:\' on Windows. Both must fail closed rather than be used as a
// discriminating trust root (R17-1, deferred Windows drive-root case). '/' is
// also a valid root spelling on Windows (where sep is '\\'), so accept it on
// every platform, not only where it equals sep (R6-1).
export function isFilesystemRoot(root) {
  return root === sep || root === '/' || /^[A-Za-z]:[\\/]$/.test(root);
}

// Root-aware containment. A filesystem root contains every path, so it must
// fail closed rather than compare against '//' — no real path starts with
const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32';
const normalizeFsPath = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
const realPath = (p) => realpathSync.native(p);

// '//', which silently disabled the refusal for a round dir directly under a
// root-level tmp/ (R17-1). Both the --context refusal and the --context-root
// containment test use this so the two stay consistent.
function withinRoot(root, p) {
  if (isFilesystemRoot(root)) return true;
  const normRoot = normalizeFsPath(root);
  const normP = normalizeFsPath(p);
  return (
    normP === normRoot ||
    normP.startsWith(normRoot.endsWith(sep) ? normRoot : normRoot + sep)
  );
}

/** OIDs are quoted at every length from 7 to 40; compare by prefix. */
function sameCommit(a, b) {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * A coverage claim is universally quantified over an enumerable set, so it has
 * to be checked against that set rather than believed. A round wrote "every
 * production commit since the previous round was mutated on its own" while two
 * commits had no row; only a self-audit caught it.
 *
 * The enumeration comes from `git log --no-merges <previous>..<head> --not
 * <target>` in the round, not from this script: a checker with no repository
 * cannot derive it, so an incomplete list is the skill rule's job. What is
 * machine-checkable is the claim against the list the round itself supplies —
 * plus the one incomplete list that would otherwise pass every check, the
 * empty one.
 */
export function checkMutationCoverage(text) {
  const errors = [];
  if (text === null || text === undefined || text.trim() === '') {
    return { errors };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ['mutations.json is not valid JSON'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { errors: ['mutations.json must be an object with rows'] };
  }
  if (parsed.coverageClaim !== 'per-commit') return { errors };

  const commits = parsed.productionCommits;
  const rows = parsed.rows;
  if (!Array.isArray(commits) || !Array.isArray(rows)) {
    errors.push(
      "mutations.json claims per-commit coverage: it needs productionCommits[] from git log and rows[] carrying each row's commit",
    );
    return { errors };
  }
  if (!commits.every((oid) => typeof oid === 'string' && OID.test(oid))) {
    errors.push(
      'mutations.json productionCommits must be hex commit ids (7-40 characters)',
    );
    return { errors };
  }
  // An empty enumeration is the cheapest way to make the claim uncheckable:
  // "every commit was mutated" is vacuously true over no commits at all.
  if (commits.length === 0) {
    errors.push(
      'mutations.json claims per-commit coverage over an empty productionCommits list: a claim over an empty set is vacuously true, so enumerate the commits (git log --no-merges <previous>..<head> --not <target>) or drop the claim',
    );
    return { errors };
  }

  const mutated = rows
    .map((row) => row?.commit)
    .filter((oid) => typeof oid === 'string' && OID.test(oid));
  const uncovered = commits.filter(
    (oid) => !mutated.some((seen) => sameCommit(seen, oid)),
  );
  if (uncovered.length > 0) {
    errors.push(
      `mutations.json claims per-commit coverage but ${uncovered.length} of ${commits.length} production commits have no row: ${uncovered.join(', ')}`,
    );
  }
  return { errors };
}

/**
 * A round that executes untrusted PR code without declaring where it ran
 * reads exactly like one that ran inside the boundary. Two local rounds on
 * PR #16866 executed the whole battery on the maintainer's host with no
 * isolation gate, no waiver, and no boundary line in the report — the rule
 * existed only as prose. The declaration is the artifact that makes the
 * exception visible; the checker refuses a round without one.
 */
// A container declaration must be backed by a gate record: the record is
// written by verify-pr-prepare.mjs --require-isolation (gate
// "require-isolation"). The CI publish job writes its own "ci-lane"
// record, and that value is honored ONLY under --publish-lane, the flag
// the publish job passes. The record lives in the PR-writable artifact
// tree and the flag is argv, so this corroborates an operator who ran the
// gate — it is not proof against a round that forges both.
function gateRecordErrors(gateText, { publishLane = false } = {}) {
  if (gateText === null || gateText === undefined || gateText.trim() === '') {
    return [
      'boundary-gate.json is missing: a mode:"container" declaration must be backed by a gate run — verify-pr-prepare.mjs --require-isolation --artifact-dir <round-dir> inside the boundary (the CI publish job writes its own ci-lane record)',
    ];
  }
  let gate;
  try {
    gate = JSON.parse(gateText);
  } catch {
    return ['boundary-gate.json is not valid JSON'];
  }
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    return ['boundary-gate.json must be an object'];
  }
  const values = publishLane
    ? ['require-isolation', 'ci-lane']
    : ['require-isolation'];
  if (!values.includes(gate.gate) || gate.passed !== true) {
    return [
      `boundary-gate.json does not record a passed isolation gate (gate: ${values.join(' | ')}, passed: true)`,
    ];
  }
  // A container claim needs the facts the gate itself established, not a
  // two-key file PR content can leave behind: an OBSERVED boundary marker
  // (a self-chosen container= string cannot distinguish a real container
  // from a bare host), the credential-free attestation, and the signal list.
  // The CI publisher's ci-lane record is exempt — the publish job writes it
  // inside the lane it owns.
  if (gate.gate !== 'ci-lane') {
    const observed = Array.isArray(gate.observed) ? gate.observed : [];
    if (observed.length === 0) {
      return [
        'boundary-gate.json records no observed boundary marker (/.dockerenv or /run/.containerenv): a declared container= string alone is not an observed boundary; for host/VM execution keep the delivered head/round registration, choose --execution host|vm explicitly, and rerun prepare with its approved approval arguments BEFORE the battery; never hand-write the declaration',
      ];
    }
    if (gate.credentialFree !== true) {
      return [
        'boundary-gate.json does not record the credential-free attestation (credentialFree: true)',
      ];
    }
    if (!Array.isArray(gate.signals) || gate.signals.length === 0) {
      return ['boundary-gate.json records no isolation signals'];
    }
  }
  return [];
}

/**
 * Whether a round log carries a `container-nonce: <value>` line whose value's
 * sha256 equals the gate record's hash (R16-1). Walks the round dir, skipping
 * the declaration and gate record themselves, the TOP-LEVEL binary `evidence/`
 * subtree (the skill's PNG artifacts never carry the nonce, and charging the
 * byte budget against them would refuse a compliant round with large evidence —
 * R3-1; a nested dir named evidence is still scanned — R4-5), and any
 * non-regular file (a symlink is not followed). This is the SINGLE authoritative
 * matcher (the step-7 shell no longer re-implements it, R1-2/R2-6), so it reads
 * each log whole — a marker behind earlier output or straddling a chunk boundary
 * is still found (the partial line is scanned before the carry is capped, R3-3)
 * — while bounding the AGGREGATE work: one hoisted scratch buffer (R2-5), a
 * total byte budget, and a visited-entry cap that counts directories too, so a
 * PR-planted dir of huge no-newline files, many empty files, or a forest of
 * empty dirs cannot stall the check (R3-3, R4-4). Returns { found, bounded } so
 * the caller can tell "no marker" from "stopped at the bound" (R4-1). The
 * plaintext lives only container-local, so a host battery cannot produce a match.
 */
function nonceLogMatches(roundDir, expected) {
  const CHUNK_BYTES = 1024 * 1024;
  const TOTAL_BUDGET = 64 * 1024 * 1024;
  // The carry is capped to bound the per-chunk concatenation (a no-newline file
  // would otherwise grow it quadratically), but the partial line is SCANNED
  // before capping so a marker at its head is never lost (R3-3).
  const CARRY_CAP = 256;
  const MAX_ENTRIES = 20000;
  const buf = Buffer.alloc(CHUNK_BYTES);
  let budget = TOTAL_BUDGET;
  let visited = 0;
  let bounded = false;
  const matches = (text) => {
    for (const line of text.split('\n')) {
      const match = /container-nonce:[ \t]*(\S+)/.exec(line);
      if (
        match &&
        createHash('sha256').update(match[1]).digest('hex') === expected
      ) {
        return true;
      }
    }
    return false;
  };
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (budget <= 0 || visited >= MAX_ENTRIES) {
        bounded = true;
        return false;
      }
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        // Only the TOP-LEVEL evidence/ subtree (the skill's binary PNG
        // artifacts) is exempt from the byte budget; a nested directory named
        // evidence is still scanned, so a log there is not silently lost
        // (R4-5). Directories count against the entry cap so a planted forest
        // of empty dirs cannot make the walk unbounded (R4-4).
        if (d === roundDir && entry.name === 'evidence') continue;
        visited++;
        if (walk(p)) return true;
        continue;
      }
      if (!entry.isFile()) continue;
      if (
        entry.name === 'boundary.json' ||
        entry.name === 'boundary-gate.json'
      ) {
        continue;
      }
      visited++;
      let fd;
      try {
        fd = openSync(p, 'r');
      } catch {
        continue;
      }
      try {
        let carry = '';
        let pos = 0;
        while (budget > 0) {
          const toRead = Math.min(CHUNK_BYTES, budget);
          const n = readSync(fd, buf, 0, toRead, pos);
          if (n === 0) break;
          pos += n;
          budget -= n;
          // The budget can exhaust on the LAST file, where no next entry would
          // trip the loop-top check; record the bound here so the caller can
          // tell exhaustion from a genuine absence (R4-1).
          if (budget <= 0) bounded = true;
          const text = carry + buf.toString('utf8', 0, n);
          const lastNl = text.lastIndexOf('\n');
          if (lastNl >= 0) {
            if (matches(text.slice(0, lastNl))) return true;
            const partial = text.slice(lastNl + 1);
            if (matches(partial)) return true;
            carry = partial.slice(-CARRY_CAP);
          } else {
            if (matches(text)) return true;
            carry = text.slice(-CARRY_CAP);
          }
          if (n < toRead) break;
        }
        if (carry && matches(carry)) return true;
      } catch {
        // An unreadable file is skipped, not a crash out of the check.
      } finally {
        closeSync(fd);
      }
    }
    return false;
  };
  const found = walk(roundDir);
  return { found, bounded };
}

/**
 * The container nonce corroboration (R16-1 / D17-1 / D17-2). The gate record
 * carries only the nonce hash, never the plaintext, and a mode:"container"
 * declaration is refused unless a round log line hashes to it. Runs against
 * the round dir (the checker is the authoritative enforcement point, not the
 * shell recipe). A missing/invalid gate is left to gateRecordErrors; the
 * ci-lane record the publish job writes is exempt.
 */
export function containerNonceErrors(boundaryText, gateText, roundDir) {
  let boundary;
  try {
    boundary = JSON.parse(boundaryText);
  } catch {
    return [];
  }
  if (
    !boundary ||
    typeof boundary !== 'object' ||
    boundary.mode !== 'container'
  ) {
    return [];
  }
  let gate;
  try {
    gate = JSON.parse(gateText);
  } catch {
    return [];
  }
  if (
    !gate ||
    typeof gate !== 'object' ||
    gate.gate !== 'require-isolation' ||
    gate.passed !== true
  ) {
    return [];
  }
  const expected = gate.nonceSha256;
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
    return [
      'boundary-gate.json records no nonceSha256 (the 64-hex sha256 of the container-local nonce): a mode:"container" declaration must be tied to a nonce the battery echoed from inside the boundary, not a plaintext copied from the PR-writable record',
    ];
  }
  if (roundDir) {
    const { found, bounded } = nonceLogMatches(roundDir, expected);
    if (found) return [];
    if (bounded) {
      return [
        'the nonce log scan hit its resource bound (64 MiB total / 20000 entries) before reading a matching container-nonce line: refusing mode:"container" — the marker may exist beyond the bound; reduce the round\'s non-evidence log volume or echo the nonce into an early log; if execution must move to a host or VM, keep the current head/round in-flight registration and re-run prepare with --execution host|vm and its approval arguments BEFORE the battery; never hand-write the declaration',
      ];
    }
  }
  return [
    'round logs carry no container-nonce line whose sha256 matches boundary-gate.json nonceSha256: refusing mode:"container" — the battery must echo the container-local nonce ($HOME/.qwen-verify-nonce) into its logs; if execution must move to a host or VM, keep the current head/round in-flight registration and re-run prepare with --execution host|vm and its approval arguments BEFORE the battery; never hand-write the declaration',
  ];
}

// A waiver's approval must be a permalink a reader can open, not free text:
// the maintainer's approval comment on the PR or an issue. The capture
// groups let the checker compare the target against the round's own
// coordinates when they are available.
const APPROVAL_PERMALINK =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)#issuecomment-\d+$/;

// The skill's template strings are <placeholder> shaped; a declaration
// that still carries one was copied, not filled in. The tell is the
// skill's own tokens or a wholly-<…> value — not any angle brackets: a
// maintainer written as the standard git identity `Name <email>` is a
// filled-in value, not a placeholder.
const TEMPLATE_TOKENS = [
  '<maintainer>',
  '<why this round may run outside a boundary>',
  '<image, network policy, credential-free mount>',
  '<owner>/<repo>',
  '<round-dir>',
];
// A surviving template token inside an otherwise filled value is still a
// placeholder: "node:22-bookworm, <network policy>, credential-free mount"
// leaves the egress policy unstated even though the image was edited. The
// body excludes '@' so a filled git identity whose local part starts with a
// token word ("Name <repo@example.com>") is not accused — the skill's
// placeholders never carry an address.
const TEMPLATE_TOKEN_RE =
  /<(?:image|network(?: policy)?|credential-free mount|maintainer|permalink|why|round-dir|owner|repo)\b[^>@]*>/i;
const placeholder = (value) =>
  typeof value === 'string' &&
  (/^<[^>]+>$/.test(value.trim()) ||
    TEMPLATE_TOKENS.some((token) => value.includes(token)) ||
    TEMPLATE_TOKEN_RE.test(value));

const SHA256_RE = /^[0-9a-f]{64}$/;
const FULL_OID_RE = /^[0-9a-f]{40}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value.trim())) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Independently cross-checks a host snapshot's `trustClassification` object so
 * a self-contradictory classification (e.g. `prTrust: "external"` or non-empty
 * `escalationReasons` paired with `executionClass: "trusted-shared-kernel"`)
 * cannot pass the publication gate even if the upstream classifier were faulty.
 */
export function checkTrustClassification(tc, expectedHead = null) {
  if (tc === undefined) {
    return { errors: [], requiredExecutionClass: null };
  }
  if (tc === null || typeof tc !== 'object' || Array.isArray(tc)) {
    return {
      errors: ['trustClassification must be a JSON object'],
      requiredExecutionClass: 'hardware-isolated',
    };
  }
  const errors = [];
  if (tc.headRefOid && expectedHead && tc.headRefOid !== expectedHead) {
    errors.push(
      `stale trustClassification.headRefOid ${tc.headRefOid} (expected ${expectedHead})`,
    );
  }
  if (!PR_TRUST_LEVELS.includes(tc.prTrust)) {
    errors.push(
      `trustClassification.prTrust must be one of ${PR_TRUST_LEVELS.join(' | ')} (got ${JSON.stringify(tc.prTrust)})`,
    );
  }
  if (!EXECUTION_CLASSES.includes(tc.executionClass)) {
    errors.push(
      `trustClassification.executionClass must be one of ${EXECUTION_CLASSES.join(' | ')} (got ${JSON.stringify(tc.executionClass)})`,
    );
  }
  if (
    tc.escalationReasons !== undefined &&
    !Array.isArray(tc.escalationReasons)
  ) {
    errors.push('trustClassification.escalationReasons must be an array');
  }
  const hasEscalations =
    Array.isArray(tc.escalationReasons) && tc.escalationReasons.length > 0;
  const untrustedAuthor = tc.prTrust === 'external' || tc.prTrust === 'unknown';
  if (untrustedAuthor && tc.executionClass !== 'hardware-isolated') {
    errors.push(
      `trustClassification contradicts itself: prTrust=${tc.prTrust} cannot pair with executionClass=${JSON.stringify(tc.executionClass)} (must be hardware-isolated)`,
    );
  }
  if (hasEscalations && tc.executionClass !== 'hardware-isolated') {
    errors.push(
      `trustClassification contradicts itself: non-empty escalationReasons cannot pair with executionClass=${JSON.stringify(tc.executionClass)} (must be hardware-isolated)`,
    );
  }
  const requiredExecutionClass =
    untrustedAuthor || hasEscalations || errors.length > 0
      ? 'hardware-isolated'
      : tc.executionClass;
  return { errors, requiredExecutionClass };
}

/**
 * Validates the host-held execution-record.json that replaces guest
 * self-certification for microVM and provider-VM rounds (D9/D10).
 */
export function checkExecutionRecord(
  text,
  {
    expectedBase = null,
    expectedHead = null,
    coordinates = null,
    expectedSha256 = null,
    actualSha256 = null,
    expectedContextSha256 = null,
    requiredExecutionClass = null,
  } = {},
) {
  const errors = [];
  if (text === null || text === undefined || text.trim() === '') {
    return {
      errors: ['execution-record.json is missing or empty'],
      record: null,
    };
  }
  if (expectedSha256 && actualSha256 && actualSha256 !== expectedSha256) {
    return {
      errors: [
        'execution-record.json does not match --execution-record-sha256: the host execution record was modified or substituted',
      ],
      record: null,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      errors: ['execution-record.json is not valid JSON'],
      record: null,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      errors: ['execution-record.json must be a JSON object'],
      record: null,
    };
  }
  const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
  if (parsed.schemaVersion !== EXECUTION_RECORD_SCHEMA) {
    errors.push(
      `execution-record.json schemaVersion must be "${EXECUTION_RECORD_SCHEMA}" (got ${JSON.stringify(parsed.schemaVersion)})`,
    );
  }
  for (const field of [
    'runId',
    'repo',
    'baseRefOid',
    'headRefOid',
    'contextDigest',
    'backend',
    'backendVersion',
    'platform',
    'launchPolicyDigest',
    'trustedInputDigest',
  ]) {
    if (!nonEmpty(parsed[field])) {
      errors.push(`execution-record.json missing required field ${field}`);
    }
  }
  if (!Number.isInteger(parsed.pr) || parsed.pr <= 0) {
    errors.push('execution-record.json pr must be a positive integer');
  }
  // Without host-held coordinates the record cannot be anchored to this
  // round; refuse rather than accept a self-consistent forged record.
  if (
    !coordinates ||
    typeof coordinates.owner !== 'string' ||
    typeof coordinates.repo !== 'string'
  ) {
    errors.push(
      'execution-record.json requires a host-held --context to anchor repo, pr, and headRefOid to this round',
    );
  }
  if (!expectedHead) {
    errors.push(
      'execution-record.json requires a host-held --context headRefOid to anchor headRefOid to this round',
    );
  }
  if (
    parsed.supervisorPid !== undefined &&
    !Number.isInteger(parsed.supervisorPid)
  ) {
    errors.push(
      'execution-record.json supervisorPid must be an integer when present',
    );
  }
  if (nonEmpty(parsed.baseRefOid) && !FULL_OID_RE.test(parsed.baseRefOid)) {
    errors.push('execution-record.json baseRefOid must be a 40-hex OID');
  } else if (
    expectedBase &&
    nonEmpty(parsed.baseRefOid) &&
    parsed.baseRefOid !== expectedBase
  ) {
    errors.push(
      `execution-record.json baseRefOid ${parsed.baseRefOid} does not match expected base ${expectedBase}`,
    );
  }
  if (nonEmpty(parsed.headRefOid) && !FULL_OID_RE.test(parsed.headRefOid)) {
    errors.push('execution-record.json headRefOid must be a 40-hex OID');
  } else if (
    expectedHead &&
    nonEmpty(parsed.headRefOid) &&
    parsed.headRefOid !== expectedHead
  ) {
    errors.push(
      `execution-record.json headRefOid ${parsed.headRefOid} does not match expected head ${expectedHead}`,
    );
  }
  if (coordinates && nonEmpty(parsed.repo)) {
    const expectedRepo = `${coordinates.owner}/${coordinates.repo}`;
    if (
      parsed.repo.toLowerCase() !== expectedRepo.toLowerCase() ||
      parsed.pr !== coordinates.number
    ) {
      errors.push(
        `execution-record.json cites ${parsed.repo}#${parsed.pr}, not this round's ${expectedRepo}#${coordinates.number}`,
      );
    }
  }
  for (const digestField of [
    'contextDigest',
    'launchPolicyDigest',
    'trustedInputDigest',
  ]) {
    if (nonEmpty(parsed[digestField]) && !SHA256_RE.test(parsed[digestField])) {
      errors.push(`execution-record.json ${digestField} must be 64-hex sha256`);
    }
  }
  if (
    expectedContextSha256 &&
    nonEmpty(parsed.contextDigest) &&
    parsed.contextDigest !== expectedContextSha256
  ) {
    errors.push(
      `execution-record.json contextDigest ${parsed.contextDigest} does not match host context sha256 ${expectedContextSha256}`,
    );
  }

  const { prTrust, executionClass, backend } = parsed;
  if (!PR_TRUST_LEVELS.includes(prTrust)) {
    errors.push(
      `execution-record.json prTrust must be one of ${PR_TRUST_LEVELS.join(' | ')}`,
    );
  }
  if (!EXECUTION_CLASSES.includes(executionClass)) {
    errors.push(
      `execution-record.json executionClass must be one of ${EXECUTION_CLASSES.join(' | ')}`,
    );
  }
  if (
    requiredExecutionClass === 'hardware-isolated' &&
    executionClass !== 'hardware-isolated'
  ) {
    errors.push(
      `execution-record.json executionClass=${JSON.stringify(executionClass)} violates host context requirement executionClass=hardware-isolated`,
    );
  }
  if (
    (prTrust === 'external' || prTrust === 'unknown') &&
    executionClass !== 'hardware-isolated'
  ) {
    errors.push(
      `execution-record.json prTrust=${prTrust} requires executionClass=hardware-isolated (got ${JSON.stringify(executionClass)})`,
    );
  }
  if (
    executionClass === 'hardware-isolated' &&
    !HARDWARE_BACKENDS.includes(backend)
  ) {
    errors.push(
      `execution-record.json executionClass=hardware-isolated requires backend in ${HARDWARE_BACKENDS.join(' | ')} (got ${JSON.stringify(backend)})`,
    );
  }
  if (
    executionClass === 'trusted-shared-kernel' &&
    !LIGHTWEIGHT_BACKENDS.includes(backend)
  ) {
    errors.push(
      `execution-record.json executionClass=trusted-shared-kernel requires backend in ${LIGHTWEIGHT_BACKENDS.join(' | ')} (got ${JSON.stringify(backend)})`,
    );
  }

  if (parsed.outputStatus !== 'complete') {
    errors.push(
      `execution-record.json outputStatus must be "complete" before publish (got ${JSON.stringify(parsed.outputStatus)})`,
    );
  }

  const startedMs = parseIsoTimestamp(parsed.startedAt);
  const endedMs = parseIsoTimestamp(parsed.endedAt);
  const destroyedMs = parseIsoTimestamp(parsed.destroyedAt);
  if (startedMs === null || endedMs === null) {
    errors.push(
      'execution-record.json requires valid ISO startedAt and endedAt',
    );
  } else if (endedMs < startedMs) {
    errors.push('execution-record.json endedAt must not precede startedAt');
  }
  if (parsed.teardownStatus !== 'destroyed') {
    errors.push(
      `execution-record.json teardownStatus must be "destroyed" before publish (got ${JSON.stringify(parsed.teardownStatus)})`,
    );
  }
  if (destroyedMs === null || (startedMs !== null && destroyedMs < startedMs)) {
    errors.push(
      'execution-record.json destroyedAt must be a valid ISO timestamp at or after startedAt',
    );
  }
  if (parsed.diskDestroyed !== true) {
    errors.push(
      'execution-record.json diskDestroyed must be true before publish',
    );
  }
  if (parsed.tokenRevoked !== true) {
    errors.push(
      'execution-record.json tokenRevoked must be true before publish',
    );
  }

  if (backend === 'firecracker' || backend === 'vfkit') {
    for (const digestField of ['kernelDigest', 'rootfsDigest']) {
      if (
        !nonEmpty(parsed[digestField]) ||
        !SHA256_RE.test(parsed[digestField])
      ) {
        errors.push(
          `execution-record.json ${digestField} must be 64-hex sha256 for backend ${backend}`,
        );
      }
    }
    if (!Number.isInteger(parsed.workerPid) || parsed.workerPid <= 1) {
      errors.push(
        `execution-record.json workerPid must be an integer > 1 for backend ${backend}`,
      );
    }
    if (!nonEmpty(parsed.workerExe)) {
      errors.push(
        `execution-record.json workerExe is required for backend ${backend}`,
      );
    }
    if (parsed.workerExitEvidence !== 'absent') {
      errors.push(
        `execution-record.json workerExitEvidence must be "absent" before publish (got ${JSON.stringify(parsed.workerExitEvidence)})`,
      );
    }
  } else if (backend === 'provider-vm') {
    const pl = parsed.providerLifecycle;
    if (pl === null || typeof pl !== 'object' || Array.isArray(pl)) {
      errors.push(
        'execution-record.json providerLifecycle is required for backend provider-vm',
      );
    } else {
      if (!nonEmpty(pl.allocationId)) {
        errors.push(
          'execution-record.json providerLifecycle.allocationId is required',
        );
      }
      if (!nonEmpty(pl.freshDiskId)) {
        errors.push(
          'execution-record.json providerLifecycle.freshDiskId is required',
        );
      }
      if (pl.boundRunId !== parsed.runId) {
        errors.push(
          'execution-record.json providerLifecycle.boundRunId must match runId',
        );
      }
      if (pl.boundHeadRefOid !== parsed.headRefOid) {
        errors.push(
          'execution-record.json providerLifecycle.boundHeadRefOid must match headRefOid',
        );
      }
      if (pl.terminationState !== 'terminated') {
        errors.push(
          `execution-record.json providerLifecycle.terminationState must be "terminated" (got ${JSON.stringify(pl.terminationState)})`,
        );
      }
      if (pl.diskDeleted !== true) {
        errors.push(
          'execution-record.json providerLifecycle.diskDeleted must be true before publish',
        );
      }
    }
  }

  return { errors, record: parsed };
}

export function checkBoundary(
  text,
  gateText = null,
  {
    publishLane = false,
    coordinates = null,
    executionRecord = null,
    executionRecordSha256 = null,
  } = {},
) {
  if (text === null || text === undefined || text.trim() === '') {
    return {
      errors: [
        'boundary.json is missing: every round declares where the untrusted PR code ran — for a container, write {"mode":"container","detail":…} only after the isolation gate passes; for host/VM execution, keep the current head/round in-flight registration and re-run prepare with --execution host|vm and its approval arguments before the battery instead of hand-writing a declaration',
      ],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ['boundary.json is not valid JSON'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { errors: ['boundary.json must be an object with a mode'] };
  }
  if (!BOUNDARY_MODES.includes(parsed.mode)) {
    return {
      errors: [
        `boundary.json mode must be one of ${BOUNDARY_MODES.join(' | ')}; got ${JSON.stringify(parsed.mode)}`,
      ],
    };
  }
  const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
  if (parsed.mode === 'container' && !nonEmpty(parsed.detail)) {
    return {
      errors: [
        'boundary.json mode container needs a non-empty detail naming the boundary (image and network policy, or the CI lane)',
      ],
    };
  }
  if (parsed.mode === 'container' && placeholder(parsed.detail)) {
    return {
      errors: [
        'boundary.json detail still carries a <placeholder>: name the actual image and network policy',
      ],
    };
  }
  if (parsed.mode === 'container') {
    const gateErrors = gateRecordErrors(gateText, { publishLane });
    if (gateErrors.length > 0) return { errors: gateErrors };
    if (
      parsed.executionClass !== undefined &&
      parsed.executionClass !== 'trusted-shared-kernel'
    ) {
      return {
        errors: [
          `boundary.json mode container cannot declare executionClass=${JSON.stringify(parsed.executionClass)} (must be "trusted-shared-kernel")`,
        ],
      };
    }
    if (executionRecord) {
      if (executionRecord.executionClass !== 'trusted-shared-kernel') {
        return {
          errors: [
            `boundary.json mode container contradicts execution-record.json executionClass=${JSON.stringify(executionRecord.executionClass)}`,
          ],
        };
      }
      if (
        parsed.executionClass !== undefined &&
        parsed.executionClass !== executionRecord.executionClass
      ) {
        return {
          errors: [
            `boundary.json executionClass=${JSON.stringify(parsed.executionClass)} contradicts execution-record.json executionClass=${JSON.stringify(executionRecord.executionClass)}`,
          ],
        };
      }
    }
  }

  const isProviderVmBoundary =
    parsed.mode === 'vm' &&
    (parsed.backend === 'provider-vm' ||
      executionRecord?.backend === 'provider-vm');

  if (parsed.mode === 'microvm' || isProviderVmBoundary) {
    if (!executionRecord) {
      return {
        errors: [
          `boundary.json ${parsed.mode === 'microvm' ? 'mode microvm' : 'mode vm with backend provider-vm'} requires a host-held --execution-record (guest-written declarations cannot self-certify hardware isolation)`,
        ],
      };
    }
    const expectedBackendSet =
      parsed.mode === 'microvm' ? ['firecracker', 'vfkit'] : ['provider-vm'];
    const errors = [];
    if (executionRecord.executionClass !== 'hardware-isolated') {
      errors.push(
        `boundary.json mode ${parsed.mode} requires executionClass=hardware-isolated (execution-record.json has ${JSON.stringify(executionRecord.executionClass)})`,
      );
    }
    if (!expectedBackendSet.includes(executionRecord.backend)) {
      errors.push(
        `boundary.json mode ${parsed.mode} requires backend in ${expectedBackendSet.join(' | ')} (execution-record.json has ${JSON.stringify(executionRecord.backend)})`,
      );
    }
    for (const field of [
      'backend',
      'executionClass',
      'prTrust',
      'runId',
      'headRefOid',
    ]) {
      if (parsed[field] !== executionRecord[field]) {
        errors.push(
          `boundary.json ${field} (${JSON.stringify(parsed[field])}) must match execution-record.json (${JSON.stringify(executionRecord[field])})`,
        );
      }
    }
    if (parsed.writtenAfterTeardown !== true) {
      errors.push(
        `boundary.json mode ${parsed.mode} must set writtenAfterTeardown: true`,
      );
    }
    if (
      executionRecordSha256 &&
      parsed.executionRecordSha256 !== executionRecordSha256
    ) {
      errors.push(
        'boundary.json executionRecordSha256 must match the host execution record digest',
      );
    }
    return { errors };
  }

  // A waived host round and an attested VM both run outside an observed
  // container boundary, so both need the maintainer's recorded approval.
  // The VM additionally records what the operator attested (nothing mounted).
  if ((parsed.mode === 'waived' || parsed.mode === 'vm') && executionRecord) {
    return {
      errors: [
        `boundary.json mode ${parsed.mode} contradicts a host --execution-record`,
      ],
    };
  }
  const approvalMode = parsed.mode === 'waived' || parsed.mode === 'vm';
  if (approvalMode && (!nonEmpty(parsed.by) || !nonEmpty(parsed.reason))) {
    return {
      errors: [
        `boundary.json mode ${parsed.mode} needs non-empty by (the maintainer who approved execution outside an observed container) and reason (why this round may run outside a boundary)`,
      ],
    };
  }
  if (approvalMode && (placeholder(parsed.by) || placeholder(parsed.reason))) {
    return {
      errors: [
        `boundary.json ${parsed.mode} declaration still carries a <placeholder>: record the actual maintainer and reason`,
      ],
    };
  }
  if (parsed.mode === 'vm' && !nonEmpty(parsed.attestation)) {
    return {
      errors: [
        'boundary.json mode vm needs a non-empty attestation: what the operator confirmed before declaring the VM credential-free (nothing mounted, no host credentials)',
      ],
    };
  }
  if (parsed.mode === 'vm' && placeholder(parsed.attestation)) {
    return {
      errors: [
        'boundary.json vm attestation still carries a <placeholder>: record what the operator actually confirmed',
      ],
    };
  }
  // A local trusted-head declaration has no public comment permalink. Its
  // host-held executionApproval record is mandatory at the CLI check below;
  // this pure shape check does not admit that record on its own.
  if (approvalMode && parsed.source !== 'local-trust') {
    const match = APPROVAL_PERMALINK.exec(parsed.approval ?? '');
    if (!match) {
      return {
        errors: [
          `boundary.json mode ${parsed.mode} needs approval: a permalink to the maintainer's approval comment (https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>) — free-text by is a claim, not a verifiable reference${coordinates ? '' : ' (no round coordinates available, so only the URL shape is checked)'}`,
        ],
      };
    }
    // The permalink is the declaration's only machine-checkable element: it
    // must cite this round's PR, not any comment on any repository.
    if (
      coordinates &&
      (match[1].toLowerCase() !== coordinates.owner.toLowerCase() ||
        match[2].toLowerCase() !== coordinates.repo.toLowerCase() ||
        match[3] !== String(coordinates.number))
    ) {
      return {
        errors: [
          `boundary.json approval permalink cites ${match[1]}/${match[2]}#${match[3]}, not this round's ${coordinates.owner}/${coordinates.repo}#${coordinates.number}: the approval must be the maintainer's comment on this PR`,
        ],
      };
    }
  }
  // `by` is a recorded claim, not an identity the checker can verify; the
  // approval permalink and the maintainer's review are the enforcement there.
  return { errors: [] };
}

/** Validates a VM/host declaration against prepare's host-held approval. */
export function executionApprovalErrors(
  boundaryText,
  snapshot,
  {
    contextProvided = false,
    contextDigestVerified = false,
    boundaryUnreadable = false,
  } = {},
) {
  const hasSnapshotApproval =
    snapshot?.executionApproval &&
    typeof snapshot.executionApproval === 'object' &&
    !Array.isArray(snapshot.executionApproval);
  if (
    hasSnapshotApproval &&
    !boundaryUnreadable &&
    (!boundaryText || !boundaryText.trim())
  ) {
    return [
      `host --context carries a preflight executionApproval for mode ${JSON.stringify(snapshot.executionApproval.mode)}, but artifact boundary.json is missing or empty`,
    ];
  }
  let declared;
  try {
    declared = JSON.parse(boundaryText ?? '');
  } catch {
    return [];
  }
  if (
    hasSnapshotApproval &&
    (declared?.mode === 'container' ||
      declared?.mode === 'microvm' ||
      (declared?.mode === 'vm' && declared?.backend === 'provider-vm'))
  ) {
    const modeLabel =
      declared.mode === 'vm' ? 'vm (provider-vm)' : declared.mode;
    return [
      `host --context carries a preflight executionApproval for mode ${JSON.stringify(snapshot.executionApproval.mode)}, which contradicts boundary.json mode ${modeLabel}; re-run prepare for the actual execution mode instead of rewriting boundary.json`,
    ];
  }
  if (
    !declared ||
    !['vm', 'waived'].includes(declared.mode) ||
    (declared.mode === 'vm' && declared.backend === 'provider-vm')
  ) {
    return [];
  }
  if (!contextProvided) {
    return [
      `boundary.json mode ${declared.mode} needs the host-held --context snapshot containing prepare's executionApproval`,
    ];
  }
  if (!contextDigestVerified) {
    return [
      `boundary.json mode ${declared.mode} needs --context-sha256 matching the host snapshot's bytes so its executionApproval predates publication`,
    ];
  }
  const approval = snapshot?.executionApproval;
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    return [
      'the trusted --context snapshot has no executionApproval object; prepare must approve this VM/host execution before artifacts are created',
    ];
  }
  const stringFields = [
    'mode',
    'source',
    'by',
    'basis',
    'permission',
    'head',
    'reason',
  ];
  if (
    stringFields.some(
      (field) => typeof approval[field] !== 'string' || !approval[field],
    ) ||
    !Number.isSafeInteger(approval.round) ||
    approval.round <= 0 ||
    !['vm', 'waived'].includes(approval.mode) ||
    !/^[0-9a-f]{40}$/.test(approval.head) ||
    !['admin', 'maintain', 'write'].includes(approval.permission) ||
    (approval.mode === 'vm' &&
      (typeof approval.attestation !== 'string' || !approval.attestation))
  ) {
    return [
      'executionApproval must carry non-empty mode/source/by/basis/permission/head/reason, a valid round and permission, and VM attestation',
    ];
  }
  if (approval.source === 'local-trust') {
    const eligible =
      (approval.basis === 'own-pr' &&
        snapshot?.author?.login === approval.by) ||
      (approval.basis === 'same-repository' &&
        snapshot?.isCrossRepository === false);
    if (!eligible) {
      return [
        'local-trust executionApproval does not match this snapshot: own-pr requires by == author.login; same-repository requires isCrossRepository == false',
      ];
    }
  } else if (approval.source === 'comment') {
    if (
      approval.basis !== 'maintainer-comment' ||
      !APPROVAL_PERMALINK.test(approval.approval ?? '') ||
      !Number.isSafeInteger(approval.comment?.id) ||
      approval.comment.id <= 0 ||
      !/^[0-9a-f]{64}$/.test(approval.comment?.bodySha256 ?? '') ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        approval.registrationNonce ?? '',
      )
    ) {
      return [
        'comment executionApproval needs basis maintainer-comment, an approval permalink, numeric comment.id, 64-hex comment.bodySha256 and its registrationNonce',
      ];
    }
  } else {
    return [
      'executionApproval source must be local-trust or comment, with its matching basis',
    ];
  }
  const errors = [];
  if (
    approval.mode !== declared.mode ||
    approval.head !== snapshot?.headRefOid
  ) {
    errors.push(
      'executionApproval mode/head does not match the declaration and trusted headRefOid; a moved head needs a fresh approval',
    );
  }
  if (!isDeepStrictEqual(approval, declared)) {
    errors.push(
      'boundary.json differs from the host-held executionApproval; restore the declaration prepare wrote instead of editing the PR-side copy',
    );
  }
  return errors;
}

// GitHub renders CRLF and LF identically, so a Windows-authored artifact
// must not fail the line-anchored checks on a stray \r.
function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * The verdict line is a plain paragraph. Three rounds of PR #15984 opened
 * with `# PR … — **Verdict: …** — <the whole verdict paragraph>` on one line,
 * which GitHub renders as a single giant H1 — structurally valid Markdown,
 * visually a wall of bold text. A heading carrying the verdict, or any
 * over-long heading in the lead, is that defect's shape.
 */
function leadShapeWarnings(text, verdict, label) {
  const first = text.split('\n').find((line) => line.trim() !== '');
  if (!first || !HEADING.test(first)) return [];
  const holdsVerdict = verdict !== null && first.includes(verdict);
  if (!holdsVerdict && first.length <= HEADING_TITLE_MAX) return [];
  return [
    `${label} opens with a heading${holdsVerdict ? ' carrying the verdict' : ` of ${first.length} characters`}: GitHub renders the whole line as one giant H1 — the verdict line is a plain paragraph (no leading #), and a heading is a short title on its own line`,
  ];
}

/**
 * The Methodology must OPEN with the Boundary line, not merely mention the
 * rule somewhere: a bare token search passes a report that discusses the
 * requirement while reporting nothing about where the PR code actually ran.
 */
function boundaryLineWarnings(text, label, boundaryMode = null) {
  const lines = text.split('\n');
  const token = '**Boundary.**';
  // A Methodology heading or Boundary disclosure inside a code fence is a
  // copied template, not the round's own declaration: scan prose only, so a
  // fenced example neither satisfies the disclosure nor accuses a real
  // Methodology that follows it. Track ``` / ~~~ fences (a closing run is the
  // same character, at least as long, with nothing after it).
  const prose = [];
  let fence = null;
  for (const line of lines) {
    const run = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (run) {
      const [, , marks, rest] = run;
      if (fence === null) {
        fence = { char: marks[0], len: marks.length };
        continue;
      }
      if (
        marks[0] === fence.char &&
        marks.length >= fence.len &&
        rest.trim() === ''
      ) {
        fence = null;
        continue;
      }
    }
    if (fence === null) prose.push(line);
  }
  // Locate the Methodology label by its first word after stripping the
  // shapes a report may wrap it in — blockquote, list marker, ATX hashes,
  // bold/italic wrapping — so a bold-only "**Methodology**" or a Setext
  // heading is found, not just the hand-listed ATX/numbered forms.
  // Strip the outer heading marker before the list marker so an ATX heading
  // that itself carries a number ("## 8. Methodology") normalises fully
  // (R12 deferred); a single fixed order missed the nested shape.
  const normalize = (line) =>
    line
      .trim()
      .replace(/^(?:>\s*)+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*]\s+|\d+\.\s+)+/, '')
      .replace(/^(\*{1,2}|_{1,2})/, '')
      .replace(/(\*{1,2}|_{1,2})$/, '')
      .trim();
  const isMethodology = (line, i) => {
    if (!/^Methodology\b/i.test(normalize(line))) return false;
    const trimmed = line.trim();
    const isList = /^(?:[-*]\s+|\d+\.\s+)/.test(trimmed);
    // Headings (ATX/Setext) and the bold numbered label are always sections.
    if (
      !isList ||
      /\*\*Methodology/i.test(trimmed) ||
      trimmed.includes(token)
    ) {
      return true;
    }
    // A bare list bullet ("− Methodology", "1. Methodology") is a section
    // only when the Boundary line follows it; otherwise it is a table-of-
    // contents entry and must not claim the section (R11 deferred).
    const next = prose.slice(i + 1).find((l) => l.trim() !== '');
    return !!next && next.trim().startsWith(token);
  };
  let idx = prose.findIndex((line, i) => isMethodology(line, i));
  if (idx === -1) {
    // Setext form: a "Methodology" line underlined by === or ---.
    idx = prose.findIndex(
      (line, i) =>
        /^Methodology\s*$/i.test(line.trim()) &&
        /^(?:={3,}|-{3,})\s*$/.test((prose[i + 1] ?? '').trim()),
    );
  }
  // A Setext underline (=== / ---) belongs to the heading, not the body:
  // skip it when looking for the first line after the Methodology opening,
  // or a valid Setext heading is accused of missing its Boundary line.
  const setext =
    idx !== -1 && /^(?:={3,}|-{3,})\s*$/.test((prose[idx + 1] ?? '').trim());
  const warnings = [];
  let boundaryLine = null;
  if (idx === -1) {
    warnings.push(
      `${label} has no Methodology section (a Methodology heading or the numbered **Methodology** label): it opens with a **Boundary.** line naming where the untrusted PR code ran (the image and network policy, or the recorded waiver)`,
    );
    // Still police the disclosure: fall back to the first Boundary line so
    // an empty or template disclosure is reported even without the section.
    boundaryLine =
      prose.find((line) => line.trim().startsWith(token))?.trim() ?? null;
  } else {
    // The label line may carry the Boundary line on the same line, with only
    // a separator between ("8. **Methodology** — **Boundary.** …"); a prose
    // mention ("we discuss the **Boundary.** rule") is not a declaration.
    const opening = prose[idx].trim();
    if (
      /(?:#{1,6}\s+|\d+\.\s+)?\*{0,2}Methodology\*{0,2}\s*(?:[—:-]\s*)?\*\*Boundary\.\*\*/i.test(
        opening,
      )
    ) {
      boundaryLine = opening;
    } else {
      const first = prose
        .slice(setext ? idx + 2 : idx + 1)
        .find((line) => line.trim() !== '');
      if (first && first.trim().startsWith(token)) {
        boundaryLine = first.trim();
      } else {
        warnings.push(
          `${label}: the first line after the Methodology opening must be the **Boundary.** line — a prose mention of the rule elsewhere does not declare where the untrusted PR code ran`,
        );
      }
    }
  }
  if (boundaryLine !== null) {
    // The disclosure must say something and must not contradict the recorded
    // declaration. The content is what follows the token — on the same-line
    // form the label precedes it. The recorded mode is authoritative: a
    // container claim contradicted by waiver/VM prose is flagged, but a
    // truthful waiver phrased without the "waiv" stem is not accused.
    const content = boundaryLine
      .slice(boundaryLine.indexOf(token) + token.length)
      .trim();
    if (content === '' || placeholder(content)) {
      warnings.push(
        `${label}: the **Boundary.** line carries ${content === '' ? 'no disclosure' : 'a <placeholder> disclosure'} — name the image and network policy, or the recorded waiver`,
      );
    }
    // Probe for a positive waiver/VM claim, not the bare word: a truthful
    // container report may say "not a VM" or "no VM used" without claiming
    // a VM boundary. The abbreviated "VM" needs an execution preposition;
    // the full phrase "virtual machine" is specific enough on its own.
    if (
      boundaryMode === 'container' &&
      (/\bwaived\b/i.test(content) ||
        /\b(?:in|on|inside|within|using|via)\s+(?:a\s+|an\s+)?vm\b|virtual machine/i.test(
          content,
        ))
    ) {
      warnings.push(
        `${label}: boundary.json records a container but the **Boundary.** line claims a waiver or VM — the prose names a boundary the declaration contradicts`,
      );
    }
    // A waiver/VM is contradicted by prose naming a container runtime. Probe
    // for a positive container signal (an image, a network policy), not the
    // bare word "container": a truthful "no container was used" must not be
    // accused, and a waiver phrased without the "waiv" stem is not flagged.
    if (
      (boundaryMode === 'waived' ||
        boundaryMode === 'vm' ||
        boundaryMode === 'microvm') &&
      /node:\d|--network none/i.test(content)
    ) {
      warnings.push(
        `${label}: boundary.json records a ${boundaryMode} but the **Boundary.** line names a container runtime — the prose names a boundary the declaration contradicts`,
      );
    }
  }
  return warnings;
}

/**
 * Pure check over already-read artifacts. `files` carries raw text or null;
 * `evidence` is the PNG file names under evidence/.
 * `publisherOwnsBoundary` marks the CI entry path, where the publish job
 * writes the declaration after the round finishes: a round's own pre-finish
 * self-check (which a base-pinned skill still instructs) must not see a
 * false error for a file only the later job writes.
 */
export function checkArtifacts({
  files,
  evidence = [],
  expectedBase = null,
  expectedHead = null,
  publisherOwnsBoundary = false,
  publishLane = false,
  coordinates = null,
  evidenceUnreadable = false,
  unreadableKeys = new Set(),
  executionRecordText = null,
  executionRecordSha256 = null,
  expectedContextSha256 = null,
  requiredExecutionClass = null,
  trustClassification = undefined,
}) {
  const errors = [];
  const warnings = [];

  for (const name of ['report.md', 'verdict.txt', 'assertions.json']) {
    const key = name.split('.')[0];
    // An unreadable artifact is reported as unreadable, not also as missing.
    if (unreadableKeys.has(key)) continue;
    const text = files[key];
    if (text === null || text === undefined) {
      errors.push(`${name} is missing`);
    } else if (text.trim() === '') {
      errors.push(`${name} is empty`);
    }
  }

  let verdict = null;
  if (files.verdict && files.verdict.trim() !== '') {
    verdict = files.verdict.trim();
    if (!VERDICTS.includes(verdict)) {
      errors.push(
        `verdict.txt must be exactly one of ${VERDICTS.join(' | ')}; got ${JSON.stringify(verdict)}`,
      );
      verdict = null;
    } else if (files.verdict.trimEnd() !== verdict) {
      warnings.push('verdict.txt has leading whitespace; it must be one word');
    }
  }

  let counts = null;
  let attributions = null;
  let ledgerPresent = false;
  if (files.assertions && files.assertions.trim() !== '') {
    let parsed;
    let parsedOk = true;
    try {
      parsed = JSON.parse(files.assertions);
    } catch {
      parsedOk = false;
      errors.push('assertions.json is not valid JSON');
    }
    // JSON.parse('null') succeeds, and the publisher's jq requires
    // type == "object": without this branch a null or array artifact skips
    // every count check and still reads as evidence.
    if (
      parsedOk &&
      (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    ) {
      errors.push(
        'assertions.json must be an object with pass, fail and total',
      );
    } else if (parsedOk) {
      const fields = ['pass', 'fail', 'total'];
      const valid = fields.every(
        (field) => Number.isInteger(parsed?.[field]) && parsed[field] >= 0,
      );
      if (!valid) {
        errors.push(
          'assertions.json must carry non-negative integers pass, fail and total',
        );
      } else if (parsed.total === 0) {
        errors.push(
          'assertions.json total is 0: a round with no executed assertion has no structured verdict',
        );
      } else if (parsed.total !== parsed.pass + parsed.fail) {
        errors.push(
          `assertions.json is inconsistent: total ${parsed.total} != pass ${parsed.pass} + fail ${parsed.fail}`,
        );
      } else {
        counts = { pass: parsed.pass, fail: parsed.fail, total: parsed.total };
        const ledger = parsed.failures;
        if (ledger !== undefined) {
          ledgerPresent = true;
          if (!Array.isArray(ledger)) {
            errors.push(
              'assertions.json failures must be an array of { id, attribution } entries',
            );
          } else if (
            ledger.some(
              (entry) =>
                !entry ||
                typeof entry.id !== 'string' ||
                entry.id.trim() === '' ||
                !ATTRIBUTIONS.includes(entry.attribution),
            )
          ) {
            errors.push(
              `assertions.json failures entries each need an id and an attribution of ${ATTRIBUTIONS.join(' | ')}`,
            );
          } else if (ledger.length !== counts.fail) {
            errors.push(
              `assertions.json lists ${ledger.length} failure${ledger.length === 1 ? '' : 's'} but counts fail ${counts.fail}: the ledger and the count must agree`,
            );
          } else {
            attributions = ledger.map((entry) => entry.attribution);
          }
        }
        // Gate counts are the repo's existing tests, kept apart so that
        // pass/fail/total measure what this round wrote. The messages carry
        // no suite name: the publisher forwards error lines to its log.
        const gates = parsed.gates;
        // The safe-integer ceiling keeps parity with the publisher's jq:
        // a JSON literal like 1e309 parses to Infinity here, while jq
        // clamps it to a finite double that would otherwise pass.
        const isCount = (value) =>
          Number.isInteger(value) &&
          value >= 0 &&
          value <= Number.MAX_SAFE_INTEGER;
        // Blank means JSON whitespace only: trim() and jq's \S disagree on
        // U+0085 and U+FEFF.
        const gatesValid =
          Array.isArray(gates) &&
          gates.every(
            (gate) =>
              !!gate &&
              typeof gate.suite === 'string' &&
              /[^ \t\n\r]/.test(gate.suite) &&
              isCount(gate.pass) &&
              isCount(gate.fail) &&
              (gate.skipped === undefined || isCount(gate.skipped)),
          );
        if (gates !== undefined && !gatesValid) {
          errors.push(
            'assertions.json gates must be an array of { suite, pass, fail } entries with non-negative integer counts (skipped optional)',
          );
        }
        // Only recorded results silence the size warning: an empty list, or
        // entries that count nothing, moved no suite out of the counts.
        const gateResults = gatesValid
          ? gates.reduce((sum, gate) => sum + gate.pass + gate.fail, 0)
          : 0;
        if (counts.total > SUITE_SIZED_TOTAL && gateResults === 0) {
          warnings.push(
            `assertions.json counts ${counts.total} assertions and records no gate results: an existing test suite's results belong in gates, not in pass, fail and total`,
          );
        }
      }
    }
  }

  if (verdict === 'merge-ready' && counts && counts.fail > 0) {
    errors.push(
      `merge-ready with ${counts.fail} failed assertion${counts.fail === 1 ? '' : 's'}: expected A/B control reds count as passes, so a real fail contradicts the verdict`,
    );
  }

  // The counting rule the prose taught only halfway: an A/A control proves a
  // red is environmental, and nothing said how to count it afterwards. A round
  // booked the same host red twice — head and its base control — and published
  // `findings` while its own verdict line said neither reason was a PR defect.
  if (counts && counts.fail > 0) {
    const plural = counts.fail === 1 ? '' : 's';
    if (attributions === null && !ledgerPresent) {
      warnings.push(
        `assertions.json carries no failures ledger for ${counts.fail} failed assertion${plural}: add failures[].attribution (${ATTRIBUTIONS.join(' | ')}) so a red the PR did not cause cannot decide the verdict`,
      );
    } else if (
      attributions !== null &&
      !attributions.includes('pr') &&
      (verdict === 'findings' || verdict === 'blocked')
    ) {
      errors.push(
        `${verdict} with ${counts.fail} failed assertion${plural} and none attributed to the PR (${[...new Set(attributions)].join(', ')}): re-encode an A/A-proven environment red as an expected-red pass and move the lost coverage to Not covered, and report a harness fault as inconclusive`,
      );
    }
  }

  errors.push(...checkMutationCoverage(files.mutations).errors);
  let effectiveRequiredClass = requiredExecutionClass;
  if (trustClassification !== undefined) {
    const tcCheck = checkTrustClassification(trustClassification, expectedHead);
    errors.push(...tcCheck.errors);
    if (
      tcCheck.requiredExecutionClass === 'hardware-isolated' ||
      effectiveRequiredClass === null
    ) {
      effectiveRequiredClass = tcCheck.requiredExecutionClass;
    }
  }
  let executionRecord = null;
  let actualExecutionRecordSha256 = null;
  if (executionRecordText !== null && executionRecordText !== undefined) {
    actualExecutionRecordSha256 = createHash('sha256')
      .update(executionRecordText, 'utf8')
      .digest('hex');
    const execCheck = checkExecutionRecord(executionRecordText, {
      expectedBase,
      expectedHead,
      coordinates,
      expectedSha256: executionRecordSha256,
      actualSha256: actualExecutionRecordSha256,
      expectedContextSha256,
      requiredExecutionClass: effectiveRequiredClass,
    });
    errors.push(...execCheck.errors);
    executionRecord = execCheck.record;
    if (
      executionRecord &&
      trustClassification &&
      typeof trustClassification === 'object' &&
      typeof trustClassification.prTrust === 'string' &&
      trustClassification.prTrust &&
      executionRecord.prTrust !== trustClassification.prTrust
    ) {
      errors.push(
        `execution-record.json prTrust (${JSON.stringify(executionRecord.prTrust)}) does not match host trustClassification.prTrust (${JSON.stringify(trustClassification.prTrust)})`,
      );
    }
  }

  if (
    effectiveRequiredClass === 'hardware-isolated' &&
    files.boundary &&
    files.boundary.trim() !== ''
  ) {
    try {
      const b = JSON.parse(files.boundary);
      if (b && typeof b === 'object' && b.mode === 'container') {
        errors.push(
          'boundary.json mode container violates host context requirement executionClass=hardware-isolated',
        );
      }
    } catch {
      // Malformed boundary.json is reported by checkBoundary below.
    }
  }

  const boundaryAbsent =
    files.boundary === null ||
    files.boundary === undefined ||
    files.boundary.trim() === '';
  if (unreadableKeys.has('boundary')) {
    // The declaration itself is unreadable; already reported.
  } else if (publisherOwnsBoundary && boundaryAbsent && !executionRecord) {
    warnings.push(
      'boundary.json is absent on the CI entry path ($QWEN_VERIFY_CONTEXT): the publish job (CI lane) or the host check step (container recipe) writes the declaration before the verdict is trusted',
    );
  } else {
    // An unreadable gate record is reported separately, but it must not
    // suppress the declaration's own defects (R12 deferred). Its gate-missing
    // error would duplicate the unreadable report, so drop that one error.
    const gateUnreadable = unreadableKeys.has('boundaryGate');
    const boundaryErrors = checkBoundary(files.boundary, files.boundaryGate, {
      publishLane,
      coordinates,
      executionRecord,
      executionRecordSha256:
        executionRecordSha256 ?? actualExecutionRecordSha256,
    }).errors.filter(
      (error) =>
        !(gateUnreadable && error.startsWith('boundary-gate.json is missing')),
    );
    // The publisher owns the gate record too: on the CI entry path a
    // round-authored container declaration whose gate run has not happened
    // yet is the same expected gap as an absent declaration, not a refusal
    // the round can clear — the publish job writes its own ci-lane record.
    const gateAbsent =
      files.boundaryGate === null ||
      files.boundaryGate === undefined ||
      files.boundaryGate.trim() === '';
    for (const error of boundaryErrors) {
      if (
        publisherOwnsBoundary &&
        gateAbsent &&
        error.startsWith('boundary-gate.json is missing')
      ) {
        warnings.push(
          'boundary-gate.json is absent on the CI entry path ($QWEN_VERIFY_CONTEXT): the publish job writes its ci-lane record before it trusts the verdict',
        );
      } else {
        errors.push(error);
      }
    }
  }

  // The report's Boundary disclosure is compared against the recorded
  // mode when a usable declaration exists; on the CI entry path the
  // publish job writes it later, so there is nothing to compare yet.
  let boundaryMode = null;
  let boundaryBackend = null;
  if (files.boundary && files.boundary.trim() !== '') {
    try {
      const declared = JSON.parse(files.boundary);
      if (
        declared &&
        typeof declared === 'object' &&
        BOUNDARY_MODES.includes(declared.mode)
      ) {
        boundaryMode = declared.mode;
        boundaryBackend =
          typeof declared.backend === 'string' ? declared.backend : null;
      }
    } catch {
      // checkBoundary already reports the invalid JSON.
    }
  }

  const isHostBackedProviderVm =
    boundaryMode === 'vm' &&
    (boundaryBackend === 'provider-vm' ||
      executionRecord?.backend === 'provider-vm');

  // Disclose the coordinate-check downgrade: a waiver/vm whose approval
  // permalink was only shape-checked (no trusted repo/pr coordinates) must
  // not read as "the approval was compared against this PR".
  if (
    !publisherOwnsBoundary &&
    (boundaryMode === 'waived' ||
      (boundaryMode === 'vm' && !isHostBackedProviderVm)) &&
    !coordinates
  ) {
    warnings.push(
      "the waiver's approval target was not compared against this PR: no trusted repo/pr coordinates were available, so only the approval permalink's URL shape was checked",
    );
  }

  const effectiveHead =
    expectedHead ??
    (FULL_OID_RE.test(executionRecord?.headRefOid ?? '')
      ? executionRecord.headRefOid
      : null);

  if (files.report && files.report.trim() !== '') {
    const report = normalizeNewlines(files.report);
    const lead = report
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, 10);
    if (verdict && !lead.some((line) => line.includes(verdict))) {
      warnings.push(
        `report.md does not state "${verdict}" in its first 10 non-empty lines`,
      );
    }
    const cited = lead.join('\n').match(/\b[0-9a-f]{40}\b/g) ?? [];
    if (effectiveHead) {
      if (!cited.includes(effectiveHead)) {
        warnings.push(
          `report.md does not name the verified head ${effectiveHead} in its first 10 non-empty lines${cited.length > 0 ? ` (it cites ${cited.length} other OID${cited.length === 1 ? '' : 's'})` : ''}`,
        );
      }
    } else if (cited.length === 0) {
      warnings.push(
        'report.md does not name a 40-character head OID in its first 10 non-empty lines',
      );
    }
    warnings.push(...leadShapeWarnings(report, verdict, 'report.md'));
    warnings.push(...boundaryLineWarnings(report, 'report.md', boundaryMode));
  }

  // comment.md is the exact body a local round posts: report content plus
  // the attribution footer. report.md deliberately carries no footer (both
  // publish paths append it at comment time), so this is the only artifact
  // where the footer's presence is checkable. The workflow assembles its own
  // body and never writes this file, so its absence is not a defect.
  if (files.comment && files.comment.trim() !== '') {
    const comment = normalizeNewlines(files.comment);
    warnings.push(...leadShapeWarnings(comment, verdict, 'comment.md'));
    warnings.push(...boundaryLineWarnings(comment, 'comment.md', boundaryMode));
    const lines = comment.split('\n').filter((line) => line.trim() !== '');
    if (!FOOTER.test(lines[lines.length - 1] ?? '')) {
      warnings.push(
        'comment.md does not end with the attribution footer `_— <model> via Qwen Code /verify-pr (v<version>; skill <12-hex>)_`: append the resolved footer before posting — omit it only when the model cannot be resolved',
      );
    }
  }

  if (evidence.length === 0 && !evidenceUnreadable) {
    warnings.push(
      'evidence/ holds no PNG capture: a table is the claim, a capture is the witness',
    );
  }
  for (const name of evidence) {
    if (!KEBAB_PNG.test(name)) {
      warnings.push(
        `evidence/${name} is not a kebab-case caption; the filename becomes the published caption`,
      );
    }
  }

  return { errors, warnings, counts, verdict };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  let contextPath = null;
  let contextRoot = null;
  let contextSha = null;
  let executionRecordPath = null;
  let executionRecordSha = null;
  let publishLane = false;
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--context') {
      contextPath = argv[++index];
      if (!contextPath) {
        process.stderr.write(
          `verify-pr check: --context requires a snapshot path\n\n${HELP}`,
        );
        return 2;
      }
    } else if (arg === '--context-root') {
      contextRoot = argv[++index];
      if (!contextRoot) {
        process.stderr.write(
          `verify-pr check: --context-root requires a path\n\n${HELP}`,
        );
        return 2;
      }
    } else if (arg === '--context-sha256') {
      contextSha = argv[++index];
      if (!contextSha || !/^[0-9a-f]{64}$/.test(contextSha)) {
        process.stderr.write(
          `verify-pr check: --context-sha256 requires the 64-hex digest prepare printed\n\n${HELP}`,
        );
        return 2;
      }
    } else if (arg === '--execution-record') {
      executionRecordPath = argv[++index];
      if (!executionRecordPath) {
        process.stderr.write(
          `verify-pr check: --execution-record requires a host execution record path\n\n${HELP}`,
        );
        return 2;
      }
    } else if (arg === '--execution-record-sha256') {
      executionRecordSha = argv[++index];
      if (!executionRecordSha || !/^[0-9a-f]{64}$/.test(executionRecordSha)) {
        process.stderr.write(
          `verify-pr check: --execution-record-sha256 requires a 64-hex digest\n\n${HELP}`,
        );
        return 2;
      }
    } else if (arg === '--publish-lane') {
      // The CI publish job's flag: honors the ci-lane gate record the job
      // writes itself. An argv claim, not an authenticated identity — a
      // local shell passing it makes an operator claim, not proof.
      publishLane = true;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`verify-pr check: unknown option ${arg}\n\n${HELP}`);
      return 2;
    } else {
      positional.push(arg);
    }
  }
  if (contextSha && !contextPath) {
    process.stderr.write(
      `verify-pr check: --context-sha256 binds a --context snapshot; pass --context too\n\n${HELP}`,
    );
    return 2;
  }
  if (executionRecordSha && !executionRecordPath) {
    process.stderr.write(
      `verify-pr check: --execution-record-sha256 binds an --execution-record file; pass --execution-record too\n\n${HELP}`,
    );
    return 2;
  }
  const dir = positional[0];
  if (!dir || positional.length > 1) {
    process.stderr.write(
      `verify-pr check: exactly one artifact directory is required\n\n${HELP}`,
    );
    return 2;
  }
  if (!existsSync(dir)) {
    process.stderr.write(`verify-pr check: ${dir} does not exist\n`);
    return 1;
  }
  const dirTrimmed = /^[A-Za-z]:[\\/]+$/.test(dir)
    ? `${dir.slice(0, 2)}${sep}`
    : dir.length > 1 && !isFilesystemRoot(dir)
      ? dir.replace(/[\\/]+$/, '') || dir
      : dir;
  let canonicalDir;
  try {
    canonicalDir = realPath(dirTrimmed);
  } catch (error) {
    process.stderr.write(
      `verify-pr check: could not resolve artifact directory ${dir}: ${error.message}\n`,
    );
    return 1;
  }
  const dirPrNumber = /^pr(\d+)-verify-/.exec(
    normalizeFsPath(basename(canonicalDir)),
  )?.[1];

  // Walk the raw OS path once without lexically collapsing symlink/.. so we
  // observe: (1) whether any symlink along the path resolved directly to
  // canonicalDir (blocking <symlink>, <symlink>/., <symlink>/evidence/..), and
  // (2) every traversed "tmp" container (case-insensitive on darwin/win32)
  // whose subtree encloses canonicalDir or whose direct symlink child targets
  // canonicalDir.
  const inspectArtifactPath = () => {
    try {
      const roots = new Set([canonicalDir]);
      const canonicalParent = dirname(canonicalDir);
      const normCanonicalDir = normalizeFsPath(canonicalDir);
      const normCanonicalParent = normalizeFsPath(canonicalParent);
      const isTmpName = (p) => normalizeFsPath(basename(p)) === 'tmp';
      const isSystemTmpDir = (p) => {
        const norm = normalizeFsPath(p);
        if (
          norm === '/tmp' ||
          norm === '/private/tmp' ||
          norm === '/var/tmp' ||
          norm === '/private/var/tmp'
        ) {
          return true;
        }
        return isTmpName(p) && isFilesystemRoot(dirname(p));
      };
      let leafSymlink = false;
      let sawVerifyRoundSegment = Boolean(dirPrNumber);

      const splitSegments = (p) => {
        const parsed = parse(p);
        const rest = p.slice(parsed.root.length);
        return {
          root: parsed.root,
          parts: rest.split(/[\\/]+/).filter((part) => part !== ''),
        };
      };
      const rawSpec = isAbsolute(dirTrimmed)
        ? splitSegments(dirTrimmed)
        : (() => {
            const cwdSpec = splitSegments(process.cwd());
            const relParts = dirTrimmed
              .split(/[\\/]+/)
              .filter((part) => part !== '');
            return {
              root: cwdSpec.root,
              parts: [...cwdSpec.parts, ...relParts],
            };
          })();

      const queue = [...rawSpec.parts];
      let cur = rawSpec.root;
      let linkHops = 0;
      const anchorPaths = [];
      const matchesDirectSystemTmp = (resolved) => {
        const norm = normalizeFsPath(resolved);
        return norm === normCanonicalParent || norm === normCanonicalDir;
      };
      const encloseInnermostTmp = (startPath) => {
        let probe = startPath;
        while (probe && !isFilesystemRoot(probe)) {
          if (isTmpName(probe)) {
            let cloneReal;
            try {
              cloneReal = realPath(dirname(probe));
            } catch {
              return;
            }
            // Skip a "tmp" subdirectory that lives inside canonicalDir itself
            // (e.g. <round>/tmp/..), and continue climbing to the enclosing
            // clone's tmp container.
            if (withinRoot(canonicalDir, cloneReal)) {
              const next = dirname(probe);
              if (next === probe) break;
              probe = next;
              continue;
            }
            if (isSystemTmpDir(probe)) {
              let sysReal;
              try {
                sysReal = realPath(probe);
              } catch {
                return;
              }
              if (matchesDirectSystemTmp(sysReal)) {
                roots.add(parse(sysReal).root);
                roots.add(sysReal);
              }
              return;
            }
            // Non-system "tmp" container (e.g. <clone>/tmp): always enclose its
            // parent clone root (<clone>), even if <clone>/tmp is a symlink to
            // /tmp, /var/tmp, or inside canonicalDir.
            roots.add(cloneReal);
            try {
              const tmpReal = realPath(probe);
              if (!isSystemTmpDir(tmpReal)) {
                roots.add(tmpReal);
              } else if (matchesDirectSystemTmp(tmpReal)) {
                roots.add(parse(tmpReal).root);
                roots.add(tmpReal);
              }
            } catch {
              // Unresolvable symlink target still keeps cloneReal enclosed.
            }
            return;
          }
          const next = dirname(probe);
          if (next === probe) break;
          probe = next;
        }
      };

      while (queue.length > 0) {
        const part = queue.shift();
        if (part === '.') continue;
        if (part === '..') {
          if (isTmpName(cur)) anchorPaths.push(cur);
          cur = dirname(cur);
        } else {
          cur = /[\\/]$/.test(cur) ? `${cur}${part}` : `${cur}${sep}${part}`;
        }
        if (/^pr(\d+)-verify-/.test(normalizeFsPath(basename(cur)))) {
          sawVerifyRoundSegment = true;
        }
        const st = lstatSync(cur);
        if (st.isSymbolicLink()) {
          linkHops += 1;
          if (linkHops > 40) {
            return {
              error: `could not resolve artifact directory ${dir}: too many symlink hops`,
            };
          }
          // Anchor the current path domain at the symlink itself before
          // crossing it; looking up the innermost tmp ancestor from `cur`
          // avoids dead-end decoy/tmp/.. pollution.
          anchorPaths.push(cur);
          try {
            const linkTargetReal = realPath(cur);
            if (withinRoot(canonicalDir, linkTargetReal)) {
              leafSymlink = true;
            }
          } catch {
            // Broken intermediate link will fail below when traversed.
          }
          const target = readlinkSync(cur);
          if (isAbsolute(target)) {
            const targetSpec = splitSegments(target);
            cur = targetSpec.root;
            queue.unshift(...targetSpec.parts);
          } else {
            cur = dirname(cur);
            const relTarget = target.split(/[\\/]+/).filter((p) => p !== '');
            queue.unshift(...relTarget);
          }
        }
      }

      if (sawVerifyRoundSegment) {
        encloseInnermostTmp(canonicalDir);
        for (const anchor of anchorPaths) {
          encloseInnermostTmp(anchor);
        }
      }
      return { roots: [...roots], leafSymlink };
    } catch (error) {
      return {
        error: `could not resolve artifact directory ${dir}: ${error.message}`,
      };
    }
  };
  const pathInfo = inspectArtifactPath();
  // A --context-root must resolve to a directory containing the artifact
  // dir; a root no path can be inside would disable the refusal entirely
  // (R15 R14-1). Validate it whenever supplied, not only with --context.
  if (contextRoot) {
    let realRoot;
    try {
      realRoot = realPath(contextRoot);
    } catch {
      process.stderr.write(
        `verify-pr check: --context-root ${contextRoot} must resolve to a directory\n\n${HELP}`,
      );
      return 2;
    }
    // A root of '/' contains every path, so it cannot discriminate the
    // PR-writable tree; it is a usage error, not a trust root (R2-2). Reject
    // it here even without --context, where the in-context refusal below is
    // never reached.
    if (isFilesystemRoot(realRoot)) {
      process.stderr.write(
        `verify-pr check: --context-root ${contextRoot} is a filesystem root, which cannot discriminate the PR-writable tree — pass the PR clone path\n\n${HELP}`,
      );
      return 2;
    }
    if (!withinRoot(realRoot, canonicalDir)) {
      process.stderr.write(
        `verify-pr check: --context-root ${contextRoot} does not contain the artifact directory ${dir}\n\n${HELP}`,
      );
      return 2;
    }
  }

  // Read every artifact from canonicalDir (OS-resolved realpath) rather than
  // lexically-collapsed path.join(dir, ...) so symlink/.. paths never split
  // trust-root derivation from artifact reads.
  const files = {
    report: readIfExists(join(canonicalDir, 'report.md')),
    verdict: readIfExists(join(canonicalDir, 'verdict.txt')),
    assertions: readIfExists(join(canonicalDir, 'assertions.json')),
    mutations: readIfExists(join(canonicalDir, 'mutations.json')),
    comment: readIfExists(join(canonicalDir, 'comment.md')),
    boundary: readIfExists(join(canonicalDir, 'boundary.json')),
    boundaryGate: readIfExists(join(canonicalDir, 'boundary-gate.json')),
  };
  // An unreadable artifact is a refusal, not an absent one: a damaged
  // mutations.json must not silently drop its coverage check.
  const ARTIFACT_NAMES = {
    report: 'report.md',
    verdict: 'verdict.txt',
    assertions: 'assertions.json',
    mutations: 'mutations.json',
    comment: 'comment.md',
    boundary: 'boundary.json',
    boundaryGate: 'boundary-gate.json',
  };
  const unreadableErrors = [];
  const unreadableKeys = new Set();
  for (const [key, name] of Object.entries(ARTIFACT_NAMES)) {
    if (files[key] === UNREADABLE) {
      unreadableErrors.push(
        `${name} is unreadable (a directory, non-regular file, or permission-denied file is not an absent artifact)`,
      );
      // Keep the key out of the "is missing" branch downstream: the file is
      // present but unreadable, and telling the author to write a file that
      // is already there conflates the two cases the sentinel separates.
      unreadableKeys.add(key);
      files[key] = null;
    }
  }
  const evidenceDir = join(canonicalDir, 'evidence');
  let evidence = [];
  let evidenceUnreadable = false;
  if (existsSync(evidenceDir)) {
    // A PR-writable path named evidence may be a regular file or
    // unreadable: that is a refusal like the other artifacts, not a
    // crash out of the CLI.
    try {
      evidence = readdirSync(evidenceDir).filter((name) =>
        name.toLowerCase().endsWith('.png'),
      );
    } catch {
      evidenceUnreadable = true;
      unreadableErrors.push(
        'evidence/ is unreadable (a directory, non-regular file, or permission-denied file is not an absent artifact)',
      );
    }
  }

  // With the round's own snapshot, the report
  // has to cite the head it verified — not merely some 40-hex token, which a
  // base OID satisfies. A snapshot that exists but cannot be read is reported
  // rather than silently downgrading the check.
  let expectedHead = null;
  let snapshotWarning = null;
  let snapshotPath = null;
  // The waiver's approval permalink is checked against the round's
  // coordinates ONLY when they come from the host-held --context snapshot:
  // the artifact directory is writable by the PR code the round executed,
  // so its own context.json must not supply the coordinates that judge its
  // waiver. Without a trusted snapshot only the URL shape is checkable.
  const coordinatesFrom = (snapshot) => {
    const repoMatch =
      typeof snapshot?.repo === 'string'
        ? /^([\w.-]+)\/([\w.-]+)$/.exec(snapshot.repo)
        : null;
    const pr =
      Number.isInteger(snapshot?.pr) && snapshot.pr > 0 ? snapshot.pr : null;
    // The number must come from the trusted snapshot, never the artifact
    // directory's basename: the round controls that name, so a fallback to
    // it would let the round satisfy "this PR" by naming its directory after
    // the PR whose comment it cites.
    const number =
      pr ??
      (Number.isInteger(snapshot?.number) && snapshot.number > 0
        ? snapshot.number
        : null);
    return repoMatch && number
      ? { owner: repoMatch[1], repo: repoMatch[2], number }
      : null;
  };
  const deriveTrustRoots = () => {
    if (contextRoot) {
      try {
        return { roots: [realPath(contextRoot)] };
      } catch (error) {
        return {
          error: `could not resolve --context-root ${contextRoot}: ${error.message}`,
        };
      }
    }
    if (pathInfo.error) return { error: pathInfo.error };
    return { roots: pathInfo.roots };
  };
  let coordinates = null;
  let trustedSnapshot = null;
  let contextDigestVerified = false;
  let expectedBase = null;
  let hostContextSha256 = null;
  let requiredExecutionClass = null;
  let trustClassification = undefined;
  if (contextPath) {
    // A host-held snapshot: the PR clone is mounted read-write, so the round
    // can write ANY path inside it — the artifact dir AND the
    // tmp/verify-context sibling prepare prints. Refuse a --context whose
    // REAL path lands anywhere in the clone's worktree (a lexical prefix of
    // the round dir misses both a symlink and the sibling), and read through
    // the same lstat guard so a FIFO/symlink refuses instead of hanging or
    // being followed (R12-1).
    let realContext;
    try {
      realContext = realPath(contextPath);
    } catch {
      realContext = resolve(contextPath);
    }
    // The trust root must come from the HOST, never from git state inside
    // the PR-writable tree: the round controls that state (it can `git init`
    // the artifact dir or damage .git), so deriving the root from it lets
    // the round judge its own waiver (R14-1). The host passes the PR clone
    // path via --context-root, which must resolve to a directory containing
    // the artifact dir (a root no path can be inside would disable the
    // refusal). Without the flag, fall back to a root derived from the
    // artifact dir's own path — which prepare (host-side) fixed, not the
    // round: a pr<n>-verify-<ts> dir under tmp/ lives in the read-write clone,
    // so the writable root is the CLONE root (the tmp container's parent),
    // covering a snapshot planted anywhere in the clone, not just under tmp/
    // (R15 R14-1); a plain fixture dir is its own root. Both sides are
    // real-path resolved so a symlinked dir (macOS TMPDIR) compares
    // consistently.
    // --context-root was validated above (contains the artifact dir). The
    // fallback root is the clone root for a pr<n>-verify-<ts> dir under tmp/
    // (the tmp container's parent), or the dir itself for a plain fixture.
    const derivedRoots = deriveTrustRoots();
    if (derivedRoots.error) {
      process.stderr.write(`verify-pr check: ${derivedRoots.error}\n`);
      return 1;
    }
    const matchedRoot =
      derivedRoots.roots.find((root) => isFilesystemRoot(root)) ??
      derivedRoots.roots.find((root) => withinRoot(root, realContext)) ??
      null;
    const insideByPath = matchedRoot !== null;
    // A hard link gives a PR-writable file a second name outside the trust
    // root; realpath cannot see the source name, but a freshly written host
    // copy has exactly one link, so a link count above one means the context
    // shares an inode with another name the round may control (R17-1). This
    // needs no walk of the PR-writable tree, so an unreadable subdirectory or
    // a source outside the artifact dir cannot hide the alias (R1-1, R1-2).
    // Only check when the path test did not already refuse.
    let contextIsAlias = false;
    let contextLinks = 0;
    if (!insideByPath) {
      try {
        const ctxStat = statSync(realContext);
        if (ctxStat.isFile()) {
          contextLinks = ctxStat.nlink;
          contextIsAlias = ctxStat.nlink !== 1;
        }
      } catch {
        // A missing/unreadable context is reported by the head-OID check below.
      }
    }
    if (insideByPath || contextIsAlias) {
      // One sentence per cause: for an alias or a '/' trust root the path is
      // demonstrably outside the worktree, so the path-inside wording would
      // be false and its remedy unreachable (R1-4).
      let reason;
      if (contextIsAlias) {
        reason = `--context ${contextPath} is a hard link (${contextLinks} names) to a file the round can write; copy it instead of linking it, so the coordinates judging the waiver come from a host-held copy the round never saw`;
      } else if (isFilesystemRoot(matchedRoot)) {
        // Only the derived root reaches here: an explicit filesystem-root
        // --context-root is already a usage error at the containment gate
        // (R2-2). The artifact dir sits directly under root-level tmp/ and no
        // PR clone can contain it, so the remedy is to move it, not to pass
        // --context-root (which would only trade this refusal for a containment
        // error, R1-4).
        reason = `--context ${contextPath} cannot be trusted: the artifact dir sits directly under a root-level tmp/, so the derived trust root is '${matchedRoot}', which contains every path — move the artifact dir out of root-level tmp/ (no PR clone can contain it)`;
      } else {
        reason = `--context must not point inside the PR-writable worktree (${contextPath}): it cannot judge its own waiver — pass a host-held copy the round never saw`;
      }
      process.stderr.write(`verify-pr check: ${reason}\n`);
      return 1;
    }
    const snapshotText = readIfExists(contextPath);
    // Content binding (R2-1): the digest prepare computed host-side is the
    // provenance proof. A path outside the root and a single link can both be
    // arranged by the round, but the bytes prepare wrote cannot be forged
    // without matching this digest. Refuse on mismatch or an unverifiable read.
    if (contextSha) {
      if (snapshotText === null || snapshotText === UNREADABLE) {
        process.stderr.write(
          `verify-pr check: --context ${contextPath} is missing or unreadable; cannot verify it against --context-sha256\n`,
        );
        return 1;
      }
      const actualSha = createHash('sha256')
        .update(snapshotText, 'utf8')
        .digest('hex');
      if (actualSha !== contextSha) {
        process.stderr.write(
          `verify-pr check: --context ${contextPath} does not match --context-sha256 (the snapshot prepare wrote); it was modified or is not the host-held copy — re-copy it from the prepare context\n`,
        );
        return 1;
      }
      contextDigestVerified = true;
    } else {
      // Disclose that provenance was never bound, rather than letting a clean
      // path/link check read as proof the host wrote the snapshot (deferred).
      snapshotWarning = `--context ${contextPath} has no --context-sha256 binding; provenance rests on the path/link checks alone — pass the digest prepare printed to bind the snapshot's bytes`;
    }
    if (snapshotText !== null && snapshotText !== UNREADABLE) {
      hostContextSha256 = createHash('sha256')
        .update(snapshotText, 'utf8')
        .digest('hex');
      try {
        const snapshot = JSON.parse(snapshotText);
        if (/^[0-9a-f]{40}$/.test(snapshot?.baseRefOid ?? '')) {
          expectedBase = snapshot.baseRefOid;
        }
        if (/^[0-9a-f]{40}$/.test(snapshot?.headRefOid ?? '')) {
          expectedHead = snapshot.headRefOid;
          snapshotPath = contextPath;
        }
        trustedSnapshot = snapshot;
        coordinates = coordinatesFrom(snapshot);
        const tc = snapshot?.trustClassification;
        if (tc !== undefined) {
          trustClassification = tc;
          const tcCheck = checkTrustClassification(tc, expectedHead);
          if (tcCheck.errors.length > 0) {
            process.stderr.write(
              `verify-pr check: --context ${contextPath} has invalid trustClassification: ${tcCheck.errors.join('; ')}\n`,
            );
            return 1;
          }
          requiredExecutionClass = tcCheck.requiredExecutionClass;
        }
      } catch {
        // Reported below; never falls back to the writable artifact copy.
      }
    }
    if (!expectedHead) {
      process.stderr.write(
        `verify-pr check: --context ${contextPath} is missing, unreadable, or carries no valid head OID\n`,
      );
      return 1;
    }
  } else {
    // The eighth read from the PR-writable directory gets the same lstat
    // guard as the other seven: a planted FIFO at context.json must refuse
    // with a warning, not block open(2) forever (R11-3).
    snapshotPath = join(canonicalDir, 'context.json');
    let snapshotText = readIfExists(snapshotPath);
    if (snapshotText === null && dirPrNumber) {
      snapshotPath = join(
        dirname(canonicalDir),
        'verify-context',
        `pr${dirPrNumber}.json`,
      );
      snapshotText = readIfExists(snapshotPath);
    }
    if (snapshotText === UNREADABLE) {
      snapshotWarning = `snapshot ${snapshotPath} is unreadable; the head-OID check fell back to presence-only`;
    } else if (snapshotText !== null) {
      try {
        const snapshot = JSON.parse(snapshotText);
        if (/^[0-9a-f]{40}$/.test(snapshot?.headRefOid ?? '')) {
          expectedHead = snapshot.headRefOid;
        } else {
          snapshotWarning = `snapshot ${snapshotPath} has no valid head OID; the head-OID check fell back to presence-only`;
        }
        // No coordinates from the artifact's own context.json: it is
        // PR-writable, so it cannot be the input that judges the waiver.
      } catch {
        snapshotWarning = `snapshot ${snapshotPath} is unreadable; the head-OID check fell back to presence-only`;
      }
    }
  }

  let executionRecordText = null;
  let executionRecordWarning = null;
  if (executionRecordPath) {
    let realExecRecord;
    try {
      realExecRecord = realPath(executionRecordPath);
    } catch {
      realExecRecord = resolve(executionRecordPath);
    }
    const execDerivedRoots = deriveTrustRoots();
    if (execDerivedRoots.error) {
      process.stderr.write(`verify-pr check: ${execDerivedRoots.error}\n`);
      return 1;
    }
    const execMatchedRoot =
      execDerivedRoots.roots.find((root) => isFilesystemRoot(root)) ??
      execDerivedRoots.roots.find((root) => withinRoot(root, realExecRecord)) ??
      null;
    const execInsideByPath = execMatchedRoot !== null;
    let execIsAlias = false;
    let execLinks = 0;
    if (!execInsideByPath) {
      try {
        const execStat = statSync(realExecRecord);
        if (execStat.isFile()) {
          execLinks = execStat.nlink;
          execIsAlias = execStat.nlink !== 1;
        }
      } catch {
        // Missing/unreadable record is refused below.
      }
    }
    if (execInsideByPath || execIsAlias) {
      let reason;
      if (execIsAlias) {
        reason = `--execution-record ${executionRecordPath} is a hard link (${execLinks} names); copy it into launcher-owned storage instead of linking it`;
      } else if (isFilesystemRoot(execMatchedRoot)) {
        reason = `--execution-record ${executionRecordPath} cannot be trusted under root-level trust root '${execMatchedRoot}'`;
      } else {
        reason = `--execution-record must not point inside the PR-writable worktree (${executionRecordPath}): pass a host-held launcher record outside the artifact tree`;
      }
      process.stderr.write(`verify-pr check: ${reason}\n`);
      return 1;
    }
    const rawExec = readIfExists(executionRecordPath);
    if (rawExec === null || rawExec === UNREADABLE) {
      process.stderr.write(
        `verify-pr check: --execution-record ${executionRecordPath} is missing or unreadable (symlinks, directories, FIFOs, and oversized files are refused)\n`,
      );
      return 1;
    }
    if (executionRecordSha) {
      const actualExecSha = createHash('sha256')
        .update(rawExec, 'utf8')
        .digest('hex');
      if (actualExecSha !== executionRecordSha) {
        process.stderr.write(
          `verify-pr check: --execution-record ${executionRecordPath} does not match --execution-record-sha256\n`,
        );
        return 1;
      }
    } else {
      executionRecordWarning = `--execution-record ${executionRecordPath} has no --execution-record-sha256 binding; pass the host digest to bind its bytes`;
    }
    executionRecordText = rawExec;
  }

  // Refuse a guest-planted execution-record.json inside the PR-writable artifact dir (D5/D9).
  // Only ENOENT confirms absence; EACCES/ENOTDIR must fail closed.
  const plantedExecRecordPath = join(canonicalDir, 'execution-record.json');
  try {
    lstatSync(plantedExecRecordPath);
    unreadableErrors.push(
      'execution-record.json must not reside inside the PR-writable artifact directory: pass the host-held record via --execution-record',
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      unreadableErrors.push(
        `could not verify absence of planted execution-record.json (${error?.code ?? 'error'})`,
      );
    }
  }

  // The CI entry path is defined by $QWEN_VERIFY_CONTEXT; there the publish
  // job owns the declaration, so an absent boundary.json is a warning for
  // the round's own pre-finish self-check, not an error it cannot clear.
  const publisherOwnsBoundary = !!process.env.QWEN_VERIFY_CONTEXT;
  const result = checkArtifacts({
    files,
    evidence,
    expectedBase,
    expectedHead,
    publisherOwnsBoundary,
    publishLane,
    coordinates,
    evidenceUnreadable,
    unreadableKeys,
    executionRecordText,
    executionRecordSha256: executionRecordSha,
    expectedContextSha256: contextSha ?? hostContextSha256,
    requiredExecutionClass,
    trustClassification,
  });
  let executionMode = null;
  try {
    const parsedBoundary = JSON.parse(files.boundary ?? '');
    if (
      parsedBoundary?.mode === 'waived' ||
      (parsedBoundary?.mode === 'vm' &&
        parsedBoundary?.backend !== 'provider-vm')
    ) {
      executionMode = parsedBoundary.mode;
    }
  } catch {
    // The artifact-shape check reports malformed declarations.
  }
  if (contextPath && executionMode && !coordinates) {
    result.errors.push(
      `boundary.json mode ${executionMode} needs trusted repo and positive PR coordinates in --context (a valid owner/repo slug and pr/number); neither the artifact basename nor artifact context.json can supply missing identity`,
    );
  }
  if (contextPath && coordinates) {
    const preflightBound = trustedSnapshot?.executionApproval !== undefined;
    if (preflightBound) {
      const artifactContextText = readIfExists(
        join(canonicalDir, 'context.json'),
      );
      let artifactCoordinates = null;
      if (artifactContextText !== null && artifactContextText !== UNREADABLE) {
        try {
          const artifactSnapshot = JSON.parse(artifactContextText);
          artifactCoordinates = coordinatesFrom({
            repo: artifactSnapshot?.repo,
            pr: artifactSnapshot?.pr,
          });
        } catch {
          // An unusable artifact-only context supplies no trusted coordinates.
        }
      }
      if (!artifactCoordinates) {
        result.errors.push(
          'artifact context.json must provide the same repo and PR coordinates as the host-held execution approval; a missing, unreadable, malformed, or coordinate-free artifact context cannot witness the PR round',
        );
      } else if (
        artifactCoordinates.owner.toLowerCase() !==
          coordinates.owner.toLowerCase() ||
        artifactCoordinates.repo.toLowerCase() !==
          coordinates.repo.toLowerCase() ||
        artifactCoordinates.number !== coordinates.number
      ) {
        result.errors.push(
          `artifact context.json identifies another repository or PR (${artifactCoordinates.owner}/${artifactCoordinates.repo}#${artifactCoordinates.number}), which conflicts with the trusted host snapshot for ${coordinates.owner}/${coordinates.repo}#${coordinates.number}; the artifact context is only a consistency witness, not an independent source of approval`,
        );
      }
    }
    let realArtifactDirectory = false;
    try {
      const rootStat = lstatSync(dirTrimmed);
      realArtifactDirectory =
        !pathInfo.error &&
        !pathInfo.leafSymlink &&
        rootStat.isDirectory() &&
        !rootStat.isSymbolicLink();
    } catch {
      // The real-directory refusal below also covers an unreadable root.
    }
    if (!realArtifactDirectory) {
      result.errors.push(
        `artifact directory ${dir} must be a real directory, not a symbolic link or other non-directory, when --context supplies trusted PR coordinates; pass the resolved artifact directory path`,
      );
    } else if (preflightBound && !dirPrNumber) {
      result.errors.push(
        `artifact directory ${basename(canonicalDir)} does not name a PR in prepare's pr<N>-verify-* form; a host-held execution approval cannot be assigned to an unrelated round directory`,
      );
    } else if (dirPrNumber && Number(dirPrNumber) !== coordinates.number) {
      result.errors.push(
        `artifact directory ${basename(canonicalDir)} names PR ${dirPrNumber}, but the trusted host snapshot is for ${coordinates.owner}/${coordinates.repo}#${coordinates.number}; a host-held approval cannot be replayed into another PR's round directory`,
      );
    }
  }
  result.errors.push(
    ...executionApprovalErrors(files.boundary, trustedSnapshot, {
      contextProvided: !!contextPath,
      contextDigestVerified,
      boundaryUnreadable: unreadableKeys.has('boundary'),
    }),
  );
  // The container nonce corroboration (R16-1) needs the round dir to scan the
  // battery's logs, so it lives here rather than in checkArtifacts. It runs
  // UNCONDITIONALLY: the exemption is the RECORD, not a flag — containerNonceErrors
  // returns [] for the ci-lane record the publish job writes and for non-container
  // modes, so neither the --publish-lane flag (R1-7) nor $QWEN_VERIFY_CONTEXT
  // (R2-7) can switch the binding off for a require-isolation container claim.
  // publisherOwnsBoundary still governs the absent-declaration tolerance in
  // checkArtifacts; it does not exempt the nonce binding.
  result.errors.push(
    ...containerNonceErrors(files.boundary, files.boundaryGate, canonicalDir),
  );
  result.errors.unshift(...unreadableErrors);
  if (executionRecordWarning) result.warnings.unshift(executionRecordWarning);
  if (snapshotWarning) result.warnings.unshift(snapshotWarning);
  const lines = [`verify-pr check: ${dir}`];
  if (expectedHead) lines.push(`  head source: ${snapshotPath}`);
  for (const warning of result.warnings) lines.push(`  warn  ${warning}`);
  for (const error of result.errors) lines.push(`  error ${error}`);
  const counts = result.counts
    ? `${result.counts.pass} passed · ${result.counts.fail} failed · ${result.counts.total} total`
    : 'no usable assertion counts';
  lines.push(
    `  ${result.errors.length === 0 ? 'ok' : 'failed'}: verdict=${result.verdict ?? 'none'} (${counts})`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  return result.errors.length === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
