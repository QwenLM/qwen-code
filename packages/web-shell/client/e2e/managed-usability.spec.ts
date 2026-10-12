import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';

for (const width of [1280, 390]) {
  test(`Managed native creation freezes model, Workspace and first input at ${width}px @smoke`, async ({
    page,
  }) => {
    const requests: Record<string, unknown>[] = [];
    let summary: JavaAgentSession | undefined;
    let laterInputs = 0;
    let loseResponse = width === 390;
    const workspaces = ['a', 'b'].map((id) => ({
      workspaceId: `ws-${id}`,
      displayName: `Project ${id.toUpperCase()}`,
      canCreateSession: true,
      state: 'active',
    }));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/agent/web-shell/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      if (path.endsWith('/sessions/query'))
        return route.fulfill({
          json: { data: summary ? [summary] : [], hasMore: false },
        });
      if (path.endsWith('/workspaces/query'))
        return route.fulfill({
          json: {
            data: workspaces,
            hasMore: false,
            capabilities: { workspaceBinding: true },
          },
        });
      if (path.endsWith('/workspaces/get'))
        return route.fulfill({
          json: workspaces.find(
            (item) => item.workspaceId === body.workspaceId,
          ),
        });
      if (path.endsWith('/sessions/create')) {
        requests.push(body);
        summary = {
          sessionId: 'managed-ui-session',
          agentId: body.agentId,
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          lastSequence: 0,
          activeTurn: {
            sessionId: 'managed-ui-session',
            turnId: 'initial-turn',
            status: 'completed',
            submittedAt: 1,
          },
          workspace: { ...body.workspace, contextRevision: 1, state: 'ready' },
          capabilities: {
            actions: false,
            artifacts: false,
            tasks: false,
            workspaceTurns: true,
          },
        };
        if (loseResponse) {
          loseResponse = false;
          return route.abort('failed');
        }
        return route.fulfill({
          status: 202,
          json: {
            sessionId: summary.sessionId,
            turnId: 'initial-turn',
            status: 'accepted',
            replayed: requests.length > 1,
          },
        });
      }
      if (path.endsWith('/sessions/get'))
        return route.fulfill({ json: summary });
      if (path.endsWith('/transcript/query'))
        return route.fulfill({
          json: { events: [], lastSequence: 0, hasMore: false },
        });
      if (path.endsWith('/events/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path.endsWith('/turns/submit')) laterInputs++;
      return route.fulfill({
        status: 500,
        json: { error: `Unexpected request: ${path}` },
      });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/e2e/fixtures/managed-usability.html');
    await expect(page.locator('[data-managed-standard-chat]')).toContainText(
      'Welcome to',
    );
    await page.getByRole('button', { name: 'Workspace' }).click();
    await page.getByRole('menuitemradio', { name: 'Project B' }).click();
    await page.getByRole('button', { name: /^Select Model:/ }).click();
    await page.getByText('Model B', { exact: true }).last().click();
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await expect(
      page.locator('[data-web-shell-composer-editor]'),
    ).toBeInViewport();
    expect(
      (await page.locator('[data-web-shell-composer-editor]').boundingBox())!
        .width,
    ).toBeGreaterThan(width === 1280 ? 500 : 220);
    await editor.fill('!inspect');
    await editor.press('Shift+Enter');
    await editor.press('x');
    await expect(editor.locator('.cm-line')).toHaveText(['!inspect', 'x']);
    await expect(page.getByRole('button', { name: 'Shell mode' })).toHaveCount(
      0,
    );
    await editor.press('Enter');
    if (width === 390) {
      await expect(
        page.getByText('Creation is unconfirmed', { exact: false }),
      ).toBeVisible();
      await page.reload();
      await page
        .getByRole('button', { name: 'Retry the same request' })
        .click();
    }
    await expect(
      page.locator('[data-managed-workspace-binding]'),
    ).toContainText('ws-b');
    await expect(page.locator('[data-managed-model]')).toContainText('Model B');
    expect(requests).toHaveLength(width === 390 ? 2 : 1);
    expect(requests[0]).toMatchObject({
      agentId: 'agent-b',
      workspace: { workspaceId: 'ws-b', cwdRelative: '.' },
      input: [{ type: 'input_text', text: '!inspect\nx' }],
    });
    if (width === 390) {
      const { requestId: _first, ...first } = requests[0];
      const { requestId: _second, ...second } = requests[1];
      expect(second).toEqual(first);
    }
    expect(laterInputs).toBe(0);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
