/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../../test-utils/render.js';
import { waitFor } from '../../../test-utils/async.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ReactNode } from 'react';
import { Text } from 'ink';
import chalk from 'chalk';
import { getCachedStringWidth } from '../../utils/textUtils.js';
import { useRegisterKeyboardContext } from '../../contexts/KeyboardContextRegistry.js';
import {
  SettingsListPanel,
  type SettingsListPanelProps,
  type SettingsDialogItem,
  highlightText,
} from './SettingsListPanel.js';

enum TerminalKeys {
  ENTER = '\u000D',
  TAB = '\t',
  UP_ARROW = '\u001B[A',
  DOWN_ARROW = '\u001B[B',
  LEFT_ARROW = '\u001B[D',
  RIGHT_ARROW = '\u001B[C',
  ESCAPE = '\u001B',
  BACKSPACE = '\u0008',
  CTRL_L = '\u000C',
}

const createMockItems = (count = 4): SettingsDialogItem[] => {
  const items: SettingsDialogItem[] = [
    {
      key: 'boolean-setting',
      label: 'Boolean Setting',
      description: 'A boolean setting for testing',
      displayValue: 'true',
      rawValue: true,
      type: 'boolean',
    },
    {
      key: 'string-setting',
      label: 'String Setting',
      description: 'A string setting for testing',
      displayValue: 'test-value',
      rawValue: 'test-value',
      type: 'string',
    },
    {
      key: 'number-setting',
      label: 'Number Setting',
      description: 'A number setting for testing',
      displayValue: '42',
      rawValue: 42,
      type: 'number',
    },
    {
      key: 'enum-setting',
      label: 'Enum Setting',
      description: 'An enum setting for testing',
      displayValue: 'option-a',
      rawValue: 'option-a',
      type: 'enum',
    },
  ];

  // If count is larger than our base mock items, generate dynamic ones
  if (count > items.length) {
    for (let i = items.length; i < count; i++) {
      items.push({
        key: `extra-setting-${i}`,
        label: `Extra Setting ${i}`,
        displayValue: `value-${i}`,
        type: 'string',
      });
    }
  }

  return items.slice(0, count);
};

const DialogContextHarness = ({ children }: { children: ReactNode }) => {
  useRegisterKeyboardContext('Dialog', true);
  return <>{children}</>;
};

