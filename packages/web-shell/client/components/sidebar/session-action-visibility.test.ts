import { describe, expect, it } from 'vitest';
import type {
  WebShellSidebarSessionActionItem,
  WebShellSidebarSessionInlineActionItem,
} from './WebShellSidebar';

const ALL_ITEMS: readonly WebShellSidebarSessionActionItem[] = [
  'details',
  'rename',
  'group',
  'export',
  'delete',
  'pin',
  'archive',
];

const DEFAULT_ITEMS: readonly WebShellSidebarSessionActionItem[] = ALL_ITEMS;

const DEFAULT_INLINE_ITEMS: readonly WebShellSidebarSessionInlineActionItem[] =
  ['pin'];

/** Items that can never appear as inline buttons. */
const DROPDOWN_ONLY_ITEMS: readonly WebShellSidebarSessionActionItem[] = [
  'archive',
  'group',
];

interface VisibilityResult {
  inline: Set<WebShellSidebarSessionActionItem>;
  dropdown: Set<WebShellSidebarSessionActionItem>;
  hover: Set<WebShellSidebarSessionActionItem>;
  showDropdownTrigger: boolean;
}

/**
 * Pure computation mirroring the visibility logic in WebShellSidebar's
 * session-row render. Built-in capability conditions are assumed true
 * (this test covers the items × inlineItems matrix, not runtime state).
 */
function computeVisibility(
  items: readonly WebShellSidebarSessionActionItem[],
  inlineItems: readonly WebShellSidebarSessionInlineActionItem[],
): VisibilityResult {
  const itemSet = new Set(items);
  const inlineSet = new Set<WebShellSidebarSessionActionItem>(inlineItems);

  const inline = new Set<WebShellSidebarSessionActionItem>();
  const dropdown = new Set<WebShellSidebarSessionActionItem>();
  const hover = new Set<WebShellSidebarSessionActionItem>();

  for (const item of ALL_ITEMS) {
    if (!itemSet.has(item)) continue;

    if (item === 'details') {
      hover.add(item);
    } else if (DROPDOWN_ONLY_ITEMS.includes(item)) {
      dropdown.add(item);
    } else if (inlineSet.has(item as WebShellSidebarSessionInlineActionItem)) {
      inline.add(item);
    } else {
      dropdown.add(item);
    }
  }

  return {
    inline,
    dropdown,
    hover,
    showDropdownTrigger: dropdown.size > 0,
  };
}

describe('session action visibility matrix', () => {
  describe('defaults (no consumer config)', () => {
    it('shows details on hover, pin inline, and mutations in the dropdown', () => {
      const { inline, dropdown, hover, showDropdownTrigger } =
        computeVisibility(DEFAULT_ITEMS, DEFAULT_INLINE_ITEMS);

      expect([...inline]).toEqual(['pin']);
      expect([...dropdown].sort()).toEqual([
        'archive',
        'delete',
        'export',
        'group',
        'rename',
      ]);
      expect([...hover]).toEqual(['details']);
      expect(showDropdownTrigger).toBe(true);
    });
  });

  describe('items × inlineItems interaction', () => {
    it('inlineItems: [] — all items fall to dropdown', () => {
      const { inline, dropdown, showDropdownTrigger } = computeVisibility(
        DEFAULT_ITEMS,
        [],
      );

      expect(inline.size).toBe(0);
      expect([...dropdown].sort()).toEqual(
        ALL_ITEMS.filter((item) => item !== 'details').sort(),
      );
      expect(showDropdownTrigger).toBe(true);
    });

    it('items: [] — nothing renders anywhere, trigger hidden', () => {
      const { inline, dropdown, showDropdownTrigger } = computeVisibility(
        [],
        DEFAULT_INLINE_ITEMS,
      );

      expect(inline.size).toBe(0);
      expect(dropdown.size).toBe(0);
      expect(showDropdownTrigger).toBe(false);
    });

    it('inlineItems: ["delete"] — delete inline only, not in dropdown', () => {
      const { inline, dropdown } = computeVisibility(DEFAULT_ITEMS, ['delete']);

      expect(inline.has('delete')).toBe(true);
      expect(dropdown.has('delete')).toBe(false);
      expect([...inline].sort()).toEqual(['delete']);
      expect([...dropdown].sort()).toEqual([
        'archive',
        'export',
        'group',
        'pin',
        'rename',
      ]);
    });

    it('items: ["pin", "delete"], inlineItems: ["delete"] — pin falls to dropdown', () => {
      const { inline, dropdown } = computeVisibility(
        ['pin', 'delete'],
        ['delete'],
      );

      expect([...inline].sort()).toEqual(['delete']);
      expect([...dropdown].sort()).toEqual(['pin']);
    });

    it('items: ["details", "group"] — details stays on hover', () => {
      const { inline, dropdown, hover, showDropdownTrigger } =
        computeVisibility(['details', 'group'], DEFAULT_INLINE_ITEMS);

      expect(inline.size).toBe(0);
      expect([...dropdown]).toEqual(['group']);
      expect([...hover]).toEqual(['details']);
      expect(showDropdownTrigger).toBe(true);
    });

    it('no item appears in both inline and dropdown simultaneously', () => {
      const configs: Array<{
        items: readonly WebShellSidebarSessionActionItem[];
        inlineItems: readonly WebShellSidebarSessionInlineActionItem[];
      }> = [
        { items: DEFAULT_ITEMS, inlineItems: DEFAULT_INLINE_ITEMS },
        { items: DEFAULT_ITEMS, inlineItems: [] },
        { items: DEFAULT_ITEMS, inlineItems: ['pin', 'delete'] },
        { items: DEFAULT_ITEMS, inlineItems: ['rename', 'export', 'delete'] },
        { items: ['delete', 'rename'], inlineItems: ['delete', 'rename'] },
        { items: ['pin', 'archive'], inlineItems: [] },
        { items: [], inlineItems: DEFAULT_INLINE_ITEMS },
      ];

      for (const config of configs) {
        const { inline, dropdown } = computeVisibility(
          config.items,
          config.inlineItems,
        );
        const overlap = [...inline].filter((item) => dropdown.has(item));
        expect(
          overlap,
          `overlap with config: ${JSON.stringify(config)}`,
        ).toEqual([]);
      }
    });
  });
});
