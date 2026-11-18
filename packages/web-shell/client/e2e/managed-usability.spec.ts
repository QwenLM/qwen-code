import { expect, test } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

for (const width of [1280, 390]) {
  test(`Managed native creation freezes model, Workspace and first input at ${width}px @smoke`, async ({
    page,
  }) => {
    const requests: Record<string, unknown>[] = [];
    let summary: Schemas['PublicSession'] | undefined;
    let laterInputs = 0;
    let skillQueries = 0;
    let skillInput: unknown;
    let loseResponse = width === 390;
    const workspaces: Schemas['PublicWorkspace'][] = ['a', 'b'].map((id) => ({
      id: `ws-${id}`,
      object: 'agent.workspace',
      display_name: `Project ${id.toUpperCase()}`,
      can_create_session: true,
      state: 'active',
      ...(id === 'b' ? { default_cwd_relative: 'qwen-code' } : {}),
    }));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
            data: workspaces,
            has_more: false,
            next_cursor: null,
            capabilities: {
              workspace_context: false,
              workspace_binding: true,
            },
            default_workspace: null,
          },
        });
      if (/^\/v1\/agents\/workspaces\/ws-[ab]$/.test(path))
        return route.fulfill({
          json: workspaces.find(
            (item) => `/v1/agents/workspaces/${item.id}` === path,
          ),
        });
      if (path === '/v1/agents/sessions' && method === 'POST') {
        // The Public create body is snake_case, carries no requestId and
        // takes the idempotency key as a header; the admission is synthesized
        // from the returned Session's latest_turn.
        requests.push({
          ...body,
          idempotencyKey: request.headers()['idempotency-key'],
        });
        summary = {
          id: 'managed-ui-session',
          object: 'agent.session',
          agent_id: body.agent_id,
          agent_revision: '1',
          status: 'active',
          created_at: 1790777114,
          updated_at: 1790777114,
          last_event_id: 0,
          latest_turn: {
            id: 'initial-turn',
            object: 'agent.turn',
            session_id: 'managed-ui-session',
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
            actions: false,
            artifacts: false,
            tasks: false,
            workspace_turns: true,
          },
        };
        if (loseResponse) {
          loseResponse = false;
          return route.abort('failed');
        }
        return route.fulfill({
          status: 202,
          headers: {
            'x-qwen-idempotent-replay': requests.length > 1 ? 'true' : 'false',
          },
          json: summary,
        });
      }
      if (path === '/v1/agents/sessions/managed-ui-session')
        return route.fulfill({ json: summary });
      if (path === '/v1/agents/sessions/managed-ui-session/transcript')
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
        path === '/v1/agents/sessions/managed-ui-session/events' &&
        url.searchParams.get('stream') === 'true'
      )
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path === '/v1/agents/sessions/managed-ui-session/skills') {
        expect(method).toBe('GET');
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
      if (
        path === '/v1/agents/sessions/managed-ui-session/events' &&
        method === 'POST'
      ) {
        laterInputs++;
        skillInput = body.input;
        return route.fulfill({
          status: 202,
          json: {
            session_id: summary!.id,
            turn_id: 'skill-turn',
            operation_id: 'submit-skill-turn',
            admission_stage: 'java_durable',
            delivery_state: 'pending',
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
    await expect(page.locator('#managed-workspace-cwd')).toHaveCount(0);
    await expect(
      page.getByText('Relative directory', { exact: false }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole('region', { name: 'Managed conversation' })
        .getByRole('button', { name: 'Refresh', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Workspace' }).click();
    await page.getByRole('menuitemradio', { name: 'Project B' }).click();
    await page.getByRole('button', { name: /^Select Model:/ }).click();
    await page.getByText('Model B', { exact: true }).last().click();
    if (width === 390) {
      const sheet = page.locator('[data-web-shell-model-sheet]');
      await expect(sheet).toBeVisible();
      await sheet.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(sheet).toBeHidden();
    }
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
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .getByRole('menuitem', { name: 'Working directory', exact: true })
      .click();
    const directoryDialog = page.getByRole('dialog', {
      name: 'Working directory',
    });
    const directoryInput = directoryDialog.getByRole('textbox', {
      name: 'Directory relative to Workspace root',
    });
    await expect(directoryInput).toHaveValue('qwen-code');
    await directoryInput.fill('discarded');
    await directoryDialog
      .getByRole('button', { name: 'cancel', exact: true })
      .click();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .getByRole('menuitem', { name: 'Working directory', exact: true })
      .click();
    await expect(directoryInput).toHaveValue('qwen-code');
    await directoryInput.fill('qwen-code/services/api');
    await directoryDialog
      .getByRole('button', { name: 'save', exact: true })
      .click();
    await expect(editor.locator('.cm-line')).toHaveText(['!inspect', 'x']);
    await expect(page.locator('#managed-workspace-cwd')).toHaveCount(0);
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
      agent_id: 'agent-b',
      workspace: {
        workspace_id: 'ws-b',
        cwd_relative: 'qwen-code/services/api',
      },
      input: [{ type: 'input_text', text: '!inspect\nx' }],
    });
    expect(requests[0].idempotencyKey).toEqual(expect.any(String));
    if (width === 390) {
      // No requestId rides the Public body: the retry repeats it verbatim
      // under the same Idempotency-Key header.
      expect(requests[1]).toEqual(requests[0]);
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
  let admitted: Schemas['PublicSession'] | undefined;
  const requests: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  let queries = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const workspace: Schemas['PublicWorkspace'] = {
    id: 'ws-a',
    object: 'agent.workspace',
    display_name: 'Project A',
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
    if (path === '/v1/agents/sessions' && method === 'GET') {
      queries++;
      return route.fulfill({
        json: {
          object: 'list',
          data: admitted ? [admitted] : [],
          has_more: false,
          next_cursor: null,
        },
      });
    }
    if (path === '/v1/agents/workspaces' && method === 'GET')
      return route.fulfill({
        json: {
          object: 'list',
          data: [workspace],
          has_more: false,
          next_cursor: null,
          capabilities: { workspace_context: false, workspace_binding: true },
          default_workspace: null,
        },
      });
    if (path === '/v1/agents/workspaces/ws-a')
      return route.fulfill({ json: workspace });
    if (path === '/v1/agents/sessions' && method === 'POST') {
      requests.push(body);
      admitted = {
        id: 'orphan-session',
        object: 'agent.session',
        title: 'Possibly admitted task',
        agent_id: body.agent_id,
        agent_revision: '1',
        status: 'active',
        created_at: 1790777114,
        updated_at: 1790777114,
        last_event_id: 0,
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
          actions: false,
          artifacts: false,
          tasks: false,
          workspace_turns: true,
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
    page.getByRole('button', { name: /^Possibly admitted task\b/ }),
  ).toHaveCount(0);
  const before = queries;
  await page
    .getByRole('button', { name: 'Abandon local confirmation' })
    .click();
  await expect(
    page.getByRole('button', { name: /^Possibly admitted task\b/ }),
  ).toBeVisible();
  expect(queries).toBeGreaterThan(before);
  await expect(editor).toContainText('Inspect README');
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  expect(requests).toHaveLength(1);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
