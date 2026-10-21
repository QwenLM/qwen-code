import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';

for (const width of [1280, 390]) {
  test(`Managed MCP references use the selected Session catalog at ${width}px @smoke`, async ({
    page,
  }) => {
    let summary: JavaAgentSession | undefined;
    let queries = 0;
    let fail = true;
    let empty = false;
    let submitted: unknown;
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const workspace = {
      workspaceId: 'ws-mcp',
      displayName: 'MCP project',
      canCreateSession: true,
      state: 'active',
    };
    await page.route('**/api/agent/web-shell/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON();
      if (path.endsWith('/runtime-nodes/query'))
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path.endsWith('/sessions/query'))
        return route.fulfill({
          json: { data: summary ? [summary] : [], hasMore: false },
        });
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
        summary = {
          sessionId: 'managed-mcp-session',
          agentId: body.agentId,
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          lastSequence: 0,
          workspace: { ...body.workspace, contextRevision: 1, state: 'ready' },
          capabilities: {
            workspaceTurns: true,
            actions: false,
            artifacts: false,
            tasks: false,
          },
        };
        return route.fulfill({
          status: 202,
          json: {
            sessionId: summary.sessionId,
            turnId: 'first',
            status: 'accepted',
            replayed: false,
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
      if (path.endsWith('/session-mcp/query')) {
        expect(body).toEqual({ sessionId: 'managed-mcp-session' });
        queries++;
        if (fail)
          return route.fulfill({ status: 503, json: { error: 'offline' } });
        return route.fulfill({
          json: {
            object: 'agent.mcp_catalog',
            session_id: 'managed-mcp-session',
            servers: empty
              ? []
              : [
                  {
                    server_id: 'docs',
                    server_revision: 1,
                    catalog_revision: 2,
                    tools: [{ name: 'search', input_schema: {} }],
                    resources: [{ name: 'guide', uri: 'docs://guide' }],
                    prompts: [],
                    discovery: {
                      tools: 'complete',
                      resources: 'partial',
                      prompts: 'stale',
                    },
                  },
                ],
          },
        });
      }
      if (path.endsWith('/turns/submit')) {
        submitted = body.input;
        return route.fulfill({
          status: 202,
          json: {
            sessionId: summary!.sessionId,
            turnId: 'mcp-turn',
            status: 'accepted',
            replayed: false,
          },
        });
      }
      unexpected.push(path);
      return route.fulfill({ status: 500, json: { error: path } });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/e2e/fixtures/managed-usability.html');
    await page.getByRole('button', { name: 'Workspace' }).click();
    await page.getByRole('menuitemradio', { name: 'MCP project' }).click();
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.fill('start');
    await editor.press('Enter');
    await expect(
      page.locator('[data-managed-workspace-binding]'),
    ).toContainText('ws-mcp');
    expect(queries).toBe(0);
    await editor.fill('inspect docs');
    const trigger = page.getByTestId('composer-add-menu-trigger');
    const openMcp = async () => {
      await trigger.click();
      const mcp = page.getByTestId('composer-add-menu-mcp');
      await expect(mcp).toBeEnabled({ timeout: 3_000 });
      await mcp.click();
    };
    const closeMcp = async () => {
      await page.keyboard.press('Escape');
      await expect(
        page.locator('[data-slot="dropdown-menu-content"]'),
      ).toHaveCount(0);
    };
    await openMcp();
    await expect(page.getByText('Failed to load results')).toBeVisible();
    await closeMcp();
    fail = false;
    await openMcp();
    const server = page.getByTestId('composer-add-menu-mcp-item');
    await expect(server).toContainText('docs');
    await expect(server).toContainText('Catalog snapshot');
    await expect(server.getByText(/Catalog snapshot/)).toBeVisible();
    await expect(server).toContainText('partial');
    await expect(server).toContainText('stale');
    await expect(server).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: test.info().outputPath('mcp-catalog.png') });
    await server.click();
    await expect(editor).toContainText('inspect docs');
    await expect(editor.getByText('docs', { exact: true })).toBeVisible();
    empty = true;
    await openMcp();
    await expect(page.getByTestId('composer-add-menu-mcp-none')).toBeVisible();
    await closeMcp();
    await editor.press('Enter');
    await expect
      .poll(() => submitted)
      .toEqual([
        { type: 'input_text', text: expect.stringContaining('@mcp:docs') },
      ]);
    expect(queries).toBe(3);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
