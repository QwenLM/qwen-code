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
});
