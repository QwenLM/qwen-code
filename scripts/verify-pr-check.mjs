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

const KEBAB_PNG = /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;

const HELP = `Usage: node scripts/verify-pr-check.mjs <artifact-dir>

Checks a local round against the rules the CI publisher enforces:

  - report.md, verdict.txt and assertions.json exist and carry content
  - verdict.txt is exactly one of merge-ready | findings | blocked | inconclusive
  - assertions.json holds non-negative integers, a positive total, and
    total == pass + fail
  - a merge-ready verdict carries no failed assertion

and warns (without failing) when the report does not lead with its verdict and
head OID, or when evidence/ carries no kebab-case PNG capture.

Exit codes: 0 no errors, 1 errors found, 2 usage.
`;

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
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
      }
    }
  }

  if (verdict === 'merge-ready' && counts && counts.fail > 0) {
    errors.push(
      `merge-ready with ${counts.fail} failed assertion${counts.fail === 1 ? '' : 's'}: expected A/B control reds count as passes, so a real fail contradicts the verdict`,
    );
  }

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
  };
  const evidenceDir = join(dir, 'evidence');
  const evidence = existsSync(evidenceDir)
    ? readdirSync(evidenceDir).filter((name) =>
        name.toLowerCase().endsWith('.png'),
      )
    : [];

  // When the round's own snapshot is beside the artifact directory, the report
  // has to cite the head it verified — not merely some 40-hex token, which a
  // base OID satisfies. A snapshot that exists but cannot be read is reported
  // rather than silently downgrading the check.
  let expectedHead = null;
  let snapshotWarning = null;
  const prNumber = /^pr(\d+)-verify-/.exec(basename(resolve(dir)))?.[1];
  if (prNumber) {
    const snapshotPath = join(
      dirname(resolve(dir)),
      'verify-context',
      `pr${prNumber}.json`,
    );
    if (existsSync(snapshotPath)) {
      try {
        const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
        if (/^[0-9a-f]{40}$/.test(snapshot?.headRefOid ?? '')) {
          expectedHead = snapshot.headRefOid;
        }
      } catch {
        snapshotWarning =
          'the verify-context snapshot is unreadable; the head-OID check fell back to presence-only';
      }
    }
  }

  const result = checkArtifacts({ files, evidence, expectedHead });
  if (snapshotWarning) result.warnings.unshift(snapshotWarning);
  const lines = [`verify-pr check: ${dir}`];
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
