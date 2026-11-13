/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_VIEW_CHARS,
  viewSpecSchema,
  type ViewSpecV1,
} from './view-spec.js';

const reportId = `r1_${'a'.repeat(64)}`;
const list = {
  kind: 'failure-list',
  groupBy: 'file',
  columns: ['path', 'title', 'status', 'duration'],
} as const;
function view(): ViewSpecV1 {
  return {
    schemaVersion: 1,
    reportId,
    sections: [
      { kind: 'summary' },
      { kind: 'status-counts' },
      { ...list, columns: [...list.columns], initialTextFilter: 'timeout' },
      { kind: 'evidence', initialFailureId: 'f0:error' },
      {
        kind: 'hypothesis-groups',
        groups: [
          {
            label: 'Possible setup failure',
            hypothesis: 'The collection error may explain both failures.',
            failureIds: ['f0:error', 'f1:a0'],
          },
        ],
      },
    ],
  };
}

describe('bounded view catalog', () => {
  it('allows all five sections, reordered columns and overlapping hypotheses', () => {
    const value = view();
    value.sections.reverse();
    const groups = value.sections.find(
      (section) => section.kind === 'hypothesis-groups',
    )!;
    groups.groups.push({
      label: 'Alternative explanation',
      hypothesis: 'The assertion may be independent of the collection error.',
      failureIds: ['f1:a0'],
    });
    expect(viewSpecSchema.parse(value)).toEqual(value);
    expect(
      viewSpecSchema.parse({
        schemaVersion: 1,
        reportId,
        sections: [{ ...list, columns: ['duration', 'title'] }],
      }),
    ).toMatchObject({ sections: [{ columns: ['duration', 'title'] }] });
  });

  it.each([
    { schemaVersion: 2 },
    { reportId: 'not-a-report' },
    { url: 'https://example.test' },
    { sections: [] },
    { sections: [{ kind: 'summary' }] },
    { sections: [list, list] },
    { sections: [list, { kind: 'html', html: '<script>alert(1)</script>' }] },
    { sections: [{ ...list, command: 'run tests' }] },
    { sections: [{ ...list, columns: [] }] },
    { sections: [{ ...list, columns: ['path', 'path'] }] },
    { sections: [{ ...list, columns: ['diagnostics'] }] },
    { sections: [{ ...list, groupBy: 'root-cause' }] },
    { sections: [{ ...list, initialTextFilter: 'x'.repeat(513) }] },
    { sections: [list, { kind: 'evidence', initialFailureId: 'f00:a0' }] },
    { sections: [list, { kind: 'hypothesis-groups', groups: [] }] },
  ])('rejects unsupported, duplicate or incomplete layouts: %j', (changes) => {
    expect(viewSpecSchema.safeParse({ ...view(), ...changes }).success).toBe(
      false,
    );
  });

  it.each([
    { label: '' },
    { label: ' ' },
    { label: 'x'.repeat(121) },
    { hypothesis: '' },
    { hypothesis: 'x'.repeat(401) },
    { failureIds: [] },
    { failureIds: ['f0:a0', 'f0:a0'] },
    { failureIds: ['another-report/f0:a0'] },
    { certainty: 'proven' },
  ])('rejects invalid hypothesis groups: %j', (changes) => {
    expect(
      viewSpecSchema.safeParse({
        schemaVersion: 1,
        reportId,
        sections: [
          list,
          {
            kind: 'hypothesis-groups',
            groups: [
              {
                label: 'Hypothesis',
                hypothesis: 'A possible cause.',
                failureIds: ['f0:a0'],
                ...changes,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('bounds references across groups, including overlapping IDs', () => {
    const groups = Array.from({ length: 8 }, () => ({
      label: 'Hypothesis',
      hypothesis: 'A possible shared cause.',
      failureIds: Array.from({ length: 16 }, (_, index) => `f0:a${index}`),
    }));
    const value = {
      schemaVersion: 1,
      reportId,
      sections: [list, { kind: 'hypothesis-groups', groups }],
    };
    expect(viewSpecSchema.safeParse(value).success).toBe(true);
    groups[0].failureIds.push('f0:a16');
    expect(viewSpecSchema.safeParse(value).success).toBe(false);
    groups[0].failureIds.pop();
    groups.push(groups[0]);
    expect(viewSpecSchema.safeParse(value).success).toBe(false);
  });

  it('counts JSON escaping at the exact serialized character boundary', () => {
    const groups = Array.from({ length: 8 }, () => ({
      label: 'x'.repeat(120),
      hypothesis: 'x'.repeat(400),
      failureIds: ['f0:a0'],
    }));
    const value = {
      schemaVersion: 1,
      reportId,
      sections: [list, { kind: 'hypothesis-groups', groups }],
    };
    let remaining = MAX_VIEW_CHARS - JSON.stringify(value).length;
    for (const group of groups) {
      const escaped = Math.min(remaining, 400);
      group.hypothesis = '"'.repeat(escaped) + 'x'.repeat(400 - escaped);
      remaining -= escaped;
    }
    expect(remaining).toBe(0);
    expect(JSON.stringify(value).length).toBe(MAX_VIEW_CHARS);
    expect(viewSpecSchema.safeParse(value).success).toBe(true);
    groups[0].label = '"' + groups[0].label.slice(1);
    expect(JSON.stringify(value).length).toBe(MAX_VIEW_CHARS + 1);
    expect(viewSpecSchema.safeParse(value).success).toBe(false);
  });

  it('uses schema key order for canonical serialization without reordering sections', () => {
    const expected = viewSpecSchema.parse(view());
    const reordered = {
      sections: expected.sections.map((section) =>
        Object.fromEntries(Object.entries(section).reverse()),
      ),
      reportId,
      schemaVersion: 1,
    };
    expect(JSON.stringify(viewSpecSchema.parse(reordered))).toBe(
      JSON.stringify(expected),
    );
  });
});
