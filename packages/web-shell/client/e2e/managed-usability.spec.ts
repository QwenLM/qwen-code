import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';

for (const width of [1280, 390]) {
  test(`Managed native creation freezes model, Workspace and first input at ${width}px @smoke`, async ({
    page,
  }) => {
    const requests: Record<string, unknown>[] = [];
    let summary: JavaAgentSession | undefined;
    let laterInputs = 0;
    let skillQueries = 0;
    let skillInput: unknown;
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
      if (path.endsWith('/runtime-nodes/query'))
        return route.fulfill({ json: { supported: false, data: [] } });
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
      if (path.endsWith('/session-skills/query')) {
        expect(body).toEqual({ sessionId: 'managed-ui-session' });
        skillQueries++;
        return route.fulfill({
          json: {
            skills: [
              {
                name: 'repository-review',
                description: 'Review using the pinned guide.',
              },
            ],
          },
        });
      }
      if (path.endsWith('/turns/submit')) {
        laterInputs++;
        skillInput = body.input;
        return route.fulfill({
          status: 202,
          json: {
            sessionId: summary!.sessionId,
            turnId: 'skill-turn',
            status: 'accepted',
            replayed: false,
          },
        });
      }
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
    await expect(page.locator('[data-managed-model]')).toContainText('agent-b');
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
    expect(skillQueries).toBe(0);
    await editor.fill('inspect the patch');
    await page.getByTestId('composer-add-menu-trigger').click();
    await page.getByTestId('composer-add-menu-skills').click();
    await page.getByTestId('composer-add-menu-skills-item').click();
    await expect(editor).toHaveText('/repository-review inspect the patch');
    expect(skillQueries).toBe(1);
    await editor.press('Enter');
    await expect
      .poll(() => skillInput)
      .toEqual([
        { type: 'input_text', text: '/repository-review inspect the patch' },
      ]);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}

test('abandoning an unconfirmed first input warns about execution and refreshes Sessions @smoke', async ({
  page,
}) => {
  let admitted: JavaAgentSession | undefined;
  const requests: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  let queries = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const workspace = {
    workspaceId: 'ws-a',
    displayName: 'Project A',
    canCreateSession: true,
    state: 'active',
  };
  await page.route('**/api/agent/web-shell/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (path.endsWith('/runtime-nodes/query'))
      return route.fulfill({ json: { supported: false, data: [] } });
    if (path.endsWith('/sessions/query')) {
      queries++;
      return route.fulfill({
        json: { data: admitted ? [admitted] : [], hasMore: false },
      });
    }
    if (path.endsWith('/workspaces/query'))
      return route.fulfill({
        json: {
          data: [workspace],
          hasMore: false,
          capabilities: { workspaceBinding: true },
        },
      });
    if (path.endsWith('/workspaces/get'))
      return route.fulfill({ json: workspace });
    if (path.endsWith('/sessions/create')) {
      requests.push(body);
      admitted = {
        sessionId: 'orphan-session',
        title: 'Possibly admitted task',
        agentId: body.agentId,
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
        lastSequence: 0,
        workspace: { ...body.workspace, contextRevision: 1, state: 'ready' },
        capabilities: {
          actions: false,
          artifacts: false,
          tasks: false,
          workspaceTurns: true,
        },
      };
      await held;
      return route.abort('failed');
    }
    unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: `Unexpected request: ${path}` },
    });
  });
  await page.goto('/e2e/fixtures/managed-usability.html');
  await page.getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Project A' }).click();
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('Inspect README');
  await editor.press('Enter');
  await expect.poll(() => requests.length).toBe(1);
  try {
    await expect(
      page.getByText('Creation is unconfirmed', { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Abandon local confirmation' }),
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    page.getByText(
      'A session with this input may already exist or be running.',
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByText('may repeat its effects', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Possibly admitted task/ }),
  ).toHaveCount(0);
  const before = queries;
  await page
    .getByRole('button', { name: 'Abandon local confirmation' })
    .click();
  await expect(
    page.getByRole('button', { name: /Possibly admitted task/ }),
  ).toBeVisible();
  expect(queries).toBeGreaterThan(before);
  await expect(editor).toContainText('Inspect README');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  expect(requests).toHaveLength(1);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
