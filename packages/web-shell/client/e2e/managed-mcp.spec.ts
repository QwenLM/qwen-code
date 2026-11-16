import { expect, test } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

const SESSION_ID = 'managed-mcp-session';

for (const width of [1280, 390]) {
  test(`Managed MCP references use the selected Session catalog at ${width}px @smoke`, async ({
    page,
  }) => {
    let summary: Schemas['PublicSession'] | undefined;
    let queries = 0;
    let fail = true;
    let empty = false;
    let submitted: unknown;
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const workspace: Schemas['PublicWorkspace'] = {
      id: 'ws-mcp',
      object: 'agent.workspace',
      display_name: 'MCP project',
      can_create_session: true,
      state: 'active',
    };
    await page.route('**/v1/agents/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const body = request.postDataJSON();
      if (path.endsWith('/user-messages'))
        return route.fulfill({ json: { paused: false, messages: [] } });
      if (/^\/v1\/agents\/workspaces\/[^/]+\/extensions$/.test(path))
        return route.fulfill({ json: { supported: false, extensions: [] } });
      if (/^\/v1\/agents\/workspaces\/[^/]+\/worktrees\/options$/.test(path))
        return route.fulfill({
          json: {
            supported: true,
            base_commit: 'a'.repeat(40),
            branches: ['main'],
            current_branch: 'main',
          },
        });
      if (path === '/v1/agents/runtime-nodes')
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path === '/v1/agents/sessions' && method === 'GET')
        return route.fulfill({
          json: {
            object: 'list',
            data: summary ? [summary] : [],
            has_more: false,
            next_cursor: null,
          },
        });
      if (path === '/v1/agents/workspaces' && method === 'GET')
        return route.fulfill({
          json: {
            object: 'list',
            data: [workspace],
            has_more: false,
            next_cursor: null,
            capabilities: {
              workspace_context: false,
              workspace_binding: true,
            },
            default_workspace: null,
          },
        });
      if (path === '/v1/agents/workspaces/ws-mcp')
        return route.fulfill({ json: workspace });
      if (path === '/v1/agents/sessions' && method === 'POST') {
        // Public wire: Session/Turn timestamps are epoch seconds; the create
        // response is the Session itself, with the initial Turn in
        // latest_turn and the replay flag on a response header.
        summary = {
          id: SESSION_ID,
          object: 'agent.session',
          agent_id: body.agent_id,
          agent_revision: '1',
          status: 'active',
          created_at: 1790777114,
          updated_at: 1790777114,
          last_event_id: 0,
          latest_turn: {
            id: 'first',
            object: 'agent.turn',
            session_id: SESSION_ID,
            status: 'completed',
            created_at: 1790777114,
            completed_at: 1790777115,
          },
          workspace: {
            workspace_id: body.workspace.workspace_id,
            cwd_relative: body.workspace.cwd_relative,
            context_revision: 1,
            state: 'ready',
          },
          capabilities: {
            items: false,
            snapshots: false,
            resync: false,
            workspace_turns: true,
            actions: false,
            artifacts: false,
            tasks: false,
          },
        };
        return route.fulfill({
          status: 202,
          headers: { 'x-qwen-idempotent-replay': 'false' },
          json: summary,
        });
      }
      if (path === `/v1/agents/sessions/${SESSION_ID}`)
        return route.fulfill({ json: summary });
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
      if (path === `/v1/agents/sessions/${SESSION_ID}/mcp-catalog`) {
        expect(method).toBe('GET');
        queries++;
        if (fail)
          return route.fulfill({ status: 503, json: { error: 'offline' } });
        return route.fulfill({
          json: {
            object: 'agent.mcp_catalog',
            session_id: SESSION_ID,
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
      if (
        path === `/v1/agents/sessions/${SESSION_ID}/events` &&
        method === 'POST'
      ) {
        submitted = body.input;
        return route.fulfill({
          status: 202,
          json: {
            session_id: SESSION_ID,
            turn_id: 'mcp-turn',
            operation_id: 'submit-mcp-turn',
            admission_stage: 'java_durable',
            delivery_state: 'pending',
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
