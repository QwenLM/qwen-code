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
import styles from './SessionPrBadge.module.css';

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
  it('dims the badge when the latest bound PR is merged', () => {
    const container = renderBadge([pr(9517, 'merged')]);
    const badge = container.querySelector('a');
    expect(badge?.classList.contains(styles.sessionPrBadgeMerged)).toBe(true);
  });

  it('keeps the accent style for open or stateless bindings', () => {
    for (const state of ['open', undefined] as const) {
      const container = renderBadge([pr(9517, state)]);
      const badge = container.querySelector('a');
      expect(badge?.classList.contains(styles.sessionPrBadgeMerged)).toBe(
        false,
      );
    }
  });
});
