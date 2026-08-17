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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import type { Argv } from 'yargs';
import { buildReport, type Finding } from './findings.js';
import { saveArtifactCommand, saveReviewArtifact } from './save-artifact.js';

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
  // Non-zero on purpose: the copy test then proves passthrough, not just
  // the validator's absent-means-zero default.
  deferredCount: 2,
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
  // The workspace root is explicit here because the test process's cwd is the
  // package directory, not the temp root — the same explicit-root path the
  // skill's own Step 8 invocation takes.
  return { findings, composed, report, out, workspaceRoot: root };
}

beforeEach(() => {
  // realpath, because the cwd-default test below chdirs into the root and
  // compares against process.cwd(), which returns the physical path — on
  // macOS the temp dir is reached through a /var → /private/var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'review-artifact-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

  it.each(['two', -1, 1.5] as const)(
    'refuses a present deferredCount of the wrong shape (%s)',
    (bad) => {
      // The absent-means-zero default must not swallow a PRESENT malformed
      // value: a mutant deleting the refuse arm saved `deferredCount: -1`
      // into the durable artifact with the suite fully green.
      const paths = fixture();
      writeJson(paths.composed, { ...verdict, deferredCount: bad });

      expect(() =>
        saveReviewArtifact({
          ...paths,
          target: 'local',
          effort: 'medium',
        }),
      ).toThrow(/deferredCount/);
      expect(existsSync(paths.out)).toBe(false);
    },
  );

  it('reads an absent or null deferredCount as zero — a pre-posture composed file must still save', () => {
    // Null rides the same absence semantics compose-review's own toCount
    // boundary gives this field's siblings.
    const paths = fixture();
    const { deferredCount: _absent, ...prePosture } = verdict;
    for (const composed of [prePosture, { ...verdict, deferredCount: null }]) {
      writeJson(paths.composed, composed);
      saveReviewArtifact({
        ...paths,
        target: 'local',
        effort: 'medium',
      });
      expect(
        JSON.parse(readFileSync(paths.out, 'utf8')).verdict.deferredCount,
      ).toBe(0);
    }
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

  it('refuses an absent output spelled through a symlink onto an absent input', () => {
    // The hardened absent-side semantics: neither file is on disk yet, but
    // the output is spelled through a symlinked directory component, so its
    // canonical identity is the findings input's. A revert to the old local
    // sameFile — false whenever a side is absent — passes green and lets
    // saveReviewArtifact overwrite an input it is about to read.
    const paths = fixture();
    symlinkSync(join(root, '.qwen/tmp'), join(root, '.qwen/reviews/link'));
    const absentInput = join(root, '.qwen/tmp/next.json');
    const out = join(root, '.qwen/reviews/link/next.json');

    expect(() =>
      saveReviewArtifact({
        ...paths,
        findings: absentInput,
        out,
        target: 'local',
        effort: 'medium',
      }),
    ).toThrow(/must not overwrite/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(absentInput)).toBe(false);
  });

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

  it('resolves relative paths against the explicit workspace root, not cwd', () => {
    // The form the skill's Step 8 block uses. --workspace-root points at the
    // temp root while cwd stays the package directory, so the two roots
    // differ and the resolution direction is observable.
    fixture();

    const saved = saveReviewArtifact({
      findings: '.qwen/tmp/findings.json',
      composed: '.qwen/tmp/composed.json',
      report: '.qwen/reviews/review.md',
      out: '.qwen/reviews/review.json',
      target: 'pr-123',
      effort: 'high',
      workspaceRoot: root,
    });

    expect(saved.path).toBe(join(root, '.qwen/reviews/review.json'));
    // The registration value `record_artifact` wants, printed so the skill
    // copies it verbatim.
    expect(saved.workspacePath).toBe('.qwen/reviews/review.json');
    expect(JSON.parse(readFileSync(saved.path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      target: 'pr-123',
      markdownReportPath: '.qwen/reviews/review.md',
    });
  });

  it('resolves against cwd and never QWEN_CODE_PROJECT_DIR', () => {
    // The default path, with the trap armed. No `workspaceRoot` is passed —
    // an embedder that omits it must land on cwd — while the env var points
    // at a decoy the removed preference would have taken: the variable names
    // the session-storage directory under the runtime base, never the main
    // checkout, and six of six measured CI reviews fumbled on it (DESIGN.md —
    // The artifact root that pointed at qwen-home). Re-introducing
    // `explicit ?? env ?? cwd` fails this test: resolution lands on the
    // decoy, not on cwd.
    const decoy = mkdtempSync(join(tmpdir(), 'review-artifact-decoy-'));
    const savedCwd = process.cwd();
    const previous = process.env['QWEN_CODE_PROJECT_DIR'];
    process.env['QWEN_CODE_PROJECT_DIR'] = decoy;
    try {
      fixture();
      process.chdir(root);
      const saved = saveReviewArtifact({
        findings: '.qwen/tmp/findings.json',
        composed: '.qwen/tmp/composed.json',
        report: '.qwen/reviews/review.md',
        out: '.qwen/reviews/review.json',
        target: 'pr-123',
        effort: 'high',
      });

      expect(saved.path).toBe(join(root, '.qwen/reviews/review.json'));
      expect(saved.workspacePath).toBe('.qwen/reviews/review.json');
      expect(existsSync(join(decoy, '.qwen/reviews/review.json'))).toBe(false);
    } finally {
      process.chdir(savedCwd);
      if (previous === undefined) {
        delete process.env['QWEN_CODE_PROJECT_DIR'];
      } else {
        process.env['QWEN_CODE_PROJECT_DIR'] = previous;
      }
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe('the CLI option contract', () => {
  // Every test above builds its args by hand — the same shape that let a
  // flag-name bug into `test-plan`: yargs camel-cases the flag, a field named
  // for the flag read `undefined` on every real invocation, and the suite
  // stayed green because nothing went through yargs. `--workspace-root` is
  // this command's only multi-word flag AND its trust anchor (it roots the
  // containment checks), so this test does not assert the parsed shape and
  // stop — it feeds the yargs-parsed object straight into saveReviewArtifact
  // and asserts on a write only reachable when the root actually arrived
  // from the flag: cwd stays the package directory, where none of the
  // fixture inputs exist.
  it('parses --workspace-root into the field saveReviewArtifact actually reads', () => {
    fixture();

    const parsed = (saveArtifactCommand.builder as (y: Argv) => Argv)(
      yargs([]),
    ).parseSync([
      '--findings',
      '.qwen/tmp/findings.json',
      '--composed',
      '.qwen/tmp/composed.json',
      '--report',
      '.qwen/reviews/review.md',
      '--target',
      'pr-123',
      '--effort',
      'high',
      '--out',
      '.qwen/reviews/review.json',
      '--workspace-root',
      root,
    ]) as unknown as Parameters<typeof saveReviewArtifact>[0];

    const saved = saveReviewArtifact(parsed);
    expect(saved.path).toBe(join(root, '.qwen/reviews/review.json'));
    expect(saved.workspacePath).toBe('.qwen/reviews/review.json');
  });
});
