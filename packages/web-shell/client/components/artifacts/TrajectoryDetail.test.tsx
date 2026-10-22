// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, StrictMode, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { buildTrajectory } from '../../trajectory/buildTrajectory';
import { projectTrajectoryWindow } from '../../trajectory/projectTrajectoryWindow';
import type { TrajectoryExecutionRow } from '../../trajectory/project-trajectory-executions';
import type {
  TrajectoryOtherRow,
  TrajectoryRequestRow,
  TrajectoryRow,
  TrajectoryToolRow,
  TrajectoryUserRow,
} from '../../trajectory/types';
import { TrajectoryDetail } from './TrajectoryDetail';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounts) unmount();
  mounts.length = 0;
});

function tool(
  rawInput: unknown,
  rawOutput: unknown,
  toolName = 'read_file',
): TrajectoryToolRow {
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
      toolName,
      status: 'completed',
      preview: {},
      rawInput,
      rawOutput,
    } as TrajectoryToolRow['block'],
  };
}

function request(
  overrides: Partial<TrajectoryRequestRow> = {},
): TrajectoryRequestRow {
  return {
    kind: 'request',
    key: 'req:1',
    turnIndex: 1,
    depth: 0,
    status: 'ok',
    timing: { durationMs: 1000 },
    ...overrides,
  };
}

type Props = Partial<ComponentProps<typeof TrajectoryDetail>>;

async function mount(props: Props, language: 'en' | 'zh-CN' = 'en') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const update = async (next: Props) => {
    await act(async () =>
      root.render(
        <I18nProvider language={language}>
          <TrajectoryDetail
            presentation="drill-in"
            title="Record"
            onClose={() => {}}
            {...next}
          />
        </I18nProvider>,
      ),
    );
  };
  await update(props);
  return { container, update };
}

async function render(row: TrajectoryRow, language: 'en' | 'zh-CN' = 'en') {
  return (await mount({ row }, language)).container;
}

function section(container: HTMLElement, key: string) {
  return container.querySelector<HTMLElement>(`[data-section="${key}"]`);
}

function fact(container: HTMLElement, label: string) {
  return [...container.querySelectorAll('dt')].find(
    (dt) => dt.textContent === label,
  )?.nextElementSibling;
}

function button(container: HTMLElement, name: string) {
  const found = [...container.querySelectorAll('button')].find(
    (item) =>
      item.textContent === name || item.getAttribute('aria-label') === name,
  );
  expect(found).toBeDefined();
  return found!;
}

