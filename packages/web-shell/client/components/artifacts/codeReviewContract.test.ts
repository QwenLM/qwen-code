/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The CLI/renderer contract: the fixture is genuine `qwen review save-artifact`
// output, generated through `buildReport(validateFindings(...))` — not a
// hand-written copy. If the CLI's document shape or vocabulary changes,
// regenerate the fixture and bring this parser along.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCodeReviewDocument } from './CodeReviewArtifactDetail';

const fixture = readFileSync(
  fileURLToPath(
    new URL('./__fixtures__/code-review-artifact-v1.json', import.meta.url),
  ),
  'utf8',
);

describe('code review artifact contract', () => {
  it('parses the CLI-generated document without losing fields', () => {
    const reviewDocument = parseCodeReviewDocument(fixture);

    expect(reviewDocument.schemaVersion).toBe(1);
    expect(reviewDocument.target).toBe('pr-8402');
    expect(reviewDocument.effort).toBe('high');
    // The parser validates only what the renderer displays; persisted-but-
    // unrendered fields (downgraded, outcomesRecorded, byOutcome, ...) pass
    // through unchecked and are asserted nowhere on purpose.
    expect(reviewDocument.verdict).toMatchObject({
      event: 'COMMENT',
      baseEvent: 'REQUEST_CHANGES',
      cappedBy: ['no release-blocker evidence'],
      verdictLine: 'Verdict: Comment — Request changes was downgraded',
    });
    expect(reviewDocument.markdownReportPath).toBe(
      '.qwen/reviews/contract-v1.md',
    );

    // The fixture exercises the whole vocabulary — every source, severity,
    // confidence and outcome the CLI can canonicalize — so this parse proves
    // the renderer accepts all of it.
    const findings = reviewDocument.findings;
    expect(findings.map((finding) => finding.id)).toEqual([
      'f-critical-review',
      'f-suggestion-build',
      'f-suggestion-test-held',
      'f-suggestion-lint',
      'f-nice-probe',
    ]);
    expect(new Set(findings.map((finding) => finding.source))).toEqual(
      new Set(['review', 'build', 'test', 'probe', 'lint']),
    );
    expect(new Set(findings.map((finding) => finding.severity))).toEqual(
      new Set(['Critical', 'Suggestion', 'Nice to have']),
    );
    expect(new Set(findings.map((finding) => finding.confidence))).toEqual(
      new Set(['high', 'low']),
    );
    expect(new Set(findings.map((finding) => finding.outcome))).toEqual(
      new Set(['fixed', 'skipped', 'no_change_needed']),
    );

    expect(reviewDocument.counts).toEqual({
      total: 5,
      bySeverity: { Critical: 1, Suggestion: 3, 'Nice to have': 1 },
      byConfidence: { high: 4, low: 1 },
      held: 1,
    });

    const held = findings.find((f) => f.id === 'f-suggestion-test-held');
    expect(held?.heldByMeasurement).toEqual({
      file: 'packages/cli/src/ui/pagination.test.ts',
    });

    const aggregate = findings.find((f) => f.id === 'f-suggestion-lint');
    expect(aggregate?.locations).toHaveLength(2);
  });

  it('fails closed on a vocabulary value the renderer does not know yet', () => {
    // The drift mode the contract guards: the CLI adds a value the renderer
    // copy has not been taught, and documents carrying it refuse to render
    // until the renderer is updated with it.
    const drifted = JSON.parse(fixture) as {
      findings: Array<{ source: string }>;
    };
    drifted.findings[0]!.source = 'typecheck';

    expect(() => parseCodeReviewDocument(JSON.stringify(drifted))).toThrow(
      'findings[0].source has an unsupported value.',
    );
  });
});
