// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { I18nProvider, type WebShellLanguage } from '../../i18n';
import {
  GoalStatusMessage,
  parseGoalStatusMessage,
  serializeGoalStatusMessage,
  type SerializedGoalStatusMessage,
} from './GoalStatusMessage';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderStatus(
  status: SerializedGoalStatusMessage,
  language: WebShellLanguage = 'en',
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language={language}>
        <GoalStatusMessage status={status} />
      </I18nProvider>,
    );
  });
}

const budgetCard: SerializedGoalStatusMessage = {
  kind: 'usage_limited',
  condition: 'ship the release notes',
  lastReason:
    'The Goal spent its autonomous token budget (30,000,000 tokens). Resume the Goal to authorize another budget window, or clear it.',
  limitKind: 'token_budget',
  tokenBudget: 30_000_000,
};

// The stop reason renders inside the collapsible details; open them first.
function expandDetails() {
  const toggle = container!.querySelector('button')!;
  act(() => toggle.click());
}

describe('GoalStatusMessage budget stop-reason', () => {
  it('renders the composed RU reason for a threaded budget card', async () => {
    await renderStatus(budgetCard, 'ru');
    expandDetails();
    expect(container!.textContent).toContain(
      'Цель исчерпала автономный бюджет токенов (30\u00A0000\u00A0000 токенов)',
    );
  });

  it('keeps the composed EN reason byte-identical to the recorded prose', async () => {
    await renderStatus(budgetCard, 'en');
    expandDetails();
    expect(container!.textContent).toContain(budgetCard.lastReason);
  });

  it('keeps the raw reason for a card without budget fields', async () => {
    await renderStatus(
      {
        kind: 'usage_limited',
        condition: 'ship the release notes',
        lastReason: 'The provider rate-limited us.',
      },
      'ru',
    );
    expandDetails();
    expect(container!.textContent).toContain('The provider rate-limited us.');
  });

  it('round-trips the threaded fields through serialize/parse', () => {
    expect(
      parseGoalStatusMessage(serializeGoalStatusMessage(budgetCard)),
    ).toEqual(budgetCard);
  });
});

it('starts compact and toggles the complete objective and check reason', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const condition = 'Generate ideas\nPreserve the complete objective.';
  try {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <GoalStatusMessage
            status={{
              kind: 'achieved',
              condition,
              iterations: 4,
              durationMs: 60_000,
              lastReason: 'Output was written and read back.',
            }}
          />
        </I18nProvider>,
      );
    });
    const toggle = container.querySelector('button')!;
    expect(container.textContent).toContain('目标已达成');
    expect(container.textContent).toContain('4 轮');
    expect(container.textContent).toContain('1m 0s');
    expect(toggle.textContent).toBe('展开详情');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Output was written');

    act(() => toggle.click());
    expect(toggle.textContent).toBe('收起详情');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = document.getElementById(
      toggle.getAttribute('aria-controls')!,
    )!;
    expect(details.firstElementChild?.textContent).toBe(condition);
    expect(details.textContent).toContain(
      '上次检查: Output was written and read back.',
    );

    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Output was written');
    expect(container.textContent).toContain(condition);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
