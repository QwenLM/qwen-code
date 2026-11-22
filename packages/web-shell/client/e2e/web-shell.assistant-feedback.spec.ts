/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const PROMPT_ID = 'prompt-feedback-e2e';

interface FeedbackRequest {
  promptId: string;
  rating: string;
}

async function openFeedbackSession(
  page: Page,
  testInfo: TestInfo,
  opts: { feature?: boolean; failTelemetry?: boolean } = {},
): Promise<{ requests: FeedbackRequest[] }> {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('How do I mark an answer?', {
        id: 1,
        promptId: PROMPT_ID,
      }),
      assistantTextEvent('Use the marks below the answer.', { id: 2 }),
      turnCompleteEvent(PROMPT_ID, { id: 3 }),
    ],
  });
  if (opts.feature !== false) {
    scenario.capabilities.features.push('session_turn_feedback');
  }
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const requests: FeedbackRequest[] = [];
  // Registered after the mock daemon so this route wins over any catch-all.
  await page.route('**/session/*/feedback', (route) => {
    requests.push(route.request().postDataJSON() as FeedbackRequest);
    return route.fulfill({
      status: opts.failTelemetry ? 500 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        opts.failTelemetry ? { error: 'telemetry down' } : { recorded: true },
      ),
    });
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}?lang=en`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Use the marks below the answer.')).toBeVisible();
  return { requests };
}

function mark(page: Page, label: 'Satisfied' | 'Not satisfied') {
  return page.getByRole('button', { name: label, exact: true });
}

test('offers the marks and reports a satisfied mark', async ({
  page,
}, testInfo) => {
  const { requests } = await openFeedbackSession(page, testInfo);

  await mark(page, 'Satisfied').click();

  await expect(mark(page, 'Satisfied')).toHaveAttribute('aria-pressed', 'true');
  expect(requests).toEqual([{ promptId: PROMPT_ID, rating: 'up' }]);
});

test('reports a dissatisfied mark', async ({ page }, testInfo) => {
  const { requests } = await openFeedbackSession(page, testInfo);

  await mark(page, 'Not satisfied').click();

  await expect(mark(page, 'Not satisfied')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(requests).toEqual([{ promptId: PROMPT_ID, rating: 'down' }]);
});

test('clearing a lit mark sends nothing', async ({ page }, testInfo) => {
  const { requests } = await openFeedbackSession(page, testInfo);

  await mark(page, 'Satisfied').click();
  await mark(page, 'Satisfied').click();

  await expect(mark(page, 'Satisfied')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(requests).toEqual([{ promptId: PROMPT_ID, rating: 'up' }]);
});

test('switching marks reports the new direction', async ({
  page,
}, testInfo) => {
  const { requests } = await openFeedbackSession(page, testInfo);

  await mark(page, 'Satisfied').click();
  await mark(page, 'Not satisfied').click();

  await expect(mark(page, 'Satisfied')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(mark(page, 'Not satisfied')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(requests).toEqual([
    { promptId: PROMPT_ID, rating: 'up' },
    { promptId: PROMPT_ID, rating: 'down' },
  ]);
});

test('keeps the marks hidden without the capability', async ({
  page,
}, testInfo) => {
  await openFeedbackSession(page, testInfo, { feature: false });

  await expect(mark(page, 'Satisfied')).toHaveCount(0);
  await expect(mark(page, 'Not satisfied')).toHaveCount(0);
});

test('the mark stays lit when telemetry fails', async ({ page }, testInfo) => {
  const { requests } = await openFeedbackSession(page, testInfo, {
    failTelemetry: true,
  });

  await mark(page, 'Satisfied').click();

  await expect(mark(page, 'Satisfied')).toHaveAttribute('aria-pressed', 'true');
  expect(requests).toEqual([{ promptId: PROMPT_ID, rating: 'up' }]);
});
