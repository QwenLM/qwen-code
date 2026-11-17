// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { ChangeOverviewState } from './useChangeOverview';

const mock = vi.hoisted(() => ({
  // Partial overrides spread over a complete default below, so every fixture
  // is a full ChangeOverviewState (the hook's sole output shape) and a renamed
  // or added field is a type error here rather than a silently-wrong state.
  state: {} as Partial<ChangeOverviewState>,
  refresh: vi.fn(),
  hook: vi.fn(),
  openExternalLink: vi.fn(),
}));
vi.mock('./useChangeOverview', () => ({
  useChangeOverview: (...args: unknown[]) => {
    mock.hook(...args);
    return {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      units: [],
      commitsTruncated: false,
      ...mock.state,
      refresh: mock.refresh,
    };
  },
}));
vi.mock('../../hooks/useExternalLinkOpener', () => ({
  useExternalLinkOpener: () => mock.openExternalLink,
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
    hiddenCount: 0,
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
  mock.hook.mockClear();
  mock.openExternalLink.mockClear();
});

function pressKey(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  });
}

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

  it('shows the hidden-files note for a truncated commit scope', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      units: [
        {
          kind: 'commit',
          id: 'commit:big',
          sha: 'big1234',
          shortSha: 'big1234',
          subject: 'feat: squash',
          files: [{ path: 'f0.ts', additions: 1, deletions: 0 }],
          additions: 60,
          deletions: 0,
          filesCount: 60,
          hiddenCount: 10,
        },
      ],
    };
    renderPanel();
    expect(container.textContent).toContain('60 files');
    expect(container.textContent).toContain('…and 10 more files');
  });

  it('shows the hidden-commits note when the commit window is truncated', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      commitsTruncated: true,
      units,
    };
    renderPanel();
    expect(container.textContent).toContain('…and more commits');
  });

  it('omits the hidden-commits note when the commit window is complete', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      commitsTruncated: false,
      units,
    };
    renderPanel();
    expect(container.textContent).not.toContain('…and more commits');
  });

  it('forwards its workspace cwd and session id to the hook', () => {
    renderPanel();
    expect(mock.hook).toHaveBeenCalledWith('/work', 's1');
  });

  it('passes an undefined session id when rendered session-less', () => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <ChangeOverviewPanel workspaceCwd="/work" />
        </I18nProvider>,
      );
    });
    expect(mock.hook).toHaveBeenCalledWith('/work', undefined);
  });

  it('shows the loading message, not an empty scope, during the initial fetch', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: true,
      units: [],
      commitsTruncated: false,
    };
    renderPanel();
    expect(container.textContent).toContain('Loading changes');
    expect(container.textContent).not.toContain('No changes in this scope');
  });

  it('keeps the current scope visible while a refresh is in flight', () => {
    // The hook keeps the previous units while re-fetching, so loading with
    // populated units is the normal refresh state: the visible file list must
    // not blank out to "Loading changes" on every refresh.
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: true,
      units,
      commitsTruncated: false,
    };
    renderPanel();
    expect(container.textContent).not.toContain('Loading changes');
    expect(container.textContent).toContain('pending.ts');
  });

  it('shows a retryable load-failed message on a transient fetch failure', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: true,
      loading: false,
      units: [],
    };
    renderPanel();
    expect(container.textContent).toContain(
      'Couldn’t load the change overview',
    );
    expect(container.textContent).not.toContain('not a git repository');
    expect(
      container.querySelector('button[aria-label="Refresh"]'),
    ).not.toBeNull();
  });

  it('treats a capped-but-empty uncommitted list as truncated, not empty', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      units: [
        {
          kind: 'uncommitted',
          id: 'uncommitted',
          files: [],
          additions: 4000,
          deletions: 3000,
          filesCount: 501,
          hiddenCount: 501,
        },
      ],
    };
    renderPanel();
    expect(container.textContent).toContain('501 files');
    expect(container.textContent).not.toContain('No changes in this scope');
    expect(container.textContent).toContain('…and 501 more files');
  });

  it('omits the count, totals and badge for an unavailable PR', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      units: [
        {
          kind: 'pr',
          id: 'pr:9',
          number: 9,
          title: '#9',
          url: 'https://github.com/o/r/pull/9',
          state: 'unavailable',
          unavailableCause: 'error',
          files: [],
          additions: 0,
          deletions: 0,
          filesCount: 0,
          hiddenCount: 0,
        },
      ],
    };
    renderPanel();
    expect(container.textContent).not.toContain('0 files');
    const badge = container.querySelector('[class*="scopeBadge"]');
    expect(badge).toBeNull();
  });

  it('names the actual cause of an unavailable PR file list', () => {
    const base = {
      kind: 'pr' as const,
      id: 'pr:9',
      number: 9,
      title: '#9',
      url: 'https://github.com/o/r/pull/9',
      state: 'unavailable' as const,
      files: [],
      additions: 0,
      deletions: 0,
      filesCount: 0,
      hiddenCount: 0,
    };
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      units: [{ ...base, unavailableCause: 'cli' }],
    };
    renderPanel();
    expect(container.textContent).toContain('GitHub CLI (gh) is not installed');
    mock.state = {
      ...mock.state,
      units: [{ ...base, unavailableCause: 'route' }],
    };
    renderPanel();
    expect(container.textContent).toContain('predates the PR file-list route');
  });

  it('renders a binary marker instead of +0 -0 for binary rows', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      units: [
        {
          kind: 'uncommitted',
          id: 'uncommitted',
          files: [
            { path: 'logo.png', additions: 0, deletions: 0, isBinary: true },
          ],
          additions: 0,
          deletions: 0,
          filesCount: 1,
          hiddenCount: 0,
        },
      ],
    };
    renderPanel();
    expect(container.textContent).toContain('logo.png');
    // The binary row renders a marker, not a "+0 -0" LineStats. (The scope
    // header may still total +0 for a binary-only scope; that is correct.)
    const row = container.querySelector('[class*="fileRow"]');
    expect(row?.textContent).toContain('~');
    expect(row?.textContent).not.toContain('+0');
    expect(row?.querySelector('[class*="lineStats"]')).toBeNull();
  });

  it('disables refresh while a pass is in flight', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: true,
      units: [],
    };
    renderPanel();
    const refreshButton = container.querySelector(
      'button[aria-label="Refresh"]',
    ) as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(true);
  });

  it('keeps refresh available in the not-a-git state', () => {
    mock.state = {
      gitAvailable: false,
      loadFailed: false,
      loading: false,
      units: [],
    };
    renderPanel();
    expect(
      container.querySelector('button[aria-label="Refresh"]'),
    ).not.toBeNull();
  });

  it('exposes a roving tabindex, selected state and tabpanel linkage', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    expect(chips[0].getAttribute('tabindex')).toBe('0');
    expect(chips[0].getAttribute('aria-selected')).toBe('true');
    expect(chips[1].getAttribute('tabindex')).toBe('-1');
    expect(chips[1].getAttribute('aria-selected')).toBe('false');
    expect(chips[2].getAttribute('tabindex')).toBe('-1');
    expect(chips[0].getAttribute('aria-controls')).toBe(
      'change-overview-tabpanel',
    );
    const panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.id).toBe('change-overview-tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(
      'change-overview-tab-uncommitted',
    );
  });

  it('moves selection and focus with ArrowRight, wrapping at the end', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    pressKey(chips[0], 'ArrowRight');
    expect(chips[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chips[1]);
    expect(container.textContent).toContain('src/a.ts');
    pressKey(chips[1], 'ArrowRight');
    expect(chips[2].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chips[2]);
    pressKey(chips[2], 'ArrowRight');
    expect(chips[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chips[0]);
  });

  it('moves selection backward with ArrowLeft, wrapping at the start', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    pressKey(chips[0], 'ArrowLeft');
    expect(chips[2].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chips[2]);
    pressKey(chips[2], 'ArrowLeft');
    expect(chips[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chips[1]);
  });

  it('jumps to the first and last scope with Home and End', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    act(() => {
      (chips[1] as HTMLButtonElement).click();
    });
    pressKey(chips[1], 'Home');
    expect(chips[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chips[0]);
    pressKey(chips[0], 'End');
    expect(chips[2].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(chips[2]);
  });

  it('suppresses the file-count badge for commit scopes but not others', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    expect(chips[0].querySelector('[class*="scopeBadge"]')).not.toBeNull();
    expect(chips[1].querySelector('[class*="scopeBadge"]')).not.toBeNull();
    expect(chips[2].querySelector('[class*="scopeBadge"]')).toBeNull();
  });

  it('sanitizes control characters in a commit subject', () => {
    mock.state = {
      gitAvailable: true,
      loadFailed: false,
      loading: false,
      units: [
        {
          kind: 'commit',
          id: 'commit:esc',
          sha: 'esc1234',
          shortSha: 'esc1234',
          subject: 'feat:\u001b[31mred',
          files: [{ path: 'x.ts', additions: 1, deletions: 0 }],
          additions: 1,
          deletions: 0,
          filesCount: 1,
          hiddenCount: 0,
        },
      ],
    };
    renderPanel();
    const title = container.querySelector('[class*="scaleTitle"]');
    expect(title?.textContent).toContain('\\u001b');
    expect(title?.textContent).not.toContain('\u001b');
  });

  it('routes the PR open link through the external-link opener', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    act(() => {
      (chips[1] as HTMLButtonElement).click();
    });
    const link = container.querySelector(
      'a[href="https://github.com/o/r/pull/7"]',
    ) as HTMLAnchorElement;
    act(() => {
      link.click();
    });
    expect(mock.openExternalLink).toHaveBeenCalledWith(
      expect.anything(),
      'https://github.com/o/r/pull/7',
    );
  });

  it('leaves modified arrow keys to the browser (Alt+Left/Right is navigation)', () => {
    renderPanel();
    const chips = container.querySelectorAll('[role="tab"]');
    act(() => {
      chips[0].dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(chips[0].getAttribute('aria-selected')).toBe('true');
    expect(chips[1].getAttribute('aria-selected')).toBe('false');
  });

  it('gives the tabpanel a tab stop so its body is keyboard-scrollable', () => {
    renderPanel();
    const panel = container.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute('tabindex')).toBe('0');
  });

  it('gives the tablist an accessible name', () => {
    renderPanel();
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist?.getAttribute('aria-label')).toBeTruthy();
  });

  it('does not advertise an orphan tabpanel when no tablist renders', () => {
    mock.state = { gitAvailable: false, loading: false, units: [] };
    renderPanel();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="tabpanel"]')).toBeNull();
  });
});
