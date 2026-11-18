// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionArtifact } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { ArtifactsListPanel } from './ArtifactsListPanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function artifact(
  overrides: Partial<DaemonSessionArtifact> & { id: string },
): DaemonSessionArtifact {
  return {
    kind: 'document',
    storage: 'workspace',
    source: 'tool',
    status: 'available',
    title: 'Quarterly report',
    workspacePath: 'reports/report.md',
    retention: 'restorable',
    clientRetained: false,
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  } as DaemonSessionArtifact;
}

function mount(
  props: Partial<Parameters<typeof ArtifactsListPanel>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ArtifactsListPanel artifacts={[]} {...props} />
      </I18nProvider>,
    );
  });
  return container;
}

describe('ArtifactsListPanel', () => {
  it('lists one row per artifact by display name', () => {
    const view = mount({
      artifacts: [
        artifact({ id: 'a1', workspacePath: 'reports/report.md' }),
        artifact({
          id: 'a2',
          kind: 'link',
          storage: 'external_url',
          title: 'Table details',
          url: 'https://example.com/orders',
          workspacePath: undefined,
        }),
      ],
    });

    const list = view.querySelector('[data-testid="artifacts-list"]');
    expect(list?.querySelectorAll('li')).toHaveLength(2);
    expect(view.textContent).toContain('report.md');
    expect(view.textContent).toContain('Table details');
  });

  it('opens the clicked artifact', () => {
    const onOpenArtifact = vi.fn();
    const view = mount({
      artifacts: [artifact({ id: 'a1' })],
      onOpenArtifact,
    });

    const row = view.querySelector<HTMLButtonElement>(
      '[data-testid="artifacts-list"] button',
    );
    expect(row?.getAttribute('title')).toBe('report.md');
    act(() => row?.click());
    expect(onOpenArtifact).toHaveBeenCalledWith('a1');
  });

  it('describes the empty state', () => {
    const view = mount({ artifacts: [] });
    expect(
      view.querySelector('[data-testid="artifacts-list-empty"]')?.textContent,
    ).toContain('Artifacts generated in this session will appear here.');
  });

  it('shows a skeleton while loading', () => {
    const view = mount({ artifacts: [artifact({ id: 'a1' })], loading: true });
    expect(
      view.querySelector('[data-testid="artifacts-list-skeleton"]'),
    ).not.toBeNull();
    expect(view.querySelector('[data-testid="artifacts-list"]')).toBeNull();
  });
});
