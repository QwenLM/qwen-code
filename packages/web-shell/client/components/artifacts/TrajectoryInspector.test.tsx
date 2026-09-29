// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { buildTrajectory } from '../../trajectory/buildTrajectory';
import { projectTrajectoryWindow } from '../../trajectory/projectTrajectoryWindow';
import type {
  TrajectoryRequestRow,
  TrajectoryRow,
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

async function mount(row: TrajectoryRow, language: 'en' | 'zh-CN' = 'en') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const update = async (next: TrajectoryRow) => {
    await act(async () =>
      root.render(
        <I18nProvider language={language}>
          <TrajectoryInspector
            row={next}
            title="Record"
            hiddenByRange={false}
            onClearRange={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      ),
    );
  };
  await update(row);
  return { container, update };
}

async function render(row: TrajectoryRow, language: 'en' | 'zh-CN' = 'en') {
  return (await mount(row, language)).container;
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
  expect(writeText).toHaveBeenCalledWith('Recorded input:   echo ok\n');
});

it('formats request dates in the selected UI language', async () => {
  const startedAt = 1_760_000_000_000;
  const row: TrajectoryRequestRow = {
    kind: 'request',
    key: 'req:locale',
    turnIndex: 1,
    depth: 0,
    status: 'ok',
    timing: { durationMs: 1000, startedAt },
  };
  const container = await render(row, 'zh-CN');
  await click(container, '指标');
  expect(container.textContent).toContain(
    new Date(startedAt).toLocaleString('zh-CN'),
  );
});

it('bounds a long value before putting it in the DOM', async () => {
  const container = await render(tool('x'.repeat(100_000), undefined));
  await click(container, 'Input');
  expect(container.querySelector('pre')?.textContent).toHaveLength(4_000);
  expect(container.textContent).toContain('Content truncated');
  await click(container, 'Show more');
  expect(container.querySelector('pre')?.textContent).toHaveLength(40_000);
});

it('shows metadata for a resource-link-only user record after transcript projection', async () => {
  const event = {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'resource_link',
        name: 'design-evidence.pdf',
        uri: 'file:///evidence/design-evidence.pdf',
        mimeType: 'application/pdf',
        size: 0,
        description: 'x'.repeat(100_000),
      },
    },
  } as DaemonEvent;
  const row = buildTrajectory(projectTrajectoryWindow([event])).rows[0];
  expect(row?.kind).toBe('user');
  const container = await render(row!);
  expect(container.textContent).toContain('Resource links');
  expect(container.textContent).toContain('design-evidence.pdf');
  expect(container.textContent).toContain(
    'file:///evidence/design-evidence.pdf',
  );
  expect(container.textContent).toContain('application/pdf');
  expect(container.textContent).toContain('"size": 0');
  expect(container.querySelectorAll('pre')[3]?.textContent).toHaveLength(4_000);
  expect(container.textContent).toContain('Content truncated');
});

it.each(['Input', 'Output'] as const)(
  'keeps the %s tab while moving between tool records',
  async (tab) => {
    const { container, update } = await mount(tool('input A', 'output A'));
    await click(container, tab);
    await update({
      ...tool('input B', 'output B'),
      key: 'tool:2',
    });
    expect(
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === tab)
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(container.querySelector('pre')?.textContent).toBe(
      tab === 'Input' ? 'input B' : 'output B',
    );
  },
);

it('keeps request metrics and resets an incompatible tab to summary', async () => {
  const request: TrajectoryRequestRow = {
    kind: 'request',
    key: 'req:1',
    turnIndex: 1,
    depth: 0,
    status: 'ok',
    timing: { durationMs: 1000 },
  };
  const { container, update } = await mount(request);
  await click(container, 'Metrics');
  await update({ ...request, key: 'req:2', timing: { durationMs: 2000 } });
  expect(
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Metrics')
      ?.getAttribute('aria-pressed'),
  ).toBe('true');
  expect(container.textContent).toContain('2.0s');

  await update(tool('input A', 'output A'));
  await click(container, 'Input');
  await update({ ...request, key: 'req:3' });
  expect(
    container.querySelector('button[aria-pressed="true"]')?.textContent,
  ).toBe('Summary');
  await update({ ...tool('input B', 'output B'), key: 'tool:2' });
  expect(
    container.querySelector('button[aria-pressed="true"]')?.textContent,
  ).toBe('Summary');
});

it('resets expansion and ignores a pending copy when the record changes', async () => {
  let resolveWrite: () => void = () => {};
  const writeText = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveWrite = resolve;
      }),
  );
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  const { container, update } = await mount(tool('a'.repeat(5_000), undefined));
  await click(container, 'Input');
  await click(container, 'Show more');
  await click(container, 'Copy displayed content');
  expect(writeText).toHaveBeenCalledOnce();

  await update({ ...tool('b'.repeat(5_000), undefined), key: 'tool:2' });
  expect(container.querySelector('pre')?.textContent).toHaveLength(4_000);
  await act(async () => resolveWrite());
  expect(container.textContent).not.toContain('Copied displayed content');
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
