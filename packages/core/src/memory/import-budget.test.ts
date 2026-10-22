/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  estimateMemoryImport,
  packMemoryImportSections,
} from './import-budget.js';

const sections = Array.from({ length: 8 }, (_, index) => ({
  id: `section-${index}`,
  content: `Independent durable fact ${index}.`,
  groupId: 'group',
}));

describe('memory import estimate', () => {
  it('packs by stable identity and group without mutating input', () => {
    const grouped = [
      { ...sections[0], id: 'other', groupId: 'other' },
      ...[...sections].reverse(),
    ];
    const before = structuredClone(grouped);
    expect(
      packMemoryImportSections(grouped).map((batch) =>
        batch.map((item) => item.id),
      ),
    ).toEqual([['other'], sections.map((section) => section.id)]);
    expect(grouped).toEqual(before);
  });
  it('bounds both section counts and UTF-8 source bytes', () => {
    const ninth = { ...sections[0], id: 'section-8' };
    expect(
      packMemoryImportSections([...sections, ninth]).map(
        (batch) => batch.length,
      ),
    ).toEqual([8, 1]);
    const large = sections.slice(0, 3).map((section) => ({
      ...section,
      content: '界'.repeat(10_922),
    }));
    expect(
      packMemoryImportSections(large).map((batch) => batch.length),
    ).toEqual([2, 1]);
  });
  it('reports zero for an empty selection and flags an excessive one', () => {
    expect(estimateMemoryImport([])).toMatchObject({
      modelCalls: 0,
      sourceTokens: 0,
      maxOutputTokens: 0,
      reservedTokens: 0,
      exceedsBudget: false,
    });
    expect(
      estimateMemoryImport(
        sections.map((section) => ({ ...section, groupId: section.id })),
      ).exceedsBudget,
    ).toBe(true);
  });
  it('bounds the calls a scope split can add for one preview group', () => {
    const selection = sections.map((section, index) => ({
      ...section,
      groupId: `${index < 4 ? 'user' : 'project'}:group`,
    }));
    expect(packMemoryImportSections(selection)).toHaveLength(2);
    expect(estimateMemoryImport(sections).modelCalls).toBe(2);
  });
});
