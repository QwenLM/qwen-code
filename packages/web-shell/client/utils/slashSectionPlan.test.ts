/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { planSlashSectionRows } from './slashSectionPlan';

describe('planSlashSectionRows', () => {
  it('shows a header at each group boundary', () => {
    const plans = planSlashSectionRows(
      [
        { section: 'Custom commands' },
        { section: 'Custom commands' },
        { section: 'Skill commands' },
        { section: 'System commands' },
      ],
      'command',
    );
    expect(plans.map((p) => p.showHeader)).toEqual([true, false, true, true]);
  });

  it('shows a header but no divider on the first row', () => {
    const plans = planSlashSectionRows(
      [{ section: 'Skill commands' }, { section: 'System commands' }],
      'command',
    );
    expect(plans[0]).toMatchObject({ showHeader: true, showDivider: false });
    expect(plans[1]).toMatchObject({ showHeader: true, showDivider: true });
  });

  it('does not repeat headers for adjacent duplicate sections', () => {
    const plans = planSlashSectionRows(
      [
        { section: 'System commands' },
        { section: 'System commands' },
        { section: 'System commands' },
      ],
      'command',
    );
    expect(plans.filter((p) => p.showHeader)).toHaveLength(1);
  });

  it('reports the number of rows in each section on the header row', () => {
    const plans = planSlashSectionRows(
      [
        { section: 'Skill commands' },
        { section: 'Skill commands' },
        { section: 'System commands' },
      ],
      'command',
    );
    expect(plans[0].count).toBe(2);
    expect(plans[1].count).toBe(0);
    expect(plans[2].count).toBe(1);
  });

  it('never groups subcommand menus', () => {
    const plans = planSlashSectionRows(
      [{ section: 'Skill commands' }, { section: 'System commands' }],
      'subcommand',
    );
    expect(plans.every((p) => !p.showHeader && p.count === 0)).toBe(true);
  });

  it('shows no headers when items carry no section (search results)', () => {
    const plans = planSlashSectionRows(
      [{ section: undefined }, { section: undefined }],
      'command',
    );
    expect(plans.every((p) => !p.showHeader)).toBe(true);
  });
});
