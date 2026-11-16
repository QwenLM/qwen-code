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
      // A foreign session owns no retry affordance: it redirects to the
      // conversation holding the pending prompt instead.
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
