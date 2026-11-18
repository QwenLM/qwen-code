import { expect, test } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

for (const retryFrom of ['owner', 'foreign', 'restored-foreign']) {
  test(`accepted retry from ${retryFrom} clears the remounted owning composer and preserves a foreign draft @smoke`, async ({
    page,
  }) => {
    // Public wire: Session timestamps are epoch seconds.
    const sessions: Schemas['PublicSession'][] = ['a', 'b'].map((id) => ({
      id: `session-${id}`,
      object: 'agent.session',
      title: `Conversation ${id.toUpperCase()}`,
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
    }));
    const requests: Record<string, unknown>[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/v1/agents/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const sessionRoute = /^\/v1\/agents\/sessions\/([^/]+)(\/.*)?$/.exec(
        path,
      );
      const sessionId = sessionRoute?.[1];
      const suffix = sessionRoute?.[2] ?? '';
      const body = request.postDataJSON();
      if (path === '/v1/agents/runtime-nodes')
        return route.fulfill({ json: { supported: false, data: [] } });
      if (sessionId && suffix === '/user-messages')
        return route.fulfill({ json: { paused: false, messages: [] } });
      if (path === '/v1/agents/sessions' && method === 'GET')
        return route.fulfill({
          json: {
            object: 'list',
            data: sessions,
            has_more: false,
            next_cursor: null,
          },
        });
      if (sessionId && suffix === '' && method === 'GET')
        return route.fulfill({
          json: sessions.find((session) => session.id === sessionId),
        });
      if (path === '/v1/agents/workspaces')
        return route.fulfill({
          json: {
            object: 'list',
            data: [],
            has_more: false,
            next_cursor: null,
            capabilities: {
              workspace_context: false,
              workspace_binding: true,
            },
            default_workspace: null,
          },
        });
      if (sessionId && suffix === '/transcript')
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
        sessionId &&
        suffix === '/events' &&
        url.searchParams.get('stream') === 'true'
      )
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (sessionId && suffix === '/events' && method === 'POST') {
        // The Public input event carries type + input only; the idempotency
        // key travels as a header and the Session identity as the path.
        requests.push({
          sessionId,
          ...body,
          idempotencyKey: request.headers()['idempotency-key'],
        });
        return requests.length === 1
          ? route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'unconfirmed',
                  message: 'Unconfirmed admission',
                },
              },
            })
          : route.fulfill({
              status: 202,
              json: {
                session_id: sessionId,
                turn_id: 'accepted-turn',
                operation_id: 'submit-accepted-turn',
                admission_stage: 'java_durable',
                delivery_state: 'pending',
                status: 'accepted',
                replayed: true,
              },
            });
      }
      unexpected.push(path);
      return route.fulfill({
        status: 500,
        json: { error: `Unexpected request: ${path}` },
      });
    });

    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    const send = page.getByRole('button', {
      name: 'Send message',
      exact: true,
    });
    const choose = async (name: string) => {
      await page
        .getByRole('button', { name: new RegExp(`^Conversation ${name}\\b`) })
        .click();
      await expect(editor).toBeVisible();
    };
    await page.goto('/e2e/fixtures/managed-usability.html');
    await choose('B');
    await editor.fill('Unrelated B draft');
    await choose('A');
    await editor.fill('  Accepted A input  ');
    await editor.press('Enter');
    await expect(
      page.getByText('The previous message was not confirmed as submitted', {
        exact: false,
      }),
    ).toBeVisible();
    await choose('B');
    await expect(editor).toContainText('Unrelated B draft');
    if (retryFrom === 'restored-foreign') {
      await page.reload();
      await choose('B');
      await expect(editor).toContainText('Unrelated B draft');
    }
    if (retryFrom === 'owner') {
      await choose('A');
      await expect(editor).toContainText('Accepted A input');
    } else {
      // Exercise the redirect entry; the same banner also offers Retry and
      // Discard, covered by the test below.
      await page
        .getByRole('button', { name: 'Open the original conversation' })
        .click();
    }

    await page.getByRole('button', { name: 'Retry the same request' }).click();

    await expect(
      page.getByRole('button', { name: /^Conversation A\b/ }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).not.toContainText('Accepted A input');
    await expect(send).toBeDisabled();
    expect(requests).toHaveLength(2);
    expect(requests[0].sessionId).toBe('session-a');
    expect(requests[0].idempotencyKey).toEqual(expect.any(String));
    expect(requests[1]).toMatchObject({
      sessionId: 'session-a',
      type: 'agent.session.input.message',
      input: requests[0].input,
      idempotencyKey: requests[0].idempotencyKey,
    });
    await editor.press('Enter');
    await choose('B');
    await expect(editor).toContainText('Unrelated B draft');
    expect(requests).toHaveLength(2);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('a foreign pending keeps its composer editable and resolves through its owner @smoke', async ({
  page,
}) => {
  // Public wire: Session timestamps are epoch seconds.
  const sessions: Schemas['PublicSession'][] = ['a', 'b'].map((id) => ({
    id: `session-${id}`,
    object: 'agent.session',
    title: `Conversation ${id.toUpperCase()}`,
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
  }));
  const requests: Record<string, unknown>[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/v1/agents/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const sessionRoute = /^\/v1\/agents\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    const sessionId = sessionRoute?.[1];
    const suffix = sessionRoute?.[2] ?? '';
    const body = request.postDataJSON();
    if (path === '/v1/agents/runtime-nodes')
      return route.fulfill({ json: { supported: false, data: [] } });
    if (sessionId && suffix === '/user-messages')
      return route.fulfill({ json: { paused: false, messages: [] } });
    if (path === '/v1/agents/sessions' && method === 'GET')
      return route.fulfill({
        json: {
          object: 'list',
          data: sessions,
          has_more: false,
          next_cursor: null,
        },
      });
    if (sessionId && suffix === '' && method === 'GET')
      return route.fulfill({
        json: sessions.find((session) => session.id === sessionId),
      });
    if (path === '/v1/agents/workspaces')
      return route.fulfill({
        json: {
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: null,
          capabilities: {
            workspace_context: false,
            workspace_binding: true,
          },
          default_workspace: null,
        },
      });
    if (sessionId && suffix === '/transcript')
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
      sessionId &&
      suffix === '/events' &&
      url.searchParams.get('stream') === 'true'
    )
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (sessionId && suffix === '/events' && method === 'POST') {
      // The Public input event carries type + input only; the idempotency
      // key travels as a header and the Session identity as the path. This
      // foreign-pending case never confirms: every submit stays 503.
      requests.push({
        sessionId,
        ...body,
        idempotencyKey: request.headers()['idempotency-key'],
      });
      return route.fulfill({
        status: 503,
        json: {
          error: { code: 'unconfirmed', message: 'Unconfirmed admission' },
        },
      });
    }
    unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: `Unexpected request: ${path}` },
    });
  });

  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  const send = page.getByRole('button', {
    name: 'Send message',
    exact: true,
  });
  const choose = async (name: string) => {
    await page
      .getByRole('button', { name: new RegExp(`^Conversation ${name}\\b`) })
      .click();
    await expect(editor).toBeVisible();
  };

  // The foreign-pending banner only restacks below the 640px breakpoint, so
  // pin a narrow composer instead of the 1280px default this suite inherits.
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/e2e/fixtures/managed-usability.html');
  await choose('B');
  await editor.fill('Unrelated B draft');
  await choose('A');
  await editor.fill('For session A only');
  await editor.press('Enter');
  await expect(
    page.getByText('The previous message was not confirmed as submitted', {
      exact: false,
    }),
  ).toBeVisible();

  await choose('B');
  const foreignNotice = page.getByText(
    'Another conversation has an unconfirmed request',
    { exact: false },
  );
  await expect(foreignNotice).toBeVisible();
  // The record belongs to A: B keeps composing but cannot send, and offers
  // the same escapes instead of forcing a navigation to find them.
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(send).toBeDisabled();
  await editor.fill('Unrelated B draft, edited');
  await expect(editor).toContainText('Unrelated B draft, edited');
  const actions = [
    'Retry the same request',
    'Discard this request',
    'Open the original conversation',
  ].map((name) => page.getByRole('button', { name }));
  for (const action of actions) {
    await expect(action).toBeVisible();
    await expect(action).toBeEnabled();
    // Narrow composers stack the notice above the action row; a one-row
    // layout would push these buttons past the viewport edge.
    const box = (await action.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(480);
  }
  await expect
    .poll(async () => {
      const noticeBox = (await foreignNotice.boundingBox())!;
      const actionBox = (await actions[0].boundingBox())!;
      return actionBox.y - (noticeBox.y + noticeBox.height);
    })
    .toBeGreaterThan(0);

  // Only submission is gated: Enter reaches no submit and keeps the draft.
  // The unit harness swallows `submitDisabled`, so this is the only level
  // where a regression in the composer's submit guard turns red.
  await editor.focus();
  await editor.press('Enter');
  await expect.poll(() => requests.length).toBe(1);
  await expect(editor).toHaveText('Unrelated B draft, edited');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(send).toBeDisabled();

  // Discard resolves in the owner, restoring the draft that only A can hold.
  await page.getByRole('button', { name: 'Discard this request' }).click();
  await expect(
    page.getByRole('button', { name: /^Conversation A\b/ }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(editor).toContainText('For session A only');
  await expect(foreignNotice).toHaveCount(0);
  await choose('B');
  // The edit made before Discard must survive it: asserting the pre-edit
  // draft would pass even if Discard rolled the foreign composer back.
  await expect(editor).toHaveText('Unrelated B draft, edited');

  expect(requests).toHaveLength(1);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
