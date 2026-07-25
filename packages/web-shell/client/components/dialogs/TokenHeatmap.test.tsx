// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { TokenHeatmap } from './TokenHeatmap';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: ReactNode, language: 'en' | 'zh-CN' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<I18nProvider language={language}>{node}</I18nProvider>);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('TokenHeatmap', () => {
  it('renders a ~12-month grid of day cells', () => {
    render(
      <TokenHeatmap
        heatmap={{ [todayKey()]: { tokens: 1_000, cacheReadRate: 0 } }}
        days={365}
      />,
    );
    const cells = container!.querySelectorAll('[data-date]');
    // 365 days aligned to whole weeks ≈ 53 columns × 7 rows.
    expect(cells.length).toBeGreaterThan(300);
  });

  it('shows a custom tooltip (ISO date + tokens + cache) on hover', () => {
    const key = todayKey();
    render(
      <TokenHeatmap
        heatmap={{ [key]: { tokens: 1_395_800_000, cacheReadRate: 0.96 } }}
        days={365}
      />,
    );

    // No tooltip until hover.
    expect(container!.textContent).not.toContain('Tokens:');

    const cell = container!.querySelector(`[data-date="${key}"]`)!;
    act(() => {
      cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const text = container!.textContent ?? '';
    expect(text).toContain(`${key} · Tokens: 1395.8M · Cache: 96%`);
  });

  it('localizes the month labels to the app language (zh-CN)', () => {
    render(
      <TokenHeatmap
        heatmap={{ [todayKey()]: { tokens: 1_000, cacheReadRate: 0 } }}
        days={365}
      />,
      'zh-CN',
    );
    // Chinese short months render as "N月" rather than English abbreviations.
    expect(container!.textContent ?? '').toContain('月');
    expect(container!.textContent ?? '').not.toContain('Jan');
  });
});
