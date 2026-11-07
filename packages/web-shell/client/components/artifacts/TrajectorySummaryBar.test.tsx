// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { TrajectorySummaryBar } from './TrajectorySummaryBar';
import type { TrajectorySummary } from '../../trajectory/summarizeTrajectory';

const mounts: Array<() => void> = [];
afterEach(() => {
  mounts.splice(0).forEach((unmount) => unmount());
});

const SUMMARY: TrajectorySummary = {
  turnCount: 4,
  requestCount: 18,
  toolCount: 19,
  requestFailures: 1,
  toolFailures: 1,
  mainRequestMs: 88_000,
  elapsedMs: 1_418_000,
  activeMs: 363_000,
  plottedCount: 37,
  missingStartCount: 0,
  missingTimingCount: 0,
  tokens: { input: 412_000, output: 6_800 },
};

type Props = ComponentProps<typeof TrajectorySummaryBar>;

async function mount(
  overrides: Partial<Props> = {},
  language: 'en' | 'zh-CN' = 'en',
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const props: Props = {
    summary: SUMMARY,
    pill: 'live',
    onPill: vi.fn(),
    warnings: [],
    onRetry: vi.fn(),
    onRefresh: vi.fn(),
    onReturnToLatest: vi.fn(),
    canRefresh: true,
    history: false,
    failuresOn: false,
    onToggleFailures: vi.fn(),
    about: {
      pages: 1,
      searchExcluded: 0,
      executionsOmitted: 0,
      executionsOutside: 0,
    },
    ...overrides,
  };
  await act(async () =>
    root.render(
      <I18nProvider language={language}>
        <TrajectorySummaryBar {...props} />
      </I18nProvider>,
    ),
  );
  return { container, props };
}

function byTestId(id: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

it('leads with elapsed and active time, label first in Chinese', async () => {
  const { container } = await mount();
  expect(byTestId('trajectory-metrics')?.textContent).toContain(
    '23m 38selapsed',
  );
  expect(container.textContent).toContain('6m 3sactive');
  expect(byTestId('trajectory-totals')?.textContent).toBe(
    '18 requests19 tools',
  );
  mounts.splice(0).forEach((unmount) => unmount());
  await mount({}, 'zh-CN');
  expect(byTestId('trajectory-metrics')?.textContent).toContain(
    '总历时23m 38s',
  );
});

it('shows failures as a toggle for the failed filter', async () => {
  const { props } = await mount({ failuresOn: true });
  const chip = byTestId('trajectory-failures')!;
  expect(chip.textContent).toBe('2 failed');
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  await act(async () => chip.click());
  expect(props.onToggleFailures).toHaveBeenCalledTimes(1);
});

it('hides the failure chip when nothing failed', async () => {
  await mount({
    summary: { ...SUMMARY, requestFailures: 0, toolFailures: 0 },
  });
  expect(byTestId('trajectory-failures')).toBeNull();
});

it('keeps the failure chip while its filter is on, so it can be turned off', async () => {
  const { props } = await mount({
    summary: { ...SUMMARY, requestFailures: 0, toolFailures: 0 },
    failuresOn: true,
  });
  const chip = byTestId('trajectory-failures')!;
  expect(chip.textContent).toBe('0 failed');
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  await act(async () => chip.click());
  expect(props.onToggleFailures).toHaveBeenCalledTimes(1);
});

it.each([
  ['live', 'Live', 'Pause following'],
  ['connecting', 'Connecting…', 'Pause following'],
  ['reconnecting', 'Reconnecting…', 'Pause following'],
  ['returning', 'Updating…', 'Pause following'],
  ['paused', 'Paused', 'Return to latest'],
  ['history', 'Earlier window', 'Return to latest'],
] as const)('pill %s reads %s', async (pill, text, action) => {
  const { props } = await mount({ pill });
  const button = byTestId('trajectory-follow-status')!;
  expect(button.textContent).toBe(text);
  expect(button.title).toBe(action);
  await act(async () => button.click());
  expect(props.onPill).toHaveBeenCalledTimes(1);
});

it('renders no pill without live state to report', async () => {
  await mount({ pill: 'none' });
  expect(byTestId('trajectory-follow-status')).toBeNull();
});

it('lists warnings with their actions only while there are any', async () => {
  await mount();
  expect(byTestId('trajectory-warnings')).toBeNull();
  mounts.splice(0).forEach((unmount) => unmount());
  const { props } = await mount({
    warnings: [
      { kind: 'refresh-failed', failure: { kind: 'partial' } },
      { kind: 'history-gap' },
    ],
  });
  const trigger = byTestId('trajectory-warnings')!;
  expect(trigger.textContent).toBe('2');
  await act(async () => trigger.click());
  expect(document.body.textContent).toContain(
    'Refresh failed; showing the last successful read',
  );
  const retry = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Try again',
  )!;
  await act(async () => retry.click());
  expect(props.onRetry).toHaveBeenCalledTimes(1);
});

it('keeps scope caveats behind About', async () => {
  const { container } = await mount({
    about: {
      pages: 2,
      searchExcluded: 3,
      executionsOmitted: 0,
      executionsOutside: 0,
    },
  });
  expect(container.textContent).not.toContain('Totals cover');
  await act(async () => byTestId('trajectory-about')!.click());
  expect(document.body.textContent).toContain(
    'Totals cover the loaded records: 2 pages, 4 turns.',
  );
  expect(document.body.textContent).toContain('excluded from search');
});

it('announces failed reads while the records stay on screen', async () => {
  await mount({
    warnings: [
      { kind: 'navigation-failed', failure: { kind: 'expired' } },
      { kind: 'history-gap' },
    ],
  });
  const alert = byTestId('trajectory-failure-alert')!;
  expect(alert.getAttribute('role')).toBe('alert');
  expect(alert.textContent).not.toBe('');
});

it('offers the way back to latest from an earlier window', async () => {
  const { container, props } = await mount({
    history: true,
    warnings: [
      { kind: 'navigation-failed', failure: { kind: 'expired' } },
      { kind: 'history-gap' },
    ],
  });
  const refresh = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Refresh"]',
  )!;
  expect(refresh.disabled).toBe(true);
  await act(async () => byTestId('trajectory-warnings')!.click());
  const actions = [
    ...document.querySelectorAll<HTMLButtonElement>('ul button'),
  ];
  expect(actions.map((button) => button.textContent)).toEqual([
    'Back to latest',
    'Back to latest',
  ]);
  expect(actions.every((button) => !button.disabled)).toBe(true);
  await act(async () => actions.forEach((button) => button.click()));
  expect(props.onReturnToLatest).toHaveBeenCalledTimes(2);
  expect(props.onRefresh).not.toHaveBeenCalled();
});
