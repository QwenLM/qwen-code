// @vitest-environment jsdom

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionPrInfo } from '@qwen-code/sdk/daemon';
import type { DaemonAutofixPrWatch } from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../i18n';
import { indexAutofixPrWatches } from '../utils/autofixPrWatches';
import {
  AutofixPrContext,
  type AutofixPrContextValue,
} from './autofixPr/AutofixPrContext';
import { SessionPrBadge, openableSessionPrs } from './SessionPrBadge';
import badgeStyles from './SessionPrBadge.module.css';
import styles from './SessionPrStateIcon.module.css';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function renderBadge(
  prs: DaemonSessionPrInfo[],
  compact = false,
  autofixCtx?: AutofixPrContextValue,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        {autofixCtx ? (
          <AutofixPrContext.Provider value={autofixCtx}>
            <SessionPrBadge prs={prs} compact={compact} />
          </AutofixPrContext.Provider>
        ) : (
          <SessionPrBadge prs={prs} compact={compact} />
        )}
      </I18nProvider>,
    );
  });
  return container;
}

const makeWatch = (
  over: Partial<DaemonAutofixPrWatch> = {},
): DaemonAutofixPrWatch => ({
  pr: 9500,
  repo: 'o/r',
  host: 'github.com',
  url: 'https://github.com/o/r/pull/9500',
  headRefName: 'feat',
  headSha: 'a'.repeat(40),
  pushes: 0,
  maxPushes: 10,
  session: 's1',
  preparedAt: null,
  lastCheck: null,
  checkedRecently: true,
  lastRound: null,
  stopped: null,
  watch: { every: 2, reply: true, instructions: '', task: 'feedc0ffee12' },
  ended: null,
  needsHuman: [],
  worktreeExists: true,
  fix: null,
  ...over,
});

function makeAutofixCtx(
  watches: DaemonAutofixPrWatch[],
): AutofixPrContextValue {
  const lists = new Map([['', { available: true, watches }]]);
  return {
    watchIndex: indexAutofixPrWatches(lists),
    lists,
    error: null,
    loaded: true,
    reload: vi.fn().mockResolvedValue(undefined),
    canStartInWorkspace: () => true,
    startInNewSession: vi.fn().mockResolvedValue(undefined),
    openWatch: vi.fn().mockResolvedValue(undefined),
  };
}

