import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';

for (const retryFrom of ['owner', 'foreign', 'restored-foreign']) {
  test(`accepted retry from ${retryFrom} clears the remounted owning composer and preserves a foreign draft @smoke`, async ({
    page,
  }) => {
    const sessions: JavaAgentSession[] = ['a', 'b'].map((id) => ({
      sessionId: `session-${id}`,
      title: `Conversation ${id.toUpperCase()}`,
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
    }));
    const requests: Record<string, unknown>[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/agent/web-shell/v1/**', async (route) => {
      if (
        new URL(route.request().url()).pathname.endsWith('/runtime-nodes/query')
      )
        return route.fulfill({ json: { supported: false, data: [] } });
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON();
      if (path.endsWith('/sessions/query'))
        return route.fulfill({ json: { data: sessions, hasMore: false } });
      if (path.endsWith('/sessions/get'))
        return route.fulfill({
          json: sessions.find(
            (session) => session.sessionId === body.sessionId,
          ),
        });
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
          json: { events: [], lastSequence: 0, hasMore: false },
        });
      if (path.endsWith('/events/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path.endsWith('/turns/submit')) {
        requests.push(body);
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
                sessionId: body.sessionId,
                turnId: 'accepted-turn',
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
        .getByRole('button', { name: new RegExp(`Conversation ${name}`) })
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
      page.getByText('The request outcome is unconfirmed', { exact: false }),
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
    }

    await page.getByRole('button', { name: 'Retry the same request' }).click();

    await expect(
      page.getByRole('button', { name: /Conversation A/ }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).not.toContainText('Accepted A input');
    await expect(send).toBeDisabled();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      sessionId: 'session-a',
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
