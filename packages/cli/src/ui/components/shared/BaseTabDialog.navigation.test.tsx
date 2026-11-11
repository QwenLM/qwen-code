/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it } from 'vitest';
import { act, useState } from 'react';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import { cleanup, renderWithProviders } from '../../../test-utils/render.js';
import { BaseTabDialog } from './BaseTabDialog.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
afterEach(cleanup);

function readTerminalHistory(
  result: Awaited<ReturnType<typeof renderWithProviders>>,
) {
  const buffer = result.terminal.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? '',
  );
}

it.each([true, false])(
  '切换较矮页签时按开关保留高度，滚屏头部不重复（equalize=%s）',
  async (equalizeTabHeight) => {
    let root: DOMElement | null = null;
    function Fixture() {
      const [active, setActive] = useState('default');
      return (
        <Box
          flexDirection="column"
          ref={(node: DOMElement | null) => {
            root = node;
          }}
        >
          <Box height={8} flexShrink={0}>
            <Text>Qwen CLI welcome header</Text>
          </Box>
          <BaseTabDialog
            tabs={[
              { key: 'default', label: 'Default' },
              { key: 'custom', label: 'Custom' },
            ]}
            activeKey={active}
            onTabChange={setActive}
            equalizeTabHeight={equalizeTabHeight}
            footer="Tab switch"
            footerMinHeight={2}
          >
            <Box height={active === 'default' ? 8 : 2} flexShrink={0}>
              <Text>Current page: {active}</Text>
            </Box>
          </BaseTabDialog>
        </Box>
      );
    }
    const result = await renderWithProviders(<Fixture />, { width: 80 });
    act(() => {
      result.terminal.resize(80, 18);
      result.stdout.emit('resize');
    });
    await result.settleLayout();
    const initialHeight = measureElement(root!).height;
    expect(initialHeight).toBeGreaterThan(18);

    for (let index = 0; index < 6; index++) {
      act(() => result.stdin.write('\t'));
      await result.settleLayout();
      const custom = index % 2 === 0;
      expect(result.lastFrame()).toContain(
        `Current page: ${custom ? 'custom' : 'default'}`,
      );
      expect(measureElement(root!).height).toBe(
        equalizeTabHeight || !custom ? initialHeight : initialHeight - 6,
      );
    }
    const headers = readTerminalHistory(result).filter(
      (line) => line === 'Qwen CLI welcome header',
    );
    if (equalizeTabHeight) expect(headers).toHaveLength(1);
    else expect(headers.length).toBeGreaterThan(1);
  },
);

it.each([true, false])(
  '动态内容增高后保留新高度，终端缩放后重新测量（equalize=%s）',
  async (equalizeTabHeight) => {
    let root: DOMElement | null = null;
    let setHeight!: (height: number) => void;
    function Fixture() {
      const [height, updateHeight] = useState(2);
      const { columns } = useTerminalSize();
      setHeight = updateHeight;
      return (
        <Box
          width={columns}
          flexDirection="column"
          ref={(node: DOMElement | null) => {
            root = node;
          }}
        >
          <BaseTabDialog
            tabs={[
              { key: 'default', label: 'Default' },
              { key: 'custom', label: 'Custom' },
            ]}
            activeKey="custom"
            equalizeTabHeight={equalizeTabHeight}
            footer="Tab switch"
          >
            <Box height={height} flexShrink={0} justifyContent="flex-end">
              <Text>Last content row</Text>
            </Box>
          </BaseTabDialog>
        </Box>
      );
    }
    const result = await renderWithProviders(<Fixture />, { width: 80 });
    act(() => {
      result.terminal.resize(80, 40);
      result.stdout.emit('resize');
    });
    await result.settleLayout();
    const initialHeight = measureElement(root!).height;
    act(() => setHeight(10));
    await result.settleLayout();
    expect(measureElement(root!).height).toBe(initialHeight + 8);
    expect(result.lastFrame()).toContain('Last content row');
    act(() => setHeight(2));
    await result.settleLayout();
    expect(measureElement(root!).height).toBe(
      equalizeTabHeight ? initialHeight + 8 : initialHeight,
    );
    expect(result.lastFrame()).toContain('Last content row');

    act(() => {
      result.terminal.resize(60, 30);
      result.stdout.emit('resize');
    });
    await result.settleLayout();
    expect(measureElement(root!).height).toBe(initialHeight);
    expect(result.lastFrame()).toContain('Last content row');
  },
);

it.each([undefined, false])(
  'preserves default wrapping and supports clamped navigation (wrap=%s)',
  async (wrapTabs) => {
    function Fixture() {
      const [active, setActive] = useState('first');
      return (
        <BaseTabDialog
          tabs={[
            { key: 'first', label: 'First' },
            { key: 'last', label: 'Last' },
          ]}
          activeKey={active}
          onTabChange={setActive}
          wrapTabs={wrapTabs}
        >
          <Text>Current page: {active}</Text>
        </BaseTabDialog>
      );
    }
    const result = await renderWithProviders(<Fixture />, { width: 80 });
    await result.waitUntilReady();
    act(() => result.stdin.write('\x1b[Z'));
    await result.waitUntilReady();
    expect(result.lastFrame()).toContain(
      `Current page: ${wrapTabs === false ? 'first' : 'last'}`,
    );
    if (wrapTabs === false) {
      // All actions can arrive before React renders; the reducer must enforce the bound.
      act(() => {
        for (let i = 0; i < 4; i++) result.stdin.write('\t');
      });
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('Current page: last');
    }
  },
);
