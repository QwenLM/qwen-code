// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { ChangeOverviewState } from './useChangeOverview';

const mock = vi.hoisted(() => ({
  state: {
    gitAvailable: true,
    loading: false,
    units: [],
  } as ChangeOverviewState,
  refresh: vi.fn(),
}));
vi.mock('./useChangeOverview', () => ({
  useChangeOverview: () => ({ ...mock.state, refresh: mock.refresh }),
}));
vi.mock('../../hooks/useExternalLinkOpener', () => ({
  useExternalLinkOpener: () => vi.fn(),
}));

const { ChangeOverviewPanel } = await import('./ChangeOverviewPanel');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;

const units: ChangeOverviewState['units'] = [
  {
    kind: 'uncommitted',
    id: 'uncommitted',
    files: [{ path: 'pending.ts', additions: 2, deletions: 0 }],
    additions: 2,
    deletions: 0,
    filesCount: 1,
    hiddenCount: 0,
  },
  {
    kind: 'pr',
    id: 'pr:7',
    number: 7,
    title: '#7',
    url: 'https://github.com/o/r/pull/7',
    state: 'ready',
    files: [
      { path: 'src/a.ts', additions: 10, deletions: 2 },
      { path: 'src/b.ts', additions: 0, deletions: 5 },
    ],
    additions: 10,
    deletions: 7,
    filesCount: 2,
    hiddenCount: 0,
  },
  {
    kind: 'commit',
    id: 'commit:abc',
    sha: 'abc1234',
    shortSha: 'abc1234',
    subject: 'feat: loose commit',
    files: [{ path: 'loose.ts', additions: 1, deletions: 0 }],
    additions: 1,
    deletions: 0,
    filesCount: 1,
  },
];

function renderPanel() {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ChangeOverviewPanel workspaceCwd="/work" sessionId="s1" />
      </I18nProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mock.state = { gitAvailable: true, loading: false, units };
  mock.refresh.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe('ChangeOverviewPanel', () => {
  it('renders a scope chip per delivery unit and defaults to uncommitted', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    expect(chips).toHaveLength(3);
    expect(container.textContent).toContain('Uncommitted');
    expect(container.textContent).toContain('#7');
    expect(container.textContent).toContain('pending.ts');
    expect(container.textContent).toContain('+2');
  });

  it('switches the file list and scale when a PR scope is selected', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    act(() => {
      (chips[1] as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain('src/a.ts');
    expect(container.textContent).toContain('src/b.ts');
    expect(container.textContent).toContain('+10');
    expect(container.textContent).toContain('-7');
    expect(container.textContent).not.toContain('pending.ts');
    const prLink = container.querySelector(
      'a[href="https://github.com/o/r/pull/7"]',
    );
    expect(prLink).not.toBeNull();
  });

  it('shows the commit subject and files for a commit scope', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    act(() => {
      (chips[2] as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain('feat: loose commit');
    expect(container.textContent).toContain('loose.ts');
  });

  it('shows an unavailable state for a PR whose file list failed', () => {
    mock.state = {
      gitAvailable: true,
      loading: false,
      units: [
        {
          kind: 'pr',
          id: 'pr:9',
          number: 9,
          title: '#9',
          url: 'https://github.com/o/r/pull/9',
          state: 'unavailable',
          files: [],
          additions: 0,
          deletions: 0,
          filesCount: 0,
          hiddenCount: 0,
        },
      ],
    };
    renderPanel();
    expect(container.textContent).toContain('File list unavailable');
  });

  it('shows a not-a-git message when git is unavailable', () => {
    mock.state = { gitAvailable: false, loading: false, units: [] };
    renderPanel();
    expect(container.textContent).toContain('not a git repository');
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('calls refresh from the toolbar button', () => {
    renderPanel();
    const refreshButton = container.querySelector(
      'button[aria-label="Refresh"]',
    ) as HTMLButtonElement;
    act(() => {
      refreshButton.click();
    });
    expect(mock.refresh).toHaveBeenCalledTimes(1);
  });
});
