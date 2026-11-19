// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionGoalInfo } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { SessionGoalMarker } from './SessionGoalMarker';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const goal = (
  over: Partial<DaemonSessionGoalInfo> = {},
): DaemonSessionGoalInfo => ({
  status: 'active',
  objective: 'all tests pass',
  updatedAt: '2026-11-17T00:00:00.000Z',
  ...over,
});

function render(
  props: {
    goal?: DaemonSessionGoalInfo;
    onOpen?: () => void;
  } = {},
) {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <SessionGoalMarker
          goal={props.goal ?? goal()}
          {...(props.onOpen ? { onOpen: props.onOpen } : {})}
        />
      </I18nProvider>,
    );
  });
}

const marker = () =>
  container.querySelector<HTMLElement>('[data-testid="session-goal-marker"]');

describe('SessionGoalMarker', () => {
  it('renders the goal glyph with the running tone for an active goal', () => {
    render();
    expect(marker()).not.toBeNull();
    expect(marker()?.querySelector('svg')?.getAttribute('data-status')).toBe(
      'running',
    );
    expect(marker()?.querySelector('svg')).not.toBeNull();
  });

  it.each([
    ['paused', 'attention'],
    ['blocked', 'attention'],
    ['usage_limited', 'attention'],
  ] as const)('maps %s onto the %s tone', (status, tone) => {
    render({ goal: goal({ status }) });
    expect(marker()?.querySelector('svg')?.getAttribute('data-status')).toBe(
      tone,
    );
  });

  it('renders nothing for a completed goal (Goals listings filter it)', () => {
    render({ goal: goal({ status: 'complete' }) });
    expect(marker()).toBeNull();
  });

  it('names the marker with the localized status and the objective', () => {
    render({ goal: goal({ status: 'paused', objective: 'ship it' }) });
    expect(marker()?.getAttribute('aria-label')).toBe('Goal: Paused — ship it');
    expect(marker()?.getAttribute('title')).toBe('Goal: Paused — ship it');
  });

  it('is a pure indicator without onOpen (archived rows)', () => {
    render();
    expect(marker()?.tagName).toBe('SPAN');
    // A bare span with aria-label is role=generic and the name is not
    // exposed; role=img makes the indicator's label reachable.
    expect(marker()?.getAttribute('role')).toBe('img');
  });

  it('opens the session on click without bubbling to the row', () => {
    const onOpen = vi.fn();
    const rowClick = vi.fn();
    // The row handler is a React onClick on an ancestor — the same shape
    // the sidebar row uses — so synthetic stopPropagation must reach it.
    act(() => {
      root.render(
        <I18nProvider language="en">
          <div onClick={rowClick}>
            <SessionGoalMarker goal={goal()} onOpen={onOpen} />
          </div>
        </I18nProvider>,
      );
    });
    expect(marker()?.tagName).toBe('BUTTON');

    act(() => {
      marker()!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });

    expect(onOpen).toHaveBeenCalledOnce();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('stops Enter from bubbling to the row but lets other keys through', () => {
    const onOpen = vi.fn();
    const rowKeyDown = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <div onKeyDown={rowKeyDown}>
            <SessionGoalMarker goal={goal()} onOpen={onOpen} />
          </div>
        </I18nProvider>,
      );
    });

    act(() => {
      marker()!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(rowKeyDown).not.toHaveBeenCalled();

    act(() => {
      marker()!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(rowKeyDown).toHaveBeenCalledOnce();
  });

  it('stops a double-click from reaching the row rename handler', () => {
    const onOpen = vi.fn();
    const rowDoubleClick = vi.fn();
    // The sidebar row's onDoubleClick starts a rename. Without the marker's
    // own guard a double-click would both open the session and rename it.
    act(() => {
      root.render(
        <I18nProvider language="en">
          <div onDoubleClick={rowDoubleClick}>
            <SessionGoalMarker goal={goal()} onOpen={onOpen} />
          </div>
        </I18nProvider>,
      );
    });

    act(() => {
      marker()!.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      );
    });

    expect(rowDoubleClick).not.toHaveBeenCalled();
  });
});
