/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, type Finding } from './findings.js';
import { saveReviewArtifact } from './save-artifact.js';

// On a case-sensitive filesystem the alias below never exists, so that test
// can only run where the filesystem folds case. Probe once, at load time, so
// the skip is visible in CI output instead of reading as a pass.
const caseInsensitiveFs = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'review-artifact-case-probe-'));
  try {
    writeFileSync(join(dir, 'case-probe'), '');
    return existsSync(join(dir, 'CASE-PROBE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;
let previousProjectDir: string | undefined;

const finding: Finding = {
  id: 'R1-1',
  severity: 'Critical',
  confidence: 'high',
  source: 'test',
  summary: 'The result is lost.',
  shortSummary: 'The result is lost.',
  failureScenario: 'Saving after cleanup loses the result.',
  suggestedFix: 'Save before cleanup.',
  category: 'correctness',
  locations: [{ file: 'src/review.ts', line: 12, anchor: 'save();' }],
  assetFiles: ['evidence/local.png'],
  assets: ['https://example.com/evidence.png'],
  outcome: 'fixed',
  outcomeNote: 'Saved atomically.',
  heldByMeasurement: { file: 'src/review.test.ts' },
};

const verdict = {
  event: 'REQUEST_CHANGES',
  body: 'One blocker remains.',
  baseEvent: 'REQUEST_CHANGES',
  cappedBy: ['coverage gap'],
  downgraded: true,
  downgradedFrom: 'Request changes',
  remediation: ['Run verification again.'],
  lowSignal: { agents: 4, srcDiffLines: 120 },
  verdictLine: 'Verdict: Comment — Request changes was downgraded',
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture() {
  const findings = join(root, '.qwen/tmp/findings.json');
  const composed = join(root, '.qwen/tmp/composed.json');
  const report = join(root, '.qwen/reviews/review.md');
  const out = join(root, '.qwen/reviews/review.json');
  writeJson(findings, buildReport([finding]));
  writeJson(composed, verdict);
  mkdirSync(join(root, '.qwen/reviews'), { recursive: true });
  writeFileSync(report, '# Review\n');
  return { findings, composed, report, out };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-artifact-'));
  previousProjectDir = process.env['QWEN_CODE_PROJECT_DIR'];
  process.env['QWEN_CODE_PROJECT_DIR'] = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousProjectDir === undefined) {
    delete process.env['QWEN_CODE_PROJECT_DIR'];
  } else {
    process.env['QWEN_CODE_PROJECT_DIR'] = previousProjectDir;
  }
});

describe('saveReviewArtifact', () => {
  it('copies canonical findings and the composed verdict into schema v1', () => {
    const paths = fixture();
    saveReviewArtifact({
      ...paths,
      target: 'pr-123',
      effort: 'high',
    });

    const document = JSON.parse(readFileSync(paths.out, 'utf8'));
    expect(document).toEqual({
      schemaVersion: 1,
      target: 'pr-123',
      effort: 'high',
      verdict,
      ...buildReport([finding]),
      markdownReportPath: '.qwen/reviews/review.md',
    });
    expect(readFileSync(paths.out, 'utf8')).toMatch(/\n$/);
    expect(
      readdirSync(join(root, '.qwen/reviews')).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });

  it('reads PR inputs from its worktree and writes durable output to the main project', () => {
    const paths = fixture();
    const worktree = join(root, '.qwen/tmp/review-pr-123');
    const findings = join(worktree, '.qwen/tmp/findings.json');
    const composed = join(worktree, '.qwen/tmp/composed.json');
    writeJson(findings, buildReport([finding]));
    writeJson(composed, verdict);

    saveReviewArtifact({
      ...paths,
      findings,
      composed,
      target: 'pr-123',
      effort: 'high',
    });

    expect(JSON.parse(readFileSync(paths.out, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      target: 'pr-123',
      verdict,
      markdownReportPath: '.qwen/reviews/review.md',
    });
  });

  it('refuses outputs outside .qwen/reviews, including .qwen/tmp and outside the workspace', () => {
    const paths = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'review-artifact-outside-'));
    try {
      for (const out of [
        join(root, '.qwen/tmp/review.json'),
        join(root, '.qwen/reviews-other/review.json'),
        join(outside, 'review.json'),
      ]) {
        expect(() =>
          saveReviewArtifact({
            ...paths,
            out,
            target: 'local',
            effort: 'medium',
          }),
        ).toThrow(/workspace|under .*\.qwen.*reviews/);
        expect(existsSync(out)).toBe(false);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses an output path that traverses a symlink', () => {
    const paths = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'review-artifact-outside-'));
    rmSync(join(root, '.qwen/reviews'), { recursive: true });
    symlinkSync(outside, join(root, '.qwen/reviews'));
    try {
      expect(() =>
        saveReviewArtifact({
          ...paths,
          target: 'local',
          effort: 'medium',
        }),
      ).toThrow(/symbolic link/);
      expect(existsSync(join(outside, 'review.json'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each(['findings', 'composed', 'report'] as const)(
    'refuses a %s input path that traverses a symlink',
    (input) => {
      const paths = fixture();
      const outside = mkdtempSync(join(tmpdir(), 'review-artifact-input-'));
      const outsideFile = join(
        outside,
        input === 'report' ? 'review.md' : `${input}.json`,
      );
      writeFileSync(
        outsideFile,
        input === 'report' ? '# Outside\n' : readFileSync(paths[input], 'utf8'),
      );
      rmSync(paths[input]);
      symlinkSync(outsideFile, paths[input]);
      try {
        expect(() =>
          saveReviewArtifact({
            ...paths,
            target: 'local',
            effort: 'medium',
          }),
        ).toThrow(/symbolic link/);
        expect(existsSync(paths.out)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('fails closed on malformed findings without leaving output', () => {
    const paths = fixture();
    writeFileSync(paths.findings, '{');

    expect(() =>
      saveReviewArtifact({
        ...paths,
        target: 'local',
        effort: 'medium',
      }),
    ).toThrow(/not valid JSON/);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('rejects inconsistent canonical counts instead of recalculating them', () => {
    const paths = fixture();
    const report = buildReport([finding]);
    report.counts.total = 0;
    writeJson(paths.findings, report);

    expect(() =>
      saveReviewArtifact({
        ...paths,
        target: 'local',
        effort: 'medium',
      }),
    ).toThrow(/inconsistent/);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('accepts an empty body from an inline-only request-changes verdict', () => {
    const paths = fixture();
    writeJson(paths.composed, { ...verdict, body: '' });

    saveReviewArtifact({
      ...paths,
      target: 'local',
      effort: 'medium',
    });

    expect(JSON.parse(readFileSync(paths.out, 'utf8')).verdict.body).toBe('');
  });

  it('fails closed when the composed verdict is incomplete', () => {
    const paths = fixture();
    const { verdictLine: _removed, ...incomplete } = verdict;
    writeJson(paths.composed, incomplete);

    expect(() =>
      saveReviewArtifact({
        ...paths,
        target: 'local',
        effort: 'medium',
      }),
    ).toThrow(/verdictLine/);
    expect(existsSync(paths.out)).toBe(false);
  });

  it.each(['findings', 'composed', 'report'] as const)(
    'refuses to overwrite the %s input',
    (input) => {
      const paths = fixture();
      const inputPath = join(
        root,
        '.qwen/reviews',
        input === 'report' ? 'review.md' : `${input}.json`,
      );
      if (input !== 'report') {
        writeFileSync(inputPath, readFileSync(paths[input], 'utf8'));
      }
      const original = readFileSync(inputPath, 'utf8');

      expect(() =>
        saveReviewArtifact({
          ...paths,
          [input]: inputPath,
          out: inputPath,
          target: 'local',
          effort: 'medium',
        }),
      ).toThrow(/must not overwrite/);
      expect(readFileSync(inputPath, 'utf8')).toBe(original);
    },
  );

  it.skipIf(!caseInsensitiveFs)(
    'refuses a case-insensitive output alias of the Markdown report',
    () => {
      const paths = fixture();
      const alias = join(root, '.qwen/reviews/REVIEW.MD');
      expect(existsSync(alias)).toBe(true);
      const original = readFileSync(paths.report, 'utf8');

      expect(() =>
        saveReviewArtifact({
          ...paths,
          out: alias,
          target: 'local',
          effort: 'medium',
        }),
      ).toThrow(/must not overwrite/);
      expect(readFileSync(paths.report, 'utf8')).toBe(original);
    },
  );

  it('requires the Markdown report to be durable under .qwen/reviews', () => {
    const paths = fixture();
    const temporaryReport = join(root, '.qwen/tmp/review.md');
    writeFileSync(temporaryReport, '# Temporary\n');

    expect(() =>
      saveReviewArtifact({
        ...paths,
        report: temporaryReport,
        target: 'local',
        effort: 'medium',
      }),
    ).toThrow(/Markdown report must be a file under/);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('requires the Markdown report to exist before creating output', () => {
    const paths = fixture();
    rmSync(paths.report);

    expect(() =>
      saveReviewArtifact({
        ...paths,
        target: 'local',
        effort: 'medium',
      }),
    ).toThrow(/Could not read the Markdown report/);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('names a directory Markdown report as not a file instead of unreadable', () => {
    const paths = fixture();
    rmSync(paths.report);
    mkdirSync(paths.report);

    expect(() =>
      saveReviewArtifact({
        ...paths,
        target: 'local',
        effort: 'medium',
      }),
    ).toThrow(/Markdown report is not a file/);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('refuses a low-effort artifact', () => {
    const paths = fixture();

    expect(() =>
      saveReviewArtifact({
        ...paths,
        target: 'local',
        effort: 'low',
      }),
    ).toThrow(/does not support low-effort reviews/);
    expect(existsSync(paths.out)).toBe(false);
  });

  it('resolves relative paths against the workspace root, not cwd', () => {
    // The form SKILL.md documents. beforeEach points QWEN_CODE_PROJECT_DIR at
    // the temp root while cwd stays the package directory, so the two roots
    // differ and the resolution direction is observable.
    fixture();

    const saved = saveReviewArtifact({
      findings: '.qwen/tmp/findings.json',
      composed: '.qwen/tmp/composed.json',
      report: '.qwen/reviews/review.md',
      out: '.qwen/reviews/review.json',
      target: 'pr-123',
      effort: 'high',
    });

    expect(saved.path).toBe(join(root, '.qwen/reviews/review.json'));
    // The registration value `record_artifact` wants, printed so the skill
    // copies it verbatim — including from a PR worktree run where cwd (the
    // disposable review worktree) differs from the workspace root.
    expect(saved.workspacePath).toBe('.qwen/reviews/review.json');
    expect(JSON.parse(readFileSync(saved.path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      target: 'pr-123',
      markdownReportPath: '.qwen/reviews/review.md',
    });
  });
});
