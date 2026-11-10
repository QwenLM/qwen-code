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

describe('GoalStatusMessage budget stop-reason', () => {
  it('renders the composed RU reason for a threaded budget card', async () => {
    await renderStatus(budgetCard, 'ru');
    expect(container!.textContent).toContain(
      'Цель исчерпала автономный бюджет токенов (30\u00A0000\u00A0000 токенов)',
    );
  });

  it('keeps the composed EN reason byte-identical to the recorded prose', async () => {
    await renderStatus(budgetCard, 'en');
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
    expect(container!.textContent).toContain('The provider rate-limited us.');
  });

  it('round-trips the threaded fields through serialize/parse', () => {
    expect(
      parseGoalStatusMessage(serializeGoalStatusMessage(budgetCard)),
    ).toEqual(budgetCard);
  });
});
