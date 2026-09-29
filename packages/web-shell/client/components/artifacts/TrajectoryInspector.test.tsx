// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type {
  TrajectoryRequestRow,
  TrajectoryToolRow,
} from '../../trajectory/types';
import { TrajectoryInspector } from './TrajectoryInspector';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounts) unmount();
  mounts.length = 0;
});

function tool(rawInput: unknown, rawOutput: unknown): TrajectoryToolRow {
  return {
    kind: 'tool',
    key: 'tool:1',
    turnIndex: 1,
    depth: 0,
    block: {
      kind: 'tool',
      id: 'b1',
      toolCallId: 'call_1',
      title: 'Run',
      toolName: 'Bash',
      status: 'completed',
      preview: {},
      rawInput,
      rawOutput,
    } as TrajectoryToolRow['block'],
  };
}

async function render(row: TrajectoryRequestRow | TrajectoryToolRow) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <TrajectoryInspector
          row={row}
          title="Record"
          hiddenByRange={false}
          onClearRange={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    ),
  );
  return container;
}

async function click(container: HTMLElement, name: string) {
  const button = [...container.querySelectorAll('button')].find(
    (item) => item.textContent === name,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it('shows measured request fields without adding cached tokens twice', async () => {
  const row: TrajectoryRequestRow = {
    kind: 'request',
    key: 'req:1',
    turnIndex: 1,
    depth: 0,
    status: 'ok',
    model: 'qwen-test',
    timing: { durationMs: 1000, startedAt: 1_760_000_000_000, ttftMs: 250 },
    usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
  };
  const container = await render(row);
  await click(container, 'Metrics');
  expect(container.textContent).toContain('750ms');
  expect(container.textContent).toContain('100');
  expect(container.textContent).toContain('40');
  expect(container.textContent).not.toContain('140');
});

it('keeps explicit null output and preserves input whitespace when copied', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const container = await render(tool('  echo ok\n', null));
  await click(container, 'Output');
  expect(container.querySelector('pre')?.textContent).toBe('null');
  await click(container, 'Input');
  expect(container.querySelector('pre')?.textContent).toBe('  echo ok\n');
  await click(container, 'Copy displayed content');
  expect(writeText).toHaveBeenCalledWith('  echo ok\n');
});

it('bounds a long value before putting it in the DOM', async () => {
  const container = await render(tool('x'.repeat(100_000), undefined));
  await click(container, 'Input');
  expect(container.querySelector('pre')?.textContent).toHaveLength(4_000);
  expect(container.textContent).toContain('Content truncated');
  await click(container, 'Show more');
  expect(container.querySelector('pre')?.textContent).toHaveLength(40_000);
});

it.each([
  [null, 'null'],
  [false, 'false'],
  [0, '0'],
  ['', ''],
  [[], '[]'],
])('keeps an explicitly recorded output value %#', async (value, expected) => {
  const container = await render(tool(undefined, value));
  await click(container, 'Output');
  expect(container.querySelector('pre')?.textContent).toBe(expected);
});