describe('SettingsListPanel', () => {
  let mockOnItemToggle: ReturnType<typeof vi.fn>;
  let mockOnEditCommit: ReturnType<typeof vi.fn>;
  let mockOnItemClear: ReturnType<typeof vi.fn>;
  let mockOnClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOnItemToggle = vi.fn();
    mockOnEditCommit = vi.fn();
    mockOnItemClear = vi.fn();
    mockOnClose = vi.fn();
  });

  const renderDialog = async (props: Partial<SettingsListPanelProps> = {}) => {
    const defaultProps: SettingsListPanelProps = {
      items: createMockItems(),
      maxItemsToShow: 8,
      onItemToggle: mockOnItemToggle,
      onEditCommit: mockOnEditCommit,
      onItemClear: mockOnItemClear,
      onClose: mockOnClose,
      ...props,
    };

    const result = await renderWithProviders(
      <DialogContextHarness>
        <SettingsListPanel {...defaultProps} />
      </DialogContextHarness>,
    );
    await result.waitUntilReady();
    return result;
  };

  describe('onActiveKeyChange', () => {
    it('seeds the focused key on mount, follows navigation, clears on unmount', async () => {
      const onActiveKeyChange = vi.fn();
      const items = createMockItems();
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items,
        onActiveKeyChange,
      });

      // Seeded on mount: a caller rendering its own footer needs the key on the
      // first frame, or the footer pops in a tick late.
      await waitFor(() => {
        expect(onActiveKeyChange).toHaveBeenCalledWith(items[0].key);
      });

      onActiveKeyChange.mockClear();
      await act(async () => {
        stdin.write('\u001B[B');
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(onActiveKeyChange).toHaveBeenCalledWith(items[1].key);
      });

      // Cleared on unmount, so a parent switching tabs doesn't keep describing
      // the outgoing panel's row.
      onActiveKeyChange.mockClear();
      unmount();
      expect(onActiveKeyChange).toHaveBeenCalledWith(undefined);
    });

    it('does not re-fire when items are rebuilt with the same focused key', async () => {
      const onActiveKeyChange = vi.fn();
      // Fresh objects, same keys — the shape a caller that builds items during
      // render produces on every frame. Firing on identity would loop forever.
      const { rerender, waitUntilReady, unmount } = await renderDialog({
        items: createMockItems(),
        onActiveKeyChange,
      });
      await waitFor(() => {
        expect(onActiveKeyChange).toHaveBeenCalledTimes(1);
      });

      onActiveKeyChange.mockClear();
      await act(async () => {
        rerender(
          <DialogContextHarness>
            <SettingsListPanel
              items={createMockItems()}
              maxItemsToShow={8}
              onItemToggle={mockOnItemToggle}
              onEditCommit={mockOnEditCommit}
              onItemClear={mockOnItemClear}
              onClose={mockOnClose}
              onActiveKeyChange={onActiveKeyChange}
            />
          </DialogContextHarness>,
        );
      });
      await waitUntilReady();
      expect(onActiveKeyChange).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('rendering', () => {
    it('should render the dialog with items', async () => {
      const { lastFrame, unmount } = await renderDialog();
      expect(lastFrame()).toContain('Boolean Setting');
      unmount();
    });

    it('should render all items', async () => {
      const { lastFrame, unmount } = await renderDialog();
      const frame = lastFrame();

      expect(frame).toContain('Boolean Setting');
      expect(frame).toContain('String Setting');
      expect(frame).toContain('Number Setting');
      expect(frame).toContain('Enum Setting');
      unmount();
    });

    it('keeps the search frame at three rows before the first setting', async () => {
      const { lastFrame, unmount } = await renderDialog();
      const lines = lastFrame().split('\n');
      const borderRows = lines
        .map((line, index) => (line.includes('─') ? index : -1))
        .filter((index) => index >= 0);
      const firstSettingRow = lines.findIndex((line) =>
        line.includes('Boolean Setting'),
      );

      expect(borderRows).toEqual([0, 2]);
      expect(firstSettingRow).toBe(3);
      expect(lastFrame()).not.toMatch(/[▀▄]/);
      unmount();
    });

    it('does not render legacy inline help text outside its parent dialog', async () => {
      const { lastFrame, unmount } = await renderDialog();
      const frame = lastFrame();

      expect(frame).not.toContain('Enter select');
      expect(frame).not.toContain('Ctrl+L reset');
      expect(frame).not.toContain('Esc close');
      unmount();
    });

    it('should render footer content when provided', async () => {
      const { lastFrame, unmount } = await renderDialog({
        footer: {
          content: <Text>Custom Footer</Text>,
          height: 1,
        },
      });

      expect(lastFrame()).toContain('Custom Footer');
      unmount();
    });

    it('right-aligns display values with focused suffixes and selected labels', async () => {
      const items: SettingsDialogItem[] = [
        {
          key: 'auto',
          label: 'Auto',
          description:
            'Smartly select the optimal model, balancing performance and cost',
          displayValue: '1.00x Credit',
          type: 'enum',
        },
        {
          key: 'performance',
          label: 'Performance',
          description: 'Advanced reasoning with high output quality',
          displayValue: '1.10x Credit',
          focusedSuffix: '(medium effort · 272K)',
          type: 'enum',
        },
        {
          key: 'efficient',
          label: 'Efficient ✓',
          description: 'Standard reasoning at low cost',
          displayValue: '0.30x Credit',
          type: 'enum',
        },
      ];
      const { lastFrame, unmount } = await renderDialog({
        items,
        searchEnabled: false,
        initialActiveKey: 'performance',
        maxItemsToShow: 3,
      });

      const lines = lastFrame().split('\n');
      const creditColumns = [
        '1.00x Credit',
        '1.10x Credit',
        '0.30x Credit',
      ].map((value) => {
        const line = lines.find((candidate) => candidate.includes(value));
        expect(line).toBeDefined();
        return getCachedStringWidth(line!.slice(0, line!.indexOf(value)));
      });
      expect(new Set(creditColumns).size).toBe(1);
      unmount();
    });

    it('does not duplicate the leading zero for a focused zero credit value', async () => {
      const { lastFrame, unmount } = await renderDialog({
        items: [
          {
            key: 'lite',
            label: 'Lite',
            description:
              'Basic reasoning available on Free (may be slower during peak hours)',
            displayValue: '0.00x Credit',
            type: 'enum',
          },
        ],
        searchEnabled: false,
        initialActiveKey: 'lite',
        maxItemsToShow: 1,
      });

      const liteLine = lastFrame()
        .split('\n')
        .find((line) => line.includes('Lite'));
      expect(liteLine).toContain('0.00x Credit');
      expect(liteLine).not.toContain('00.00x Credit');
      unmount();
    });
  });

  describe('keyboard navigation', () => {
    it('should close dialog on Escape', async () => {
      const { stdin, waitUntilReady, unmount } = await renderDialog();

      await act(async () => {
        stdin.write(TerminalKeys.ESCAPE);
      });
      // Escape key has a 50ms timeout in KeypressContext, so we need to wrap waitUntilReady in act
      await act(async () => {
        await waitUntilReady();
      });

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
      unmount();
    });

    it('should navigate down with arrow key', async () => {
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderDialog();

      // Initially first item is active (indicated by bullet point)
      const initialFrame = lastFrame();
      expect(initialFrame).toContain('Boolean Setting');

      // Press down arrow
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      // Navigation should move to next item
      await waitFor(() => {
        const frame = lastFrame();
        // The active indicator should now be on a different row
        expect(frame).toContain('String Setting');
      });
      unmount();
    });

    it('should navigate up with arrow key', async () => {
      const { stdin, waitUntilReady, unmount } = await renderDialog();

      // Press down then up
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      await act(async () => {
        stdin.write(TerminalKeys.UP_ARROW);
      });
      await waitUntilReady();

      // Should be back at first item
      await waitFor(() => {
        // First item should be active again
        expect(mockOnClose).not.toHaveBeenCalled();
      });
      unmount();
    });

    it('should wrap around when navigating past last item', async () => {
      const items = createMockItems(2); // Only 2 items
      const { stdin, waitUntilReady, unmount } = await renderDialog({ items });

      // Press down twice to go past the last item
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      // Should wrap to first item - verify no crash
      await waitFor(() => {
        expect(mockOnClose).not.toHaveBeenCalled();
      });
      unmount();
    });

    it('should wrap around when navigating before first item', async () => {
      const { stdin, waitUntilReady, unmount } = await renderDialog();

      // Press up at first item
      await act(async () => {
        stdin.write(TerminalKeys.UP_ARROW);
      });
      await waitUntilReady();

      // Should wrap to last item - verify no crash
      await waitFor(() => {
        expect(mockOnClose).not.toHaveBeenCalled();
      });
      unmount();
    });
  });

  describe('scrolling and resizing list (search filtering)', () => {
    // TODO(pre-existing): rerender produces garbled terminal output in test
    // environment. Needs a fix in the test infrastructure (double-act wrapping
    // or terminal buffer clearing on rerender).
    it.todo(
      'should preserve focus on the active item if it remains in the filtered list',
    );

    it('should reset focus to the top if the active item is filtered out', async () => {
      const items = createMockItems(5);
      const { rerender, stdin, waitUntilReady, unmount } = await renderDialog({
        items,
        maxItemsToShow: 5,
      });

      // Move focus down to item 2 ("Number Setting")
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      // Rerender with a filtered list that EXCLUDES "Number Setting".
      // Use a delay instead of waitUntilReady/waitFor(lastFrame) — rerender
      // causes xterm/Ink frame mismatch (see TODO comment above).
      const filteredItems = [items[0], items[1]];
      await act(async () => {
        rerender(
          <DialogContextHarness>
            <SettingsListPanel
              items={filteredItems}
              maxItemsToShow={5}
              onItemToggle={mockOnItemToggle}
              onEditCommit={mockOnEditCommit}
              onItemClear={mockOnItemClear}
              onClose={mockOnClose}
            />
          </DialogContextHarness>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      // Press Enter. Since focus reset to index 0 ("Boolean Setting"), it should toggle.
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });

      await waitFor(() => {
        expect(mockOnItemToggle).toHaveBeenCalledWith(
          'boolean-setting',
          expect.anything(),
        );
      });
      unmount();
    });
  });

  describe('item interactions', () => {
    it('should call onItemToggle for boolean items on Enter', async () => {
      const { stdin, waitUntilReady, unmount } = await renderDialog();

      // Press Enter on first item (boolean)
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(mockOnItemToggle).toHaveBeenCalledWith(
          'boolean-setting',
          expect.objectContaining({ type: 'boolean' }),
        );
      });
      unmount();
    });

    it('should call onItemToggle for enum items on Enter', async () => {
      const items = createMockItems(4);
      // Move enum to first position
      const enumItem = items.find((i) => i.type === 'enum')!;
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [enumItem],
      });

      // Press Enter on enum item
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(mockOnItemToggle).toHaveBeenCalledWith(
          'enum-setting',
          expect.objectContaining({ type: 'enum' }),
        );
      });
      unmount();
    });

    it('should enter edit mode for string items on Enter', async () => {
      const items = createMockItems(4);
      const stringItem = items.find((i) => i.type === 'string')!;
      const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog({
        items: [stringItem],
      });

      // Press Enter to start editing
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Should show the edit buffer with cursor
      await waitFor(() => {
        const frame = lastFrame();
        // In edit mode, the value should be displayed (possibly with cursor)
        expect(frame).toContain('test-value');
      });
      unmount();
    });

    it('should enter edit mode for number items on Enter', async () => {
      const items = createMockItems(4);
      const numberItem = items.find((i) => i.type === 'number')!;
      const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog({
        items: [numberItem],
      });

      // Press Enter to start editing
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Should show the edit buffer
      await waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('42');
      });
      unmount();
    });

    it('should call onItemClear on Ctrl+L', async () => {
      const { stdin, waitUntilReady, unmount } = await renderDialog();

      // Press Ctrl+L to reset
      await act(async () => {
        stdin.write(TerminalKeys.CTRL_L);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(mockOnItemClear).toHaveBeenCalledWith(
          'boolean-setting',
          expect.objectContaining({ type: 'boolean' }),
        );
      });
      unmount();
    });
  });

  describe('edit mode', () => {
    it('should prioritize editValue over rawValue stringification', async () => {
      const objectItem: SettingsDialogItem = {
        key: 'object-setting',
        label: 'Object Setting',
        description: 'A complex object setting',
        displayValue: '{"foo":"bar"}',
        type: 'object',
        rawValue: { foo: 'bar' },
        editValue: '{"foo":"bar"}',
      };
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [objectItem],
      });

      // Enter edit mode
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Commit immediately
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });

      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalledWith(
          'object-setting',
          '{"foo":"bar"}',
          expect.objectContaining({ type: 'object' }),
        );
      });
      unmount();
    });

    it('should commit edit on Enter', async () => {
      const items = createMockItems(4);
      const stringItem = items.find((i) => i.type === 'string')!;
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [stringItem],
      });

      // Enter edit mode
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Type some characters — use delay instead of waitUntilReady because
      // TextInput cursor ANSI sequences cause xterm/Ink frame mismatch.
      await act(async () => {
        stdin.write('x');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Commit with Enter
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });

      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalledWith(
          'string-setting',
          'test-valuex',
          expect.objectContaining({ type: 'string' }),
        );
      });
      unmount();
    });

    it('should keep editing and block navigation when commit fails', async () => {
      const items = createMockItems(4);
      const stringItem = items.find((i) => i.type === 'string')!;
      const numberItem = items.find((i) => i.type === 'number')!;
      const onActiveKeyChange = vi.fn();
      mockOnEditCommit.mockReturnValue(false);
      const {
        stdin,
        capturedRegistry,
        waitUntilReady,
        unmount,
      } = await renderDialog({
        items: [stringItem, numberItem],
        onActiveKeyChange,
      });

      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('x');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      expect(mockOnEditCommit).toHaveBeenLastCalledWith(
        'string-setting',
        'test-valuex',
        expect.objectContaining({ type: 'string' }),
      );
      expect(onActiveKeyChange).toHaveBeenLastCalledWith('string-setting');

      const tabConsumed = capturedRegistry?.invokeAction(
        'Dialog',
        'dialog:tab:next',
        {
          name: 'tab',
          sequence: TerminalKeys.TAB,
          shift: false,
          alt: false,
          ctrl: false,
          cmd: false,
          insertable: false,
        },
      );
      expect(tabConsumed).toBe(true);
      expect(mockOnEditCommit).toHaveBeenCalledTimes(2);

      unmount();
    });

    it('should commit edit on Escape', async () => {
      const items = createMockItems(4);
      const stringItem = items.find((i) => i.type === 'string')!;
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [stringItem],
      });

      // Enter edit mode
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Commit with Escape
      await act(async () => {
        stdin.write(TerminalKeys.ESCAPE);
      });
      // Escape key has a 50ms timeout in KeypressContext, so we need to wrap waitUntilReady in act
      await act(async () => {
        await waitUntilReady();
      });

      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalled();
      });
      unmount();
    });

    it('should commit edit and navigate on Down arrow', async () => {
      const items = createMockItems(4);
      const stringItem = items.find((i) => i.type === 'string')!;
      const numberItem = items.find((i) => i.type === 'number')!;
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [stringItem, numberItem],
      });

      // Enter edit mode
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Press Down to commit and navigate
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalled();
      });
      unmount();
    });

    it('should commit edit and navigate on Up arrow', async () => {
      const items = createMockItems(4);
      const stringItem = items.find((i) => i.type === 'string')!;
      const numberItem = items.find((i) => i.type === 'number')!;
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [stringItem, numberItem],
      });

      // Navigate to second item
      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      // Enter edit mode
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      // In edit mode, TextInput cursor ANSI can cause frame mismatch.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Press Up to commit and navigate
      await act(async () => {
        stdin.write(TerminalKeys.UP_ARROW);
      });

      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalled();
      });
      unmount();
    });

    it('should allow number input for number fields', async () => {
      const items = createMockItems(4);
      const numberItem = items.find((i) => i.type === 'number')!;
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [numberItem],
      });

      // Enter edit mode
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Type numbers one at a time — use delay instead of waitUntilReady because
      // TextInput cursor ANSI sequences cause xterm/Ink frame mismatch.
      for (const ch of ['1', '2', '3']) {
        await act(async () => {
          stdin.write(ch);
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
      }

      // Commit
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });

      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalledWith(
          'number-setting',
          '42123',
          expect.objectContaining({ type: 'number' }),
        );
      });
      unmount();
    });

    it('should support quick number entry for number fields', async () => {
      const items = createMockItems(4);
      const numberItem = items.find((i) => i.type === 'number')!;
      const { stdin, unmount } = await renderDialog({
        items: [numberItem],
      });

      // Type a number directly (without Enter first) — use delay instead of
      // waitUntilReady because TextInput cursor ANSI sequences cause frame mismatch.
      await act(async () => {
        stdin.write('5');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Commit with Enter
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });

      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalledWith(
          'number-setting',
          '5',
          expect.objectContaining({ type: 'number' }),
        );
      });
      unmount();
    });

    it('should allow j and k characters to be typed in string edit fields without triggering navigation', async () => {
      const items = createMockItems(4);
      const stringItem = items.find((i) => i.type === 'string')!;
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        items: [stringItem],
      });

      // Enter edit mode
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Type 'j' and 'k' — use delay instead of waitUntilReady because
      // TextInput cursor ANSI sequences cause xterm/Ink frame mismatch.
      await act(async () => {
        stdin.write('j');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      await act(async () => {
        stdin.write('k');
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Commit with Enter
      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });

      // j and k should be typed into the field
      await waitFor(() => {
        expect(mockOnEditCommit).toHaveBeenCalledWith(
          'string-setting',
          'test-valuejk', // entered value + j and k
          expect.objectContaining({ type: 'string' }),
        );
      });
      unmount();
    });
  });

  describe("searchTrigger: 'slash'", () => {
    const renderSlashPanel = async (props: Partial<SettingsListPanelProps> = {}) =>
      renderDialog({ searchTrigger: 'slash', ...props });

    it('leaves printable keys to the caller until / opens the filter', async () => {
      const onKeyPress = vi.fn().mockReturnValue(true);
      const { stdin, waitUntilReady, unmount } = await renderSlashPanel({
        onKeyPress,
      });

      await act(async () => {
        stdin.write('s');
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(onKeyPress).toHaveBeenCalled();
      });
      expect(onKeyPress.mock.calls[0][0]).toMatchObject({ sequence: 's' });
      unmount();
    });

    it('hands printable keys to the filter once / opens it', async () => {
      const onKeyPress = vi.fn().mockReturnValue(true);
      const onSearchStateChange = vi.fn();
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderSlashPanel({ onKeyPress, onSearchStateChange });

      await act(async () => {
        stdin.write('/');
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(onSearchStateChange).toHaveBeenCalledWith(
          expect.objectContaining({ active: true }),
        );
      });

      onKeyPress.mockClear();
      await act(async () => {
        stdin.write('Boolean');
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(onKeyPress).not.toHaveBeenCalled();
      await waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('Boolean Setting');
        expect(frame).not.toContain('String Setting');
      });
      unmount();
    });

    it('cancels the filter on Escape without closing, restoring the full list', async () => {
      const onSearchStateChange = vi.fn();
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderSlashPanel({ onSearchStateChange });

      await act(async () => {
        stdin.write('/');
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('Number');
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      await waitFor(() => {
        expect(lastFrame()).not.toContain('Boolean Setting');
      });

      await act(async () => {
        stdin.write(TerminalKeys.ESCAPE);
      });
      await waitUntilReady();

      // The dialog stays open and the full list is back...
      expect(mockOnClose).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(lastFrame()).toContain('Boolean Setting');
      });
      expect(onSearchStateChange).toHaveBeenLastCalledWith({
        active: false,
        hasQuery: false,
      });

      // ...and because typing never moved the anchor, the arrow returns to the
      // row that was focused before the filter, not to the filtered match.
      expect(lastFrame()).toContain('❯ Boolean Setting');

      // A second Escape closes, since the filter is no longer open.
      await act(async () => {
        stdin.write(TerminalKeys.ESCAPE);
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
      unmount();
    });

    it('keeps the highlight anchored while typing', async () => {
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderSlashPanel();

      await act(async () => {
        stdin.write('/');
      });
      await waitUntilReady();
      // "Setting" matches every row, so the list is unchanged — only the
      // anchor's behavior is under test.
      await act(async () => {
        stdin.write('Setting');
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });

      // Typing filtered without dragging the arrow anywhere.
      expect(lastFrame()).toContain('❯ Boolean Setting');
      unmount();
    });

    it('keeps the filter applied after the arrows blur the box', async () => {
      const onSearchStateChange = vi.fn();
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderSlashPanel({ onSearchStateChange });

      await act(async () => {
        stdin.write('/');
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('Number');
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      await waitFor(() => {
        expect(lastFrame()).not.toContain('Boolean Setting');
      });

      await act(async () => {
        stdin.write(TerminalKeys.DOWN_ARROW);
      });
      await waitUntilReady();

      // Focus left the box; the filter did not leave with it.
      await waitFor(() => {
        expect(onSearchStateChange).toHaveBeenLastCalledWith({
          active: false,
          hasQuery: true,
        });
      });
      expect(lastFrame()).toContain('Number Setting');
      expect(lastFrame()).not.toContain('Boolean Setting');
      unmount();
    });

    it('blurs on Enter even when the filter matches nothing', async () => {
      const onSearchStateChange = vi.fn();
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderSlashPanel({ onSearchStateChange });

      await act(async () => {
        stdin.write('/');
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('zzzz');
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
      await waitFor(() => {
        expect(lastFrame()).toContain('No matches found.');
      });

      await act(async () => {
        stdin.write(TerminalKeys.ENTER);
      });
      await waitUntilReady();

      // Enter must not be swallowed by the "no current item" guard, or the
      // user is stuck in a search box with nothing to select.
      await waitFor(() => {
        expect(onSearchStateChange).toHaveBeenLastCalledWith({
          active: false,
          hasQuery: true,
        });
      });
      expect(mockOnItemToggle).not.toHaveBeenCalled();
      unmount();
    });

    it('does not claim bare c for toggling', async () => {
      const { stdin, waitUntilReady, unmount } = await renderSlashPanel();

      await act(async () => {
        stdin.write('c');
      });
      await waitUntilReady();

      expect(mockOnItemToggle).not.toHaveBeenCalled();
      unmount();
    });

    it('reports the filter as closed when the panel goes away', async () => {
      const onSearchStateChange = vi.fn();
      const { stdin, waitUntilReady, unmount } = await renderSlashPanel({
        onSearchStateChange,
      });

      await act(async () => {
        stdin.write('/');
      });
      await waitUntilReady();
      await waitFor(() => {
        expect(onSearchStateChange).toHaveBeenCalledWith(
          expect.objectContaining({ active: true }),
        );
      });

      await act(async () => {
        unmount();
      });

      expect(onSearchStateChange).toHaveBeenLastCalledWith({
        active: false,
        hasQuery: false,
      });
    });
  });

  describe('custom key handling', () => {
    it('should call onKeyPress and respect its return value', async () => {
      const customKeyHandler = vi.fn().mockReturnValue(true);
      const { stdin, waitUntilReady, unmount } = await renderDialog({
        onKeyPress: customKeyHandler,
      });

      // Press a key
      await act(async () => {
        stdin.write('r');
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(customKeyHandler).toHaveBeenCalled();
      });

      // Since handler returned true, default behavior should be blocked
      expect(mockOnClose).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('focus management', () => {
    it('should keep focus on settings when Tab is pressed', async () => {
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderDialog();

      // Press Tab - should not crash and first item should remain focused
      await act(async () => {
        stdin.write(TerminalKeys.TAB);
      });
      await waitUntilReady();

      await waitFor(() => {
        // Should still show first item as focused with ❯ indicator
        expect(lastFrame()).toContain('❯');
        expect(lastFrame()).toContain('Boolean Setting');
      });
      unmount();
    });
  });

  describe('responsiveness', () => {
    it('should not collapse visible item rows when minItemSlots is too small', async () => {
      const items: SettingsDialogItem[] = [
        ...createMockItems(4),
        {
          key: 'cm-mcp',
          label: 'cm-mcp',
          description: 'https://mcp.example.com/mcp',
          displayValue: '○ needs authentication',
          rawValue: true,
          type: 'boolean',
        },
      ];
      const { lastFrame, unmount } = await renderDialog({
        availableHeight: 20,
        items,
        maxItemsToShow: 8,
        minItemSlots: 4,
        itemHeight: 3,
        initialActiveKey: 'cm-mcp',
      });

      const statusRow = lastFrame()
        .split('\n')
        .find((line) => line.includes('needs authentication'));
      expect(statusRow).toContain('cm-mcp');
      unmount();
    });

    it('should reduce the number of visible items based on height', async () => {
      // Compact layout: search disabled
      // fixedHeight = SEARCH(0) + SCROLL_ARROWS(0) + HELP_TEXT(1) = 1
      // availableForItems = 6 - 1 = 5, maxItems = floor(5 / 2) = 2
      const { lastFrame, unmount } = await renderDialog({
        availableHeight: 6,
        searchEnabled: false,
        items: createMockItems(10),
      });

      const frame = lastFrame();
      // Items 0 and 1 should be there
      expect(frame).toContain('Boolean Setting');
      expect(frame).toContain('String Setting');
      // Item 2 should NOT be there
      expect(frame).not.toContain('Number Setting');
      unmount();
    });

    it('should show scroll indicators when list is truncated by height', async () => {
      // Use a small maxItemsToShow so the window is much smaller than the list.
      // With maxItemsToShow=3 and 10 items, we can navigate to see both ▲ and ▼.
      const { lastFrame, stdin, unmount } = await renderDialog({
        availableHeight: 25,
        maxItemsToShow: 3,
        items: createMockItems(10),
      });

      // Initially at top — only ▼ (scroll-down) indicator is visible
      let frame = lastFrame();
      expect(frame).toContain('▼');
      expect(frame).not.toContain('▲');

      // Navigate down to shift the window and trigger ▲ (scroll-up).
      // Use delay instead of waitUntilReady — large item lists with scroll
      // indicators can cause xterm/Ink frame mismatch.
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          stdin.write(TerminalKeys.DOWN_ARROW);
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
      }

      await waitFor(() => {
        frame = lastFrame();
        // Now ▲ should be visible (window has shifted past the first item)
        expect(frame).toContain('▲');
      });
      unmount();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Tests for added SLP behaviors:
  //   1. defaultFilter matches item.description (was: label + displayValue only)
  //   2. label/displayValue matches sort above description-only matches
  //   3. resetToKey() snaps activeIndex to first filtered item on search-text change
  //   4. internal search buffer auto-clears when items-key fingerprint changes
  //      (i.e. tab switch in consumers like ModelSelector / SkillBrowser)
  //   5. highlightText() wraps matched substring with chalk.bgYellow.black()
  //      — blocked: ink-testing-library strips ANSI from lastFrame()
  // ──────────────────────────────────────────────────────────────────────
  describe('search filtering and sorting (added behaviors)', () => {
    const typeIntoSearch = async (
      stdin: { write: (s: string) => void },
      text: string,
    ) => {
      for (const ch of text) {
        await act(async () => {
          stdin.write(ch);
        });
      }
      // Allow the search buffer's internal debounce / setState to flush.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });
    };

    it('default filter should match item.description (not just label)', async () => {
      // item-a is identifiable ONLY by a unique word in description.
      // If defaultFilter ignored description, this item would be filtered out.
      const items: SettingsDialogItem[] = [
        {
          key: 'item-a',
          label: 'Alpha',
          description: 'contains the unique word zebra',
          displayValue: 'a',
          type: 'boolean',
          rawValue: false,
        },
        {
          key: 'item-b',
          label: 'Beta',
          description: 'plain text',
          displayValue: 'b',
          type: 'boolean',
          rawValue: false,
        },
      ];
      const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog({
        items,
      });

      await typeIntoSearch(stdin, 'zebra');
      await waitUntilReady();

      const frame = lastFrame() ?? '';
      expect(frame).toContain('Alpha');
      expect(frame).not.toContain('Beta');
      unmount();
    });

    it('label matches should rank above description-only matches', async () => {
      // Both items match "perform":
      //   - "Auto" matches via description ("balancing perform and cost")
      //   - "Performance" matches via label
      // The label-priority partition in filteredItems should put Performance first.
      const items: SettingsDialogItem[] = [
        {
          key: 'auto-mode',
          label: 'Auto',
          description: 'balancing perform and cost',
          displayValue: 'auto',
          type: 'boolean',
          rawValue: false,
        },
        {
          key: 'perf-mode',
          label: 'Performance',
          description: 'fast mode',
          displayValue: 'perf',
          type: 'boolean',
          rawValue: false,
        },
      ];
      const { lastFrame, stdin, waitUntilReady, unmount } = await renderDialog({
        items,
      });

      await typeIntoSearch(stdin, 'perform');
      await waitUntilReady();

      const frame = lastFrame() ?? '';
      const idxPerf = frame.indexOf('Performance');
      const idxAuto = frame.indexOf('Auto');
      expect(idxPerf).toBeGreaterThanOrEqual(0);
      expect(idxAuto).toBeGreaterThanOrEqual(0);
      // Label match should appear before description-only match.
      expect(idxPerf).toBeLessThan(idxAuto);
      unmount();
    });

    it('arrow should auto-focus first filtered item when search text changes', async () => {
      // Initially active = auto-mode (first item). After typing "perform",
      // filtered list is [Performance (label match), Auto (description-only)]
      // and resetToKey snaps activeIndex to perf-mode. The active-row pointer
      // (figures.pointer = ❯) should appear next to "Performance", NOT "Auto".
      const items: SettingsDialogItem[] = [
        {
          key: 'auto-mode',
          label: 'Auto',
          description: 'balancing perform and cost',
          displayValue: 'auto',
          type: 'boolean',
          rawValue: false,
        },
        {
          key: 'perf-mode',
          label: 'Performance',
          description: 'fast mode',
          displayValue: 'perf',
          type: 'boolean',
          rawValue: false,
        },
      ];
      const { lastFrame, stdin, unmount } = await renderDialog({ items });

      await typeIntoSearch(stdin, 'perform');

      await waitFor(() => {
        const frame = lastFrame() ?? '';
        // Active-row pointer should be on Performance, not Auto.
        expect(frame).toMatch(/❯\s+Performance/);
        expect(frame).not.toMatch(/❯\s+Auto/);
      });
      unmount();
    });

    it('internal search should auto-clear when items source changes (tab switch)', async () => {
      // Simulates a parent component swapping its items source (e.g. tab
      // switch in ModelSelector / SkillBrowser). The items-key fingerprint
      // changes, so SLP's effect clears the internal search buffer and
      // both new items become visible without leftover filtering.
      const itemsTabA: SettingsDialogItem[] = [
        {
          key: 'a-only',
          label: 'AlphaItem',
          description: '',
          displayValue: 'a',
          type: 'boolean',
          rawValue: false,
        },
        {
          key: 'a-other',
          label: 'OmegaItem',
          description: '',
          displayValue: 'b',
          type: 'boolean',
          rawValue: false,
        },
      ];
      const itemsTabB: SettingsDialogItem[] = [
        {
          key: 'b-1',
          label: 'BravoItem',
          description: '',
          displayValue: 'x',
          type: 'boolean',
          rawValue: false,
        },
        {
          key: 'b-2',
          label: 'CharlieItem',
          description: '',
          displayValue: 'y',
          type: 'boolean',
          rawValue: false,
        },
      ];

      const { lastFrame, stdin, rerender, unmount } = await renderDialog({
        items: itemsTabA,
      });

      // Filter to only AlphaItem
      await typeIntoSearch(stdin, 'alpha');

      await waitFor(() => {
        const frame = lastFrame() ?? '';
        expect(frame).toContain('AlphaItem');
        expect(frame).not.toContain('OmegaItem');
      });

      // Tab switch: rerender with a fresh items source (different keys)
      await act(async () => {
        rerender(
          <DialogContextHarness>
            <SettingsListPanel
              items={itemsTabB}
              maxItemsToShow={8}
              onItemToggle={mockOnItemToggle}
              onEditCommit={mockOnEditCommit}
              onItemClear={mockOnItemClear}
              onClose={mockOnClose}
            />
          </DialogContextHarness>,
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100));
      });

      await waitFor(() => {
        const frame = lastFrame() ?? '';
        // Both new items should be visible — search was auto-cleared.
        expect(frame).toContain('BravoItem');
        expect(frame).toContain('CharlieItem');
      });
      unmount();
    });

    // Direct unit tests for highlightText — ink-testing-library's lastFrame()
    // strips ANSI escape codes, so component-level assertions can't verify
    // the yellow-background wrapping. chalk.bgYellow uses ANSI code 43
    // (\u001b[43m open, \u001b[49m close).
    describe('highlightText (label & description highlighting)', () => {
      const BG_YELLOW_OPEN = '\u001b[43m';
      const BG_YELLOW_CLOSE = '\u001b[49m';

      // Vitest runs in a non-TTY environment where chalk auto-detects
      // color support as 0 (no colors), so chalk.bgYellow.black(x) emits
      // plain text. Force basic ANSI support for these tests to verify the
      // real wrapping behavior. Restore afterwards to avoid leaking state
      // into other tests in this file.
      let prevChalkLevel: 0 | 1 | 2 | 3;
      beforeEach(() => {
        prevChalkLevel = chalk.level;
        chalk.level = 1;
      });
      afterEach(() => {
        chalk.level = prevChalkLevel;
      });

      it('should wrap matching substring with chalk.bgYellow markers', () => {
        const out = highlightText('Performance', 'perform');
        expect(out).toContain(BG_YELLOW_OPEN);
        expect(out).toContain(BG_YELLOW_CLOSE);
        // The matched slice preserves original casing.
        expect(out).toContain('Perform');
        // Non-matched suffix is emitted as-is.
        expect(out).toContain('ance');
      });

      it('should highlight matches inside a typical label string', () => {
        // Simulates SLP calling highlightText(item.label, query) for a
        // model-picker row like "GPT-4 Turbo".
        const out = highlightText('GPT-4 Turbo', 'turbo');
        expect(out).toContain(BG_YELLOW_OPEN);
        expect(out).toContain('Turbo');
        expect(out).toContain('GPT-4 ');
      });

      it('should highlight matches inside a typical description string', () => {
        // Simulates SLP calling highlightText(item.description, query) for a
        // model-picker row whose description reads
        // "balancing performance and cost".
        const out = highlightText('balancing performance and cost', 'perform');
        expect(out).toContain(BG_YELLOW_OPEN);
        expect(out).toContain('perform');
        expect(out).toContain('balancing ');
        expect(out).toContain('ance and cost');
      });

      it('should be case-insensitive but preserve original casing in output', () => {
        const out = highlightText('Performance', 'PERFORM');
        expect(out).toContain(BG_YELLOW_OPEN);
        // Original "Perform" (mixed case) is preserved, NOT the query casing.
        expect(out).toContain('Perform');
        expect(out).not.toContain('PERFORM');
      });

      it('should highlight multiple non-overlapping occurrences', () => {
        const out = highlightText('foo bar foo', 'foo');
        // Two open markers → two highlighted spans.
        // Use split() instead of regex to avoid the no-control-regex lint
        // rule tripping on \u001b in regex literals.
        const openCount = out.split(BG_YELLOW_OPEN).length - 1;
        expect(openCount).toBe(2);
      });

      it('should return the original text unchanged when query is empty', () => {
        expect(highlightText('Performance', '')).toBe('Performance');
      });

      it('should return the original text unchanged when text is empty', () => {
        expect(highlightText('', 'perform')).toBe('');
      });

      it('should return the original text unchanged when query does not match', () => {
        const input = 'Performance';
        const out = highlightText(input, 'zzz');
        expect(out).toBe(input);
        expect(out).not.toContain(BG_YELLOW_OPEN);
      });
    });
  });
});
