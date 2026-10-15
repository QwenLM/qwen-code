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
import { SessionPrBadge } from './SessionPrBadge';
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
});