const pr = (
  number: number,
  state?: DaemonSessionPrInfo['state'],
): DaemonSessionPrInfo => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  ...(state ? { state } : {}),
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('SessionPrBadge', () => {
  it('shows the GitHub-style state icon of the latest bound PR', () => {
    const iconOf = (state?: DaemonSessionPrInfo['state']) =>
      renderBadge([pr(9517, state)]).querySelector('a svg');
    expect(iconOf('merged')?.classList.contains('lucide-git-merge')).toBe(true);
    expect(
      iconOf('merged')?.classList.contains(styles.sessionPrStateMerged),
    ).toBe(true);
    expect(
      iconOf('closed')?.classList.contains('lucide-git-pull-request-closed'),
    ).toBe(true);
    expect(
      iconOf('closed')?.classList.contains(styles.sessionPrStateClosed),
    ).toBe(true);
    expect(iconOf('open')?.classList.contains('lucide-git-pull-request')).toBe(
      true,
    );
    expect(iconOf('open')?.classList.contains(styles.sessionPrStateOpen)).toBe(
      true,
    );
    // A state-less binding keeps the neutral icon without a state color.
    expect(iconOf()?.classList.contains('lucide-git-pull-request')).toBe(true);
    expect(iconOf()?.className).not.toContain('sessionPrState');
  });

  it('appends the state name to the aria-label for merged and closed PRs', () => {
    const labelOf = (state?: DaemonSessionPrInfo['state']) =>
      renderBadge([pr(9517, state)])
        .querySelector('a')
        ?.getAttribute('aria-label');
    expect(labelOf('merged')).toContain('Merged');
    expect(labelOf('closed')).toContain('Closed');
    expect(labelOf('open')).not.toContain('Open');
    expect(labelOf()).not.toContain('Open');
  });

  it('renders the last openable binding, not the last binding', () => {
    const badge = renderBadge([
      pr(9500),
      { number: 1, url: 'javascript:alert(1)' },
    ]);
    const anchor = badge.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/9500',
    );
    expect(anchor?.textContent).toBe('#9500');
    expect(anchor?.getAttribute('aria-label')).toBe('Pull Request #9500');
  });

  it('renders the latest-bound openable PR even when it is numbered lower', () => {
    // Recency is array position, not number, and the overflow counts only
    // the openable bindings.
    const badge = renderBadge([
      pr(9517, 'merged'),
      { number: 1, url: 'javascript:alert(1)' },
      pr(9500),
    ]);
    const anchor = badge.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/9500',
    );
    expect(anchor?.textContent).toBe('#9500 +1');
    expect(anchor?.getAttribute('aria-label')).toBe(
      'Pull Request #9500 (2 total)',
    );
  });

  it('keeps the state icon and link on a compact merged-PR badge', () => {
    const anchor = renderBadge([pr(9517, 'merged')], true).querySelector('a');
    expect(anchor?.className).toContain(badgeStyles.sessionPrBadgeCompact);
    expect(
      anchor?.querySelector('svg')?.classList.contains('lucide-git-merge'),
    ).toBe(true);
    expect(anchor?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/9517',
    );
    expect(anchor?.getAttribute('aria-label')).toContain('Merged');
  });

  it('renders nothing when no binding is openable', () => {
    expect(
      renderBadge([{ number: 1, url: 'javascript:alert(1)' }]).querySelector(
        'a',
      ),
    ).toBeNull();
  });

  it('shows a visible watch indicator dot and status suffix when an open PR is watched, fixing, or needs human input', () => {
    const watchingBadge = renderBadge(
      [pr(9500, 'open')],
      false,
      makeAutofixCtx([makeWatch()]),
    );
    const watchingDot = watchingBadge.querySelector(
      '[data-autofix-pr-badge-state]',
    );
    expect(watchingDot?.getAttribute('data-autofix-pr-badge-state')).toBe(
      'watching',
    );
    expect(watchingDot?.className).toContain(badgeStyles.watchDotWatching);
    expect(
      watchingBadge.querySelector('a')?.getAttribute('aria-label'),
    ).toContain('Watching');

    const fixingBadge = renderBadge(
      [pr(9500, 'open')],
      false,
      makeAutofixCtx([
        makeWatch({
          fix: { attempt: '0123456789ab', startedAt: null, fresh: true },
        }),
      ]),
    );
    const fixingDot = fixingBadge.querySelector(
      '[data-autofix-pr-badge-state]',
    );
    expect(fixingDot?.getAttribute('data-autofix-pr-badge-state')).toBe(
      'fixing',
    );
    expect(fixingDot?.className).toContain(badgeStyles.watchDotFixing);

    const needsHumanBadge = renderBadge(
      [pr(9500, 'open')],
      false,
      makeAutofixCtx([
        makeWatch({
          needsHuman: [
            {
              sha: 'a'.repeat(40),
              at: '2026-11-28T00:00:00Z',
              text: 'Needs decision',
            },
          ],
        }),
      ]),
    );
    const needsHumanDot = needsHumanBadge.querySelector(
      '[data-autofix-pr-badge-state]',
    );
    expect(needsHumanDot?.getAttribute('data-autofix-pr-badge-state')).toBe(
      'needsHuman',
    );
    expect(needsHumanDot?.className).toContain(badgeStyles.watchDotAttention);
    expect(
      needsHumanBadge.querySelector('a')?.getAttribute('aria-label'),
    ).toContain('Needs you (1)');

    const mergedBadge = renderBadge(
      [pr(9500, 'merged')],
      false,
      makeAutofixCtx([makeWatch()]),
    );
    expect(
      mergedBadge.querySelector('[data-autofix-pr-badge-state]'),
    ).toBeNull();
  });
});

describe('openableSessionPrs', () => {
  it('keeps only openable bindings, in binding order', () => {
    // Bound later but numbered lower, so a sort by number cannot pass.
    const first = pr(9517, 'merged');
    const latest = pr(9500);
    expect(
      openableSessionPrs([
        { number: 1, url: 'javascript:alert(1)' },
        first,
        { number: 2, url: '   ' },
        latest,
      ]),
    ).toEqual([first, latest]);
  });
});
