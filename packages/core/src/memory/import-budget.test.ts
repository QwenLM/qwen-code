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
  it('bounds the calls a scope split can add for one preview group', () => {
    const selection = sections.map((section, index) => ({
      ...section,
      scope: index < 4 ? 'user' : 'project',
    }));
    expect(packMemoryImportSections(selection)).toHaveLength(2);
    expect(estimateMemoryImport(sections).modelCalls).toBe(2);
  });
});
