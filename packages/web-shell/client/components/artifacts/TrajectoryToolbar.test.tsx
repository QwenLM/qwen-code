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
import { TrajectoryToolbar } from './TrajectoryToolbar';
import type { TrajectoryFilter } from '../../trajectory/filterTrajectory';

const mounts: Array<() => void> = [];
afterEach(() => {
  mounts.splice(0).forEach((unmount) => unmount());
});

async function mount({
  count = 3,
  position = 0,
  truncatedCount = 0,
  language = 'en',
  range,
}: {
  count?: number;
  position?: number;
  truncatedCount?: number;
  language?: 'en' | 'zh-CN';
  range?: string;
} = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onNavigate = vi.fn();
  const onClear = vi.fn();
  const onClearRange = vi.fn();
  mounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const update = async (
    value: TrajectoryFilter,
    coverageCount = truncatedCount,
  ) => {
    await act(async () =>
      root.render(
        <I18nProvider language={language}>
          <TrajectoryToolbar
            value={value}
            onChange={onChange}
            onNavigate={onNavigate}
            onClear={onClear}
            count={count}
            position={position}
            truncatedCount={coverageCount}
            {...(range !== undefined ? { range } : {})}
            onClearRange={onClearRange}
          />
        </I18nProvider>,
      ),
    );
  };
  await update({ query: '', type: 'all', status: 'all' });
  return {
    container,
    input: container.querySelector('input')!,
    onChange,
    onNavigate,
    onClear,
    onClearRange,
    update,
  };
}

function inputText(input: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(name: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (candidate) =>
      candidate.getAttribute('aria-label') === name ||
      candidate.textContent === name,
  ) as HTMLButtonElement | undefined;
}

async function openFilters() {
  await act(async () => {
    const trigger = [...document.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith('Filter'),
    )!;
    trigger.click();
  });
}

it('submits the current draft on Enter and keeps the input focused', async () => {
  const { input, onChange, onNavigate } = await mount();
  input.focus();
  await act(async () => {
    inputText(input, '配置');
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
  expect(onChange).toHaveBeenLastCalledWith({
    query: '配置',
    type: 'all',
    status: 'all',
  });
  expect(onNavigate).toHaveBeenLastCalledWith(1, {
    query: '配置',
    type: 'all',
    status: 'all',
  });
  expect(document.activeElement).toBe(input);
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
      }),
    );
  });
  expect(onNavigate.mock.lastCall?.[0]).toBe(-1);
});

it('defers matching and Enter navigation until IME composition ends', async () => {
  const { input, onChange, onNavigate } = await mount();
  await act(async () => {
    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    inputText(input, '配置');
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
  expect(input.value).toBe('配置');
  expect(onChange).not.toHaveBeenCalled();
  expect(onNavigate).not.toHaveBeenCalled();
  await act(async () => {
    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '配置' }),
    );
  });
  expect(onChange).toHaveBeenLastCalledWith({
    query: '配置',
    type: 'all',
    status: 'all',
  });
  expect(onNavigate).not.toHaveBeenCalled();
});

it('limits displayed and applied queries to 256 code units', async () => {
  const { input, onChange } = await mount();
  expect(input.maxLength).toBe(256);
  await act(async () => inputText(input, 'a'.repeat(300)));
  expect(input.value).toHaveLength(256);
  expect(onChange.mock.lastCall?.[0].query).toHaveLength(256);
});

it('updates the draft when filters are cleared externally', async () => {
  const { input, update } = await mount();
  await update({ query: 'read_file', type: 'tool', status: 'error' });
  expect(input.value).toBe('read_file');
  await update({ query: '', type: 'all', status: 'all' });
  expect(input.value).toBe('');
});

it('does not recommit a cancelled composition when the applied query is unchanged', async () => {
  const { input, update, onChange } = await mount();
  await update({ query: '配置', type: 'all', status: 'all' });
  await act(async () => {
    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
  });
  expect(input.value).toBe('配置');
  expect(onChange).not.toHaveBeenCalled();
});

