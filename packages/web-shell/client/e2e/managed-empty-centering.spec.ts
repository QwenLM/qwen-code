import { expect, test } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

const SESSION_ID = 'session-empty';

// The empty-state rule is layout behavior: jsdom performs no layout, so the
// component suite can only pin the `data-managed-empty` attribute. These run in
// a real browser and measure the pane, which is what the centering claim is
// actually about — the header must stay at the top and stay reachable once the
// centered group is taller than the pane.
test('managed empty state keeps the session header at the top and reachable @smoke', async ({
  page,
}) => {
  // Public wire: epoch seconds for the Session resource.
  const session: Schemas['PublicSession'] = {
    id: SESSION_ID,
    object: 'agent.session',
    title: 'Conversation with a deliberately long title to fill the header',
    agent_id: 'agent-a',
    agent_revision: '1',
    status: 'active',
    created_at: 1790777114,
    updated_at: 1790777114,
    last_event_id: 0,
    capabilities: {
      items: false,
      snapshots: false,
      resync: false,
      actions: false,
      artifacts: false,
      tasks: false,
      workspace_turns: false,
    },
  };
  await page.route('**/v1/agents/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body = route.request().postDataJSON();
    if (path === '/v1/agents/runtime-nodes')
      return route.fulfill({ json: { supported: false, data: [] } });
    if (path === `/v1/agents/sessions/${SESSION_ID}/user-messages`)
      return route.fulfill({ json: { paused: false, messages: [] } });
    if (path === '/v1/agents/sessions')
      return route.fulfill({
        json: {
          object: 'list',
          data: [session],
          has_more: false,
          next_cursor: null,
        },
      });
    if (path === `/v1/agents/sessions/${SESSION_ID}`)
      return route.fulfill({ json: session });
    if (path === '/v1/agents/workspaces')
      return route.fulfill({
        json: {
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: null,
          capabilities: { workspace_context: false, workspace_binding: true },
          default_workspace: null,
        },
      });
    if (path === `/v1/agents/sessions/${SESSION_ID}/transcript`)
      return route.fulfill({
        json: {
          items: [],
          events: [],
          last_sequence: 0,
          covered_sequence: 0,
          older_cursor: null,
          has_more: false,
        },
      });
    if (
      path === `/v1/agents/sessions/${SESSION_ID}/events` &&
      url.searchParams.get('stream') === 'true'
    )
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
