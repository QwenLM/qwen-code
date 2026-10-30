#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Applies the publisher's consistency rules to a local `/verify-pr` round.
 *
 * In CI the publish job refuses an artifact whose verdict contradicts its own
 * assertion counts, so a `merge-ready` report carrying `fail: 7` degrades to
 * "no usable structured verdict". A local round has no publisher: the skill
 * asks the maintainer to "keep the counts honest yourself", which is the one
 * step of that path a machine should own.
 *
 * Usage:
 *   node scripts/verify-pr-check.mjs <artifact-dir>
 *
 * Exit codes: 0 when no error was found (warnings may still print), 1 on any
 * error, 2 on a usage error.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

export const VERDICTS = ['merge-ready', 'findings', 'blocked', 'inconclusive'];

/**
 * Who caused a failed assertion. `pr` is the only one that can stamp a defect
 * on the PR: an `environment` red belongs in an expected-red assertion once an
 * A/A control proves both arms fail, and a `harness` fault is `inconclusive`.
 */
export const ATTRIBUTIONS = ['pr', 'harness', 'environment'];

const KEBAB_PNG = /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;
const OID = /^[0-9a-f]{7,40}$/;

const HELP = `Usage: node scripts/verify-pr-check.mjs <artifact-dir>

Checks a local round against the rules the CI publisher enforces:

  - report.md, verdict.txt and assertions.json exist and carry content
  - verdict.txt is exactly one of merge-ready | findings | blocked | inconclusive
  - assertions.json holds non-negative integers, a positive total, and
    total == pass + fail
  - a merge-ready verdict carries no failed assertion
  - a findings/blocked verdict whose failures ledger attributes no failure to
    the PR is a contradiction: expected reds are passes
  - a mutations.json claiming per-commit coverage covers every commit it lists,
    and lists at least one commit (an empty set makes the claim vacuous)

and warns (without failing) when the report does not lead with its verdict and
head OID, when evidence/ carries no kebab-case PNG capture, or when a round with
failures carries no failures ledger at all.

Exit codes: 0 no errors, 1 errors found, 2 usage.
`;

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
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
 * Pure check over already-read artifacts. `files` carries raw text or null;
 * `evidence` is the PNG file names under evidence/.
 */
export function checkArtifacts({ files, evidence = [], expectedHead = null }) {
  const errors = [];
  const warnings = [];

  for (const name of ['report.md', 'verdict.txt', 'assertions.json']) {
    const key = name.split('.')[0];
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

  if (files.report && files.report.trim() !== '') {
    const lead = files.report
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, 10);
    if (verdict && !lead.some((line) => line.includes(verdict))) {
      warnings.push(
        `report.md does not state "${verdict}" in its first 10 non-empty lines`,
      );
    }
    const cited = lead.join('\n').match(/\b[0-9a-f]{40}\b/g) ?? [];
    if (expectedHead) {
      if (!cited.includes(expectedHead)) {
        warnings.push(
          `report.md does not name the verified head ${expectedHead} in its first 10 non-empty lines${cited.length > 0 ? ` (it cites ${cited.length} other OID${cited.length === 1 ? '' : 's'})` : ''}`,
        );
      }
    } else if (cited.length === 0) {
      warnings.push(
        'report.md does not name a 40-character head OID in its first 10 non-empty lines',
      );
    }
  }

  if (evidence.length === 0) {
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
  const dir = argv.find((arg) => !arg.startsWith('-'));
  if (!dir) {
    process.stderr.write(
      `verify-pr check: an artifact directory is required\n\n${HELP}`,
    );
    return 2;
  }
  if (!existsSync(dir)) {
    process.stderr.write(`verify-pr check: ${dir} does not exist\n`);
    return 1;
  }

  const files = {
    report: readIfExists(join(dir, 'report.md')),
    verdict: readIfExists(join(dir, 'verdict.txt')),
    assertions: readIfExists(join(dir, 'assertions.json')),
    mutations: readIfExists(join(dir, 'mutations.json')),
  };
  const evidenceDir = join(dir, 'evidence');
  const evidence = existsSync(evidenceDir)
    ? readdirSync(evidenceDir).filter((name) =>
        name.toLowerCase().endsWith('.png'),
      )
    : [];

  // With the round's own snapshot, the report
  // has to cite the head it verified — not merely some 40-hex token, which a
  // base OID satisfies. A snapshot that exists but cannot be read is reported
  // rather than silently downgrading the check.
  let expectedHead = null;
  let snapshotWarning = null;
  let snapshotPath = join(dir, 'context.json');
  const prNumber = /^pr(\d+)-verify-/.exec(basename(resolve(dir)))?.[1];
  if (!existsSync(snapshotPath) && prNumber) {
    snapshotPath = join(
      dirname(resolve(dir)),
      'verify-context',
      `pr${prNumber}.json`,
    );
  }
  if (existsSync(snapshotPath)) {
    try {
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      if (/^[0-9a-f]{40}$/.test(snapshot?.headRefOid ?? '')) {
        expectedHead = snapshot.headRefOid;
      } else {
        snapshotWarning = `snapshot ${snapshotPath} has no valid head OID; the head-OID check fell back to presence-only`;
      }
    } catch {
      snapshotWarning = `snapshot ${snapshotPath} is unreadable; the head-OID check fell back to presence-only`;
    }
  }

  const result = checkArtifacts({ files, evidence, expectedHead });
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