it.each([
  { keyCode: 229, isComposing: false },
  { keyCode: 0, isComposing: true },
])(
  'does not navigate on an IME committing Enter after compositionend (%j)',
  async (keyboard) => {
    const { input, onChange, onNavigate } = await mount();
    await act(async () => {
      input.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );
      inputText(input, '配置');
      input.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '配置' }),
      );
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          ...keyboard,
        }),
      );
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      query: '配置',
      type: 'all',
      status: 'all',
    });
    expect(onNavigate).not.toHaveBeenCalled();
  },
);

it('disables zero-result navigation and shows coverage in Chinese', async () => {
  const { container, update } = await mount({
    count: 0,
    truncatedCount: 2,
    language: 'zh-CN',
  });
  await update({ query: 'missing', type: 'all', status: 'all' });
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    '匹配 0 条',
  );
  expect(
    container.querySelector(
      '[aria-label="部分已记录正文未纳入搜索（2 条记录）。"]',
    ),
  ).not.toBeNull();
  expect(button('上一条')?.disabled).toBe(true);
  expect(button('下一条')?.disabled).toBe(true);
});

it('derives result position from props and clears only the query inline', async () => {
  const { container, input, onChange, onClear, update } = await mount({
    position: 2,
  });
  await update({ query: 'read_file', type: 'tool', status: 'error' });
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    '2 of 3',
  );
  await act(async () => button('Clear search')!.click());
  expect(input.value).toBe('');
  expect(onChange).toHaveBeenLastCalledWith({
    query: '',
    type: 'tool',
    status: 'error',
  });
  expect(onClear).not.toHaveBeenCalled();
});

it('hides result controls while nothing is applied', async () => {
  const { container, update } = await mount({ count: 48, position: 4 });
  expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  expect(button('Previous')).toBeUndefined();
  expect(button('Next')).toBeUndefined();
  await update({ query: '   ', type: 'all', status: 'all' });
  expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  expect(button('Next')).toBeUndefined();
});

it('edits type and status in the filter popover and counts active facets', async () => {
  const { onChange, onClear, update } = await mount();
  await openFilters();
  expect(button('Clear filters')?.disabled).toBe(true);
  const tools = [...document.querySelectorAll('[role="radio"]')].find(
    (radio) => radio.closest('label')?.textContent === 'Tools',
  ) as HTMLButtonElement;
  await act(async () => tools.click());
  expect(onChange).toHaveBeenLastCalledWith({
    query: '',
    type: 'tool',
    status: 'all',
  });
  await update({ query: '', type: 'tool', status: 'error' });
  expect(
    [...document.querySelectorAll('button')].some(
      (b) => b.getAttribute('aria-label') === 'Filter · 2 active',
    ),
  ).toBe(true);
  expect(button('Clear filters')?.disabled).toBe(false);
  await act(async () => button('Clear filters')!.click());
  expect(onClear).toHaveBeenCalledTimes(1);
});

it('routes enabled Previous and Next buttons in the expected directions', async () => {
  const { update, onNavigate } = await mount({ count: 3, position: 2 });
  await update({ query: '', type: 'tool', status: 'all' });
  await act(async () => button('Previous')!.click());
  expect(onNavigate).toHaveBeenLastCalledWith(-1);
  await act(async () => button('Next')!.click());
  expect(onNavigate).toHaveBeenLastCalledWith(1);
});

it('clears an IME draft without advertising it as an applied search', async () => {
  const { container, input, onChange } = await mount();
  await act(async () => {
    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    inputText(input, '配置');
  });
  expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  await act(async () => button('Clear search')!.click());
  expect(input.value).toBe('');
  await act(async () =>
    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    ),
  );
  expect(onChange).not.toHaveBeenCalled();
});

it('shows the selected time range as a removable chip', async () => {
  const { container, onClearRange } = await mount({ range: '0:42 – 1:58' });
  expect(container.textContent).toContain('0:42 – 1:58');
  await act(async () => button('Clear time selection')!.click());
  expect(onClearRange).toHaveBeenCalledTimes(1);
});
