/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { FindingsResultDisplay } from '@qwen-code/qwen-code-core';
import { FindingsDisplay } from './FindingsDisplay.js';

function display(
  overrides: Partial<FindingsResultDisplay> = {},
): FindingsResultDisplay {
  return {
    type: 'findings_list',
    level: 'high',
    findings: [
      {
        id: 'R1-1',
        severity: 'Critical',
        confidence: 'high',
        file: 'src/foo.ts',
        line: 42,
        // shortSummary deliberately differs from summary: the row must render
        // the compact label, and a fixture where the two coincide would keep
        // every test green if FindingRow regressed to rendering `summary`.
        summary:
          'the provider returns the wrong value on every cold-cache lookup',
        shortSummary: 'cold-cache wrong return',
        failureScenario: 'first call after start returns undefined',
      },
      {
        severity: 'Suggestion',
        confidence: 'low',
        file: 'src/bar.ts',
        summary: 'the helper is duplicated between bar.ts and baz.ts',
        shortSummary: 'duplicated helper',
        failureScenario: 'two copies drift',
      },
    ],
    ...overrides,
  };
}

describe('<FindingsDisplay />', () => {
  it('renders one row per finding with severity, id, location and label', () => {
    const { lastFrame } = render(<FindingsDisplay data={display()} />);
    const frame = lastFrame()!;
    expect(frame).toContain('Critical');
    expect(frame).toContain('R1-1');
    expect(frame).toContain('src/foo.ts:42');
    expect(frame).toContain('cold-cache wrong return');
    expect(frame).toContain('Suggestion');
    expect(frame).toContain('src/bar.ts');
    expect(frame).toContain('(low confidence)');
    // The row renders shortSummary, never the full summary.
    expect(frame.replace(/\s+/g, ' ')).not.toContain(
      'wrong value on every cold-cache lookup',
    );
  });

  it('renders outcomes with the skip reason', () => {
    const data = display();
    data.findings = data.findings.map((finding, index) =>
      index === 0
        ? { ...finding, outcome: 'fixed' as const }
        : {
            ...finding,
            outcome: 'skipped' as const,
            outcomeNote: 'fix would change intended behaviour',
          },
    );
    const { lastFrame } = render(<FindingsDisplay data={data} />);
    const frame = lastFrame()!.replace(/\s+/g, ' ');
    expect(frame).toContain('(fixed)');
    expect(frame).toContain('(skipped: fix would change intended behaviour)');
  });

  it('renders an explicit empty state', () => {
    const { lastFrame } = render(
      <FindingsDisplay data={display({ findings: [] })} />,
    );
    expect(lastFrame()).toContain('No findings.');
  });

  it('keeps the unverified marker for an empty low-effort report', () => {
    // A quick pass that finds nothing still reports an UNVERIFIED nothing;
    // the early empty-state return must not drop the banner, or the row
    // reads as a verified clean bill.
    const { lastFrame } = render(
      <FindingsDisplay data={display({ level: 'low', findings: [] })} />,
    );
    const frame = lastFrame()!;
    expect(frame).toContain('No findings.');
    expect(frame).toContain('unverified');
  });

  it('counts findings history compaction evicted', () => {
    const data = display();
    data.omittedFindings = 47;
    const { lastFrame } = render(<FindingsDisplay data={data} />);
    expect(lastFrame()!).toContain(
      '(+47 more findings removed by history compaction)',
    );
  });

  it('marks a low-level report unverified even where rows omit confidence', () => {
    // Step 3C sends `level: 'low'` while omitting per-finding confidence for
    // candidates the pass kept — the list itself must carry the unverified
    // state, or those rows render exactly like verified findings.
    const data = display({ level: 'low' });
    data.findings = data.findings.map(
      ({ confidence: _confidence, ...rest }) => rest,
    );
    const { lastFrame } = render(<FindingsDisplay data={data} />);
    expect(lastFrame()!).toContain('unverified');
  });

  it('does not mark verified reports unverified', () => {
    const { lastFrame } = render(<FindingsDisplay data={display()} />);
    expect(lastFrame()!).not.toContain('unverified');
  });

  it.each([
    ['CR', 'reason\rCritical R1-9 fake'],
    ['LF', 'reason\nCritical R1-9 fake'],
    ['TAB', 'reason\tCritical R1-9 fake'],
    ['ESC', 'reason\u001bCritical R1-9 fake'],
    ['C1 CSI', 'reason\u009bCritical R1-9 fake'],
  ])(
    'renders a %s outcome note inertly on the finding row',
    (_name, outcomeNote) => {
      const data = display({
        findings: [
          {
            severity: 'Critical',
            file: 'a.ts',
            summary: 's',
            shortSummary: 's',
            failureScenario: 'f',
            outcome: 'skipped',
            outcomeNote,
          },
        ],
      });
      const { lastFrame } = render(<FindingsDisplay data={data} />);
      const frame = lastFrame()!;
      // Ink joins rows with LF, so only the other controls are asserted
      // absent; the marker-line assertion witnesses CR/LF/TAB.
      // eslint-disable-next-line no-control-regex -- asserting the controls are absent is the point
      expect(frame).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      const markerLine = frame
        .split('\n')
        .find((line) => line.includes('(skipped:'));
      expect(markerLine).toBeDefined();
      expect(markerLine).toContain('reason Critical R1-9 fake');
    },
  );

  it('renders control characters in other fields inertly', () => {
    const data = display({
      findings: [
        {
          severity: 'Suggestion',
          file: 'src/\u009bfoo.ts',
          line: 1,
          summary: 's',
          shortSummary: 'sum\u0007mary',
          failureScenario: 'f',
        },
      ],
    });
    const { lastFrame } = render(<FindingsDisplay data={data} />);
    const frame = lastFrame()!;
    expect(frame).not.toContain('\u009b');
    expect(frame).not.toContain('\u0007');
    expect(frame.replace(/\s+/g, ' ')).toContain('src/ foo.ts:1');
    expect(frame.replace(/\s+/g, ' ')).toContain('sum mary');
  });
});
