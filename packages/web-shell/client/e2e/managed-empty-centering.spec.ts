import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';

// The empty-state rule is layout behavior: jsdom performs no layout, so the
// component suite can only pin the `data-managed-empty` attribute. These run in
// a real browser and measure the pane, which is what the centering claim is
// actually about — the header must stay at the top and stay reachable once the
// centered group is taller than the pane.
test('managed empty state keeps the session header at the top and reachable @smoke', async ({
  page,
}) => {
  const session: JavaAgentSession = {
    sessionId: 'session-empty',
    title: 'Conversation with a deliberately long title to fill the header',
    agentId: 'agent-a',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    lastSequence: 0,
    capabilities: {
      actions: false,
      artifacts: false,
      tasks: false,
      workspaceTurns: false,
    },
  };
  await page.route('**/api/agent/web-shell/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (path.endsWith('/runtime-nodes/query'))
      return route.fulfill({ json: { supported: false, data: [] } });
    if (path.endsWith('/user-messages/query'))
      return route.fulfill({ json: { paused: false, messages: [] } });
    if (path.endsWith('/sessions/query'))
      return route.fulfill({ json: { data: [session], hasMore: false } });
    if (path.endsWith('/sessions/get')) return route.fulfill({ json: session });
    if (path.endsWith('/workspaces/query'))
      return route.fulfill({
        json: {
          data: [],
          hasMore: false,
          capabilities: { workspaceBinding: true },
        },
      });
    if (path.endsWith('/transcript/query'))
      return route.fulfill({
        json: {
          items: [],
          events: [],
          lastSequence: 0,
          coveredSequence: 0,
          hasMore: false,
        },
      });
    if (path.endsWith('/events/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    return route.fulfill({ json: body ?? {} });
  });

  await page.goto(
    '/e2e/fixtures/managed-empty-centering.html?session=session-empty',
  );
  const pane = page.locator('[data-managed-home]');
  await expect(pane).toHaveAttribute('data-managed-empty', 'true');
  const header = pane.getByTestId('chat-context-header');
  await expect(header).toBeVisible();

  const measure = () =>
    pane.evaluate((element) => {
      const headerBox = element
        .querySelector('[data-testid="chat-context-header"]')!
        .getBoundingClientRect();
      const paneBox = element.getBoundingClientRect();
      return {
        headerTop: headerBox.top - paneBox.top,
        paneHeight: paneBox.height,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    });

  const roomy = await measure();
  // The header is the pane's first in-flow child, so centering must not push it
  // away from the top edge.
  expect(roomy.headerTop).toBeGreaterThanOrEqual(0);
  expect(roomy.headerTop).toBeLessThan(roomy.paneHeight / 2);

  // Now make the centered group taller than the pane. `justify-content: center`
  // would overflow symmetrically and clamp scrollTop at 0, putting the header
  // permanently out of reach; auto margins collapse instead.
  await page.setViewportSize({ width: 1280, height: 240 });
  await expect
    .poll(async () => {
      const { scrollHeight, clientHeight } = await measure();
      return scrollHeight > clientHeight;
    })
    .toBe(true);
  const cramped = await measure();
  expect(cramped.headerTop).toBeGreaterThanOrEqual(0);
  await expect(header).toBeInViewport();
});
