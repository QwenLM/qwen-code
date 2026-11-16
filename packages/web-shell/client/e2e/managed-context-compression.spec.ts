import { expect, test } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

const SESSION_ID = 'compression-session';

for (const width of [1280, 390]) {
  test(`Managed context compression resumes after refresh at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    let complete = false;
    let queries = 0;
    const submissions: Record<string, unknown>[] = [];
    const turns: unknown[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const workspace: Schemas['PublicWorkspace'] = {
      id: 'ws',
      object: 'agent.workspace',
      display_name: 'Project',
      state: 'active',
      can_create_session: true,
    };
    // Public wire: Session timestamps are epoch seconds; model_context
    // observed_at stays epoch millis.
    const session = (): Schemas['PublicSession'] => ({
      id: SESSION_ID,
      object: 'agent.session',
      agent_id: 'agent-a',
      agent_revision: '1',
      title: 'Compression session',
      status: 'active',
      created_at: 1790777114,
      updated_at: 1790777114,
      last_event_id: 10,
      workspace: {
        workspace_id: 'ws',
        cwd_relative: '.',
        context_revision: 1,
        state: 'ready',
      },
      compaction_revision: complete ? 25 : 0,
      ...(submissions.length && !complete
        ? { context_compression_operation_id: 'compression-op' }
        : {}),
      model_context: complete
        ? undefined
        : {
            model_id: 'model-a',
            input_tokens: 4000,
            context_window_size: 10000,
            observed_at: 1790777114231,
          },
      capabilities: {
        items: false,
        snapshots: false,
        resync: false,
        workspace_turns: true,
        context_compression: true,
        actions: false,
        artifacts: false,
        tasks: false,
      },
    });
    const operation = (): Schemas['PublicContextCompressionOperation'] => ({
      session_id: SESSION_ID,
      id: 'compression-op',
      type: 'context_compression',
      status: complete ? 'completed' : 'running',
      expected_compaction_revision: 0,
      replayed: false,
      ...(complete ? { compaction_revision: 25, outcome: 'compressed' } : {}),
    });
    await page.route('**/v1/agents/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const body = request.postDataJSON();
      if (path === `/v1/agents/sessions/${SESSION_ID}/user-messages`)
        return route.fulfill({ json: { paused: false, messages: [] } });
      if (path === '/v1/agents/runtime-nodes')
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path === '/v1/agents/sessions' && method === 'GET')
        return route.fulfill({
          json: {
            object: 'list',
            data: [session()],
            has_more: false,
            next_cursor: null,
          },
        });
      if (path === `/v1/agents/sessions/${SESSION_ID}`)
        return route.fulfill({ json: session() });
      if (path === '/v1/agents/workspaces' && method === 'GET')
        return route.fulfill({
          json: {
            object: 'list',
            data: [workspace],
            has_more: false,
            next_cursor: null,
            capabilities: {
              workspace_context: false,
              workspace_binding: false,
            },
            default_workspace: null,
          },
        });
      if (path === '/v1/agents/workspaces/ws')
        return route.fulfill({ json: workspace });
      if (path === `/v1/agents/sessions/${SESSION_ID}/transcript`)
        return route.fulfill({
          json: {
            items: [],
            events: [],
            last_sequence: 10,
            covered_sequence: 10,
            older_cursor: null,
            has_more: false,
          },
        });
      if (
        path === `/v1/agents/sessions/${SESSION_ID}/events` &&
        url.searchParams.get('stream') === 'true'
      )
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path === `/v1/agents/sessions/${SESSION_ID}/compress`) {
        submissions.push({
          sessionId: SESSION_ID,
          ...body,
          idempotencyKey: request.headers()['idempotency-key'],
        });
        return route.fulfill({ status: 202, json: operation() });
      }
      if (
        path === `/v1/agents/sessions/${SESSION_ID}/operations/compression-op`
      ) {
        queries++;
        expect(method).toBe('GET');
        return route.fulfill({ json: operation() });
      }
      if (
        path === `/v1/agents/sessions/${SESSION_ID}/events` &&
        method === 'POST'
      ) {
        turns.push(body);
        return route.fulfill({
          status: 409,
          json: { error: { code: 'session_context_busy' } },
        });
      }
      return route.fulfill({
        status: 500,
        json: { error: `Unexpected request: ${path}` },
      });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(
      '/e2e/fixtures/managed-usability.html?session=compression-session',
    );
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await expect(editor).toBeVisible();
    await editor.fill('Keep this draft');
    const ring = page.locator('[data-web-shell-context-usage]');
    await ring.focus();
    await ring.press('ArrowDown');
    const popover = page.locator('[data-web-shell-context-popover]');
    await popover
      .getByRole('button', { name: 'Compress context', exact: true })
      .click();
    await expect(
      page.getByText('Compressing…', { exact: true }).first(),
    ).toBeVisible();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      sessionId: SESSION_ID,
      expected_compaction_revision: 0,
      idempotencyKey: expect.any(String),
    });
    await page.reload();
    await expect.poll(() => queries).toBeGreaterThan(0);
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    expect(submissions).toHaveLength(1);
    complete = true;
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).toHaveText('Keep this draft');
    await ring.focus();
    await ring.press('ArrowDown');
    await expect(popover).toContainText('Context usage has not been observed');
    await expect(popover).toContainText(
      'Compression completed. Context usage will be observed on the next turn.',
    );
    await expect(
      popover.getByRole('button', { name: 'Compress context', exact: true }),
    ).toBeEnabled();
    expect(submissions).toHaveLength(1);
    expect(turns).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('compression-completed.png'),
      animations: 'disabled',
    });
  });
}
