/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompletionItem } from '../../types/completionItemTypes.js';

export function getSkillsSecondaryQuery(query: string): string | null {
  const match = query.match(/^skills\s+(.*)$/i);
  return match ? match[1] : null;
}

export function isSkillsSecondaryQuery(query: string): boolean {
  return getSkillsSecondaryQuery(query) !== null;
}

export function buildSkillCompletionItems(
  skills: string[],
  query: string,
): CompletionItem[] {
  const skillQuery = getSkillsSecondaryQuery(query);
  if (skillQuery === null) {
    return [];
  }

  const normalizedQuery = skillQuery.toLowerCase();
  return skills
    .map(
      (skill) =>
        ({
          id: `skill:${skill}`,
          label: skill,
          type: 'command' as const,
          group: 'Skills',
          value: `skills ${skill}`,
        }) satisfies CompletionItem,
    )
    .filter((item) => item.label.toLowerCase().includes(normalizedQuery));
}

export function shouldOpenSkillsSecondaryPicker(item: CompletionItem): boolean {
  return item.type === 'command' && item.id === 'skills';
}
