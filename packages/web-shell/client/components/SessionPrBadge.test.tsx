// @vitest-environment jsdom

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonSessionPrInfo } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { SessionPrBadge, openableSessionPrs } from './SessionPrBadge';
import styles from './SessionPrStateIcon.module.css';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function renderBadge(prs: DaemonSessionPrInfo[]): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <SessionPrBadge prs={prs} />
      </I18nProvider>,
    );
  });
  return container;
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

  it('renders nothing when no binding is openable', () => {
    expect(
      renderBadge([{ number: 1, url: 'javascript:alert(1)' }]).querySelector(
        'a',
      ),
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