async function click(container: HTMLElement, name: string) {
  await act(async () => button(container, name).click());
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

it('shows input and output together without tabs', async () => {
  const container = await render(tool({ path: 'a.ts' }, 'file text'));
  expect(section(container, 'input')?.textContent).toContain('"path"');
  expect(section(container, 'output')?.querySelector('pre')?.textContent).toBe(
    'file text',
  );
  expect(container.querySelector('[role="tab"]')).toBeNull();
  expect(fact(container, 'Tool')?.textContent).toBe('read_file');
});

it('reads a shell call as its command and output', async () => {
  const container = await render(
    tool({ command: 'ls -la', description: 'List' }, 'total 0\n', 'Shell'),
  );
  expect(section(container, 'input')?.textContent).toContain('ls -la');
  expect(section(container, 'output')?.textContent).toContain('total 0');
  expect(section(container, 'other')).not.toBeNull();
  expect(section(container, 'other')?.tagName).toBe('DETAILS');
});

it('keeps the selected output while a filter hides its record', async () => {
  const onClearFilter = vi.fn();
  const { container } = await mount({
    row: tool({}, 'original output'),
    hiddenByFilter: true,
    onClearFilter,
  });
  expect(container.textContent).toContain(
    'This record does not match the current filters.',
  );
  await click(container, 'Clear filters');
  expect(onClearFilter).toHaveBeenCalledTimes(1);
  expect(section(container, 'output')?.querySelector('pre')?.textContent).toBe(
    'original output',
  );
});

it('shows request timing and tokens without adding cached tokens twice', async () => {
  const container = await render(
    request({
      model: 'qwen-test',
      timing: { durationMs: 1000, startedAt: 1_760_000_000_000, ttftMs: 250 },
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
    }),
  );
  expect(fact(container, 'First token')?.textContent).toContain('250ms');
  expect(fact(container, 'First token')?.textContent).toContain(
    '750ms generating',
  );
  expect(fact(container, 'Tokens')?.textContent).toBe(
    '100 in · 40 cached · 20 out',
  );
  expect(container.textContent).not.toContain('140');
  expect(fact(container, 'Model')?.textContent).toBe('qwen-test');
});

it('marks timing that was not recorded instead of leaving it out', async () => {
  const container = await render(request());
  const ttft = fact(container, 'First token');
  expect(ttft?.textContent).toBe('—');
  expect(ttft?.getAttribute('title')).toBe('Not recorded');
  expect(fact(container, 'Tokens')?.textContent).toBe('—');
  // Identifiers that were not recorded are left out, not dashed.
  expect(section(container, 'ids')?.textContent).toContain('Not recorded');
  expect(section(container, 'ids')?.textContent).not.toContain('Prompt ID');
});

it('formats request dates in the selected UI language', async () => {
  const startedAt = 1_760_000_000_000;
  const container = await render(
    request({ timing: { durationMs: 1000, startedAt } }),
    'zh-CN',
  );
  expect(container.textContent).toContain(
    new Date(startedAt).toLocaleString('zh-CN'),
  );
});

it('keeps explicit null output and copies input whitespace unchanged', async () => {
  const writeText = stubClipboard();
  const container = await render(tool('  cat a\n', null));
  expect(section(container, 'output')?.textContent).toContain('null');
  expect(section(container, 'input')?.querySelector('pre')?.textContent).toBe(
    '  cat a\n',
  );
  await click(container, 'Copy Input');
  expect(writeText).toHaveBeenCalledWith('  cat a\n');
});

it.each([
  [false, 'false'],
  [0, '0'],
  [[], '[]'],
])('keeps an explicitly recorded output value %#', async (value, expected) => {
  const container = await render(tool(undefined, value));
  expect(section(container, 'output')?.textContent).toContain(expected);
  expect(section(container, 'output')?.textContent).not.toContain(
    'Not recorded',
  );
});

it('says when a tool recorded no output', async () => {
  const container = await render(tool({ path: 'a' }, undefined));
  expect(section(container, 'output')?.textContent).toBe('OutputNot recorded');
});

it.each(['input', 'output'] as const)(
  'copies %s JSON without a UI label',
  async (key) => {
    const value = { command: 'echo ok', options: { quiet: true } };
    const writeText = stubClipboard();
    const container = await render(tool(value, value));
    await click(container, key === 'input' ? 'Copy Input' : 'Copy Output');
    expect(JSON.parse(writeText.mock.lastCall?.[0])).toEqual(value);
  },
);

it.each([
  ['en', 'Copy Text'],
  ['zh-CN', '复制正文'],
] as const)('copies prompt text unchanged in %s', async (language, copy) => {
  const writeText = stubClipboard();
  const text = '  note\n';
  const row: TrajectoryRow = {
    kind: 'user',
    key: 'user:1',
    turnIndex: 1,
    depth: 0,
    block: { kind: 'user', text } as TrajectoryUserRow['block'],
  };
  const container = await render(row, language);
  await click(container, copy);
  expect(writeText).toHaveBeenCalledWith(text);
});

it('bounds a long value before putting it in the DOM', async () => {
  const writeText = stubClipboard();
  const container = await render(tool('x'.repeat(100_000), undefined));
  const input = () =>
    section(container, 'input')?.querySelector('pre')?.textContent;
  expect(input()).toHaveLength(4_000);
  expect(container.textContent).toContain('Content truncated');
  await click(container, 'Copy Input');
  expect(writeText).toHaveBeenLastCalledWith('x'.repeat(4_000));
  await click(container, 'Show more');
  expect(input()).toHaveLength(40_000);
  await click(container, 'Copy Input');
  expect(writeText).toHaveBeenLastCalledWith('x'.repeat(40_000));
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
  const { container, update } = await mount({
    row: tool('a'.repeat(5_000), undefined),
  });
  await click(container, 'Show more');
  await click(container, 'Copy Input');
  expect(writeText).toHaveBeenCalledOnce();

  await update({
    row: { ...tool('b'.repeat(5_000), undefined), key: 'tool:2' },
  });
  expect(
    section(container, 'input')?.querySelector('pre')?.textContent,
  ).toHaveLength(4_000);
  await act(async () => resolveWrite());
  expect(container.textContent).not.toContain('Copied');
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
  const links = section(container, 'links');
  expect(links?.textContent).toContain('Resource links');
  expect(links?.textContent).toContain('design-evidence.pdf');
  expect(links?.textContent).toContain('file:///evidence/design-evidence.pdf');
  expect(links?.textContent).toContain('"size": 0');
  expect(links?.querySelector('pre')?.textContent).toHaveLength(4_000);
  expect(container.textContent).toContain('Content truncated');
  expect(section(container, 'text')).toBeNull();
});

it('labels a permission title and shows an unresolved permission as pending', async () => {
  const row: TrajectoryOtherRow = {
    kind: 'other',
    key: 'perm:1',
    turnIndex: 1,
    depth: 0,
    block: {
      kind: 'permission',
      id: 'p1',
      title: 'Allow Bash?',
    } as TrajectoryOtherRow['block'],
  };
  const container = await render(row);
  expect(fact(container, 'Title')?.textContent).toBe('Allow Bash?');
  expect(fact(container, 'Status')?.textContent).toBe('pending');
});

it('lists and copies a request execution ID under Identifiers', async () => {
  const writeText = stubClipboard();
  const container = await render(request({ executionId: 'execution-1' }));
  const ids = section(container, 'ids')!;
  expect(ids.tagName).toBe('DETAILS');
  expect(ids.textContent).toContain('Execution ID');
  expect(ids.textContent).toContain('execution-1');
  await click(ids, 'Copy Execution ID');
  expect(writeText).toHaveBeenCalledWith('execution-1');
});

it('shows a failed request with a status pill', async () => {
  const container = await render(request({ status: 'error' }));
  expect(container.querySelector('[data-status="failed"]')?.textContent).toBe(
    'Failed',
  );
});

it('describes a turn with its counts and prompt', async () => {
  const container = (
    await mount({
      title: 'Turn 2',
      turn: {
        index: 2,
        userRowKey: 'user:1',
        rowKeys: [],
        requestCount: 3,
        toolCount: 4,
        requestMs: 0,
        partial: false,
      },
      row: {
        kind: 'user',
        key: 'user:1',
        turnIndex: 2,
        depth: 0,
        block: { kind: 'user', text: 'fix it' } as TrajectoryUserRow['block'],
      },
    })
  ).container;
  expect(container.querySelector('h3')?.textContent).toBe('Turn 2');
  expect(fact(container, 'Steps')?.textContent).toBe('3');
  expect(fact(container, 'Tools')?.textContent).toBe('4');
  expect(fact(container, 'Model time')?.textContent).toBe('—');
  expect(section(container, 'text')?.textContent).toContain('fix it');
});

const execution = (
  status: TrajectoryExecutionRow['status'],
): TrajectoryExecutionRow => ({
  key: 'execution',
  name: 'shell',
  status,
  startedAt: 100,
  endedAt: 500,
  durationMs: 123,
  entry: {
    status: status === 'error' ? 'error' : 'success',
    conflicted: false,
    event: {
      v: 1,
      kind: 'tool',
      phase: 'ended',
      executionId: 'execution',
      sessionId: 's',
      callId: 'call',
      toolName: 'shell',
      executionStatus: 'success',
      outcome: 'cancelled',
      startedAt: 100,
      endedAt: 500,
      executionDurationMs: 123,
    },
  } as TrajectoryExecutionRow['entry'],
});

it('shows execution status, outcome and lifecycle without content sections', async () => {
  const onLocateExecution = vi.fn();
  const container = (
    await mount({
      execution: execution('success'),
      title: 'shell',
      onLocateExecution,
    })
  ).container;
  expect(fact(container, 'Execution status')?.textContent).toBe('success');
  expect(fact(container, 'Final outcome')?.textContent).toBe('cancelled');
  expect(fact(container, 'Duration')?.textContent).toBe('123ms');
  expect(section(container, 'input')).toBeNull();
  expect(section(container, 'output')).toBeNull();
  expect(section(container, 'lifecycle')?.textContent).toContain(
    '"outcome": "cancelled"',
  );
  // Executions are not records in the list, so there is nothing to step to.
  expect(container.querySelector('[aria-label="Next record"]')).toBeNull();
  await click(container, 'Locate historical record');
  expect(onLocateExecution).toHaveBeenCalledOnce();
});

it.each(['en', 'zh-CN'] as const)(
  'follows an execution from success to error in %s',
  async (language) => {
    const { container, update } = await mount(
      { execution: execution('success') },
      language,
    );
    expect(container.querySelector('[data-status]')).toBeNull();
    await update({ execution: execution('error') });
    expect(container.querySelector('[data-status="failed"]')?.textContent).toBe(
      language === 'en' ? 'Failed' : '失败',
    );
  },
);

it('uses Back when docked and × beside the list, and closes on Escape', async () => {
  const onClose = vi.fn();
  const { container, update } = await mount({ row: request(), onClose });
  expect(container.querySelector('[aria-label="Back to records"]')).not.toBe(
    null,
  );
  expect(container.querySelector('[aria-label="Close details"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('h3'));
  await act(async () =>
    container
      .querySelector('h3')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
  );
  expect(onClose).toHaveBeenCalledOnce();

  await update({ row: request(), onClose, presentation: 'side' });
  expect(container.querySelector('[aria-label="Back to records"]')).toBeNull();
  await click(container, 'Close details');
  expect(onClose).toHaveBeenCalledTimes(2);
});

it('steps to the previous and next record', async () => {
  const onStep = vi.fn();
  const container = (await mount({ row: request(), onStep })).container;
  await click(container, 'Next record');
  await click(container, 'Previous record');
  expect(onStep.mock.calls).toEqual([[1], [-1]]);
});

it.each([false, true])(
  'restores only after actual removal, using the latest callback (shadow=%s)',
  async (shadow) => {
    const host = document.createElement('div');
    document.body.append(host);
    const container = document.createElement('div');
    (shadow ? host.attachShadow({ mode: 'open' }) : host).append(container);
    const root = createRoot(container);
    const first = vi.fn();
    const latest = vi.fn();
    mounts.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    const render = async (callback: () => void) => {
      await act(async () => {
        root.render(
          <StrictMode>
            <I18nProvider language="en">
              <TrajectoryDetail
                presentation="drill-in"
                row={tool({}, 'output')}
                onClose={() => {}}
                onFocusedUnmount={callback}
              />
            </I18nProvider>
          </StrictMode>,
        );
      });
    };
    await render(first);
    expect(first).not.toHaveBeenCalled();
    const button = container.querySelector<HTMLButtonElement>('button')!;
    button.focus();
    await render(latest);
    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
    expect(
      (container.getRootNode() as Document | ShadowRoot).activeElement,
    ).toBe(button);
    await act(async () => root.render(null));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  'does not restore if another control gains focus before recovery (shadow=%s)',
  async (shadow) => {
    const host = document.createElement('div');
    document.body.append(host);
    const container = document.createElement('div');
    (shadow ? host.attachShadow({ mode: 'open' }) : host).append(container);
    const root = createRoot(container);
    const fallback = vi.fn();
    mounts.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <TrajectoryDetail
            presentation="drill-in"
            row={tool({}, 'output')}
            onClose={() => {}}
            onFocusedUnmount={fallback}
          />
        </I18nProvider>,
      ),
    );
    const other = document.createElement('button');
    container.after(other);
    act(() => root.render(null));
    other.focus();
    await act(async () => {});
    expect(fallback).not.toHaveBeenCalled();
    expect(
      (container.getRootNode() as Document | ShadowRoot).activeElement,
    ).toBe(other);
  },
);

it('shows when a tool started and ended to the millisecond', async () => {
  const startedAt = 1_760_000_000_000;
  const container = await render({
    ...tool({}, 'ok'),
    timing: { startedAt, durationMs: 60 },
  } as TrajectoryToolRow);
  const range = fact(container, 'Recorded start')?.textContent ?? '';
  expect(range).toContain(new Date(startedAt).toLocaleDateString('en'));
  expect(range).toMatch(/:\d\d\.000 → .*:\d\d\.060$/);
});
