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
import { TrajectoryFilters } from './TrajectoryFilters';
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
}: {
  count?: number;
  position?: number;
  truncatedCount?: number;
  language?: 'en' | 'zh-CN';
} = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onChange = vi.fn();
  const onNavigate = vi.fn();
  const onClear = vi.fn();
  mounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const update = async (value: TrajectoryFilter) => {
    await act(async () =>
      root.render(
        <I18nProvider language={language}>
          <TrajectoryFilters
            value={value}
            onChange={onChange}
            onNavigate={onNavigate}
            onClear={onClear}
            count={count}
            position={position}
            truncatedCount={truncatedCount}
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

it('disables zero-result navigation and keeps coverage visible in Chinese', async () => {
  const { container } = await mount({
    count: 0,
    truncatedCount: 2,
    language: 'zh-CN',
  });
  expect(container.textContent).toContain('匹配 0 条');
  expect(container.textContent).toContain(
    '部分已记录正文未纳入搜索（2 条记录）。',
  );
  const buttons = [...container.querySelectorAll('button')];
  expect(
    buttons.find((button) => button.textContent === '上一条')?.disabled,
  ).toBe(true);
  expect(
    buttons.find((button) => button.textContent === '下一条')?.disabled,
  ).toBe(true);
});

it('derives result position from props and clears the draft on clear', async () => {
  const { container, input, onClear, update } = await mount({ position: 2 });
  await update({ query: 'read_file', type: 'tool', status: 'error' });
  expect(container.textContent).toContain('Result 2 / 3');
  const clear = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Clear filters',
  )!;
  await act(async () => clear.click());
  expect(input.value).toBe('');
  expect(onClear).toHaveBeenCalledTimes(1);
});
