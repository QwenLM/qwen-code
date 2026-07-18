import { describe, expect, it } from 'vitest';
import {
  filterToolbarDropdownItems,
  getToolbarExpansionBudget,
  getToolbarItemVisibility,
  getToolbarItemVisibilityWithHysteresis,
  resolveToolbarModelLabel,
} from './toolbarDropdown';

describe('toolbarDropdown', () => {
  it('filters by display label and stable model id', () => {
    const items = [
      { id: 'a', label: 'Qwen 3.5', searchText: 'qwen3.5-plus (oauth)' },
      { id: 'b', label: 'GLM 5.2', searchText: 'glm-5.2 (gateway)' },
      { id: 'c', label: 'Local model' },
    ];

    expect(filterToolbarDropdownItems(items, 'glm')).toEqual([items[1]]);
    expect(filterToolbarDropdownItems(items, 'oauth')).toEqual([items[0]]);
    expect(filterToolbarDropdownItems(items, 'local')).toEqual([items[2]]);
    expect(filterToolbarDropdownItems(items, '  ')).toEqual(items);
  });

  it('collapses items from left to right as width decreases', () => {
    const items = [
      { id: 'branch', expansionWidth: 100 },
      { id: 'mode', expansionWidth: 64 },
      { id: 'model', expansionWidth: 80 },
    ];

    expect(getToolbarItemVisibility({ availableWidth: 244, items })).toEqual({
      branch: true,
      mode: true,
      model: true,
    });
    expect(getToolbarItemVisibility({ availableWidth: 144, items })).toEqual({
      branch: false,
      mode: true,
      model: true,
    });
    expect(getToolbarItemVisibility({ availableWidth: 80, items })).toEqual({
      branch: false,
      mode: false,
      model: true,
    });
  });

  it('keeps pending items collapsed without consuming width', () => {
    const pending = resolveToolbarModelLabel({
      currentModelLabel: '',
      lastConfirmedModelLabel: '',
    });

    expect(pending.modelLabelReady).toBe(false);
    expect(
      getToolbarItemVisibility({
        availableWidth: 64,
        items: [
          { id: 'mode', expansionWidth: 64 },
          {
            id: 'model',
            expansionWidth: 80,
            ready: pending.modelLabelReady,
          },
        ],
      }),
    ).toEqual({ mode: true, model: false });
  });

  it('reserves toolbar render-prop widths before expanding built-in items', () => {
    const base = {
      toolbarWidth: 500,
      leadingWidth: 360,
      rightWidth: 80,
      currentExpansionWidth: 240,
      gap: 8,
    };

    expect(getToolbarExpansionBudget(base)).toBe(292);
    expect(
      getToolbarExpansionBudget({
        ...base,
        leadingWidth: base.leadingWidth + 50,
      }),
    ).toBe(242);
    expect(
      getToolbarExpansionBudget({
        ...base,
        rightWidth: base.rightWidth + 40,
      }),
    ).toBe(252);
  });

  it('does not oscillate when aggregate rounding changes the budget by one pixel', () => {
    const items = [{ id: 'workspace', expansionWidth: 60 }];
    let visibility = { workspace: false };
    const states: boolean[] = [];

    for (let index = 0; index < 4; index += 1) {
      visibility = getToolbarItemVisibilityWithHysteresis({
        availableWidth: visibility.workspace ? 60 : 61,
        items,
        currentVisibility: visibility,
        expansionMargin: items.length,
      });
      states.push(visibility.workspace);
    }

    expect(states).toEqual([true, true, true, true]);
  });

  it('keeps the confirmed model through a transient empty update', () => {
    const confirmed = resolveToolbarModelLabel({
      currentModelLabel: 'Qwen 3.5 Plus',
      lastConfirmedModelLabel: '',
    });
    const transientEmpty = resolveToolbarModelLabel({
      currentModelLabel: '',
      lastConfirmedModelLabel: confirmed.nextConfirmedModelLabel,
    });

    expect(transientEmpty.modelLabel).toBe('Qwen 3.5 Plus');
  });

  it('uses an arriving replacement for the next measured layout', () => {
    const replacement = resolveToolbarModelLabel({
      currentModelLabel: 'GLM 5.2',
      lastConfirmedModelLabel: 'Qwen 3.5 Plus',
    });

    expect(replacement.modelLabel).toBe('GLM 5.2');
  });
});
