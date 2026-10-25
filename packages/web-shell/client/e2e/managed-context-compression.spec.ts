import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';

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
    const workspace = {
      workspaceId: 'ws',
      displayName: 'Project',
      state: 'active',
      canCreateSession: true,
    };
    const session = (): JavaAgentSession => ({
      sessionId: 'compression-session',
      agentId: 'agent-a',
      title: 'Compression session',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
      lastSequence: 10,
      workspace: {
        workspaceId: 'ws',
        cwdRelative: '.',
        contextRevision: 1,
        state: 'ready',
      },
      compactionRevision: complete ? 25 : 0,
      ...(submissions.length && !complete
        ? { contextCompressionOperationId: 'compression-op' }
        : {}),
      modelContext: complete
        ? undefined
        : {
            modelId: 'model-a',
            inputTokens: 4000,
            contextWindowSize: 10000,
            observedAt: 1,
          },
      capabilities: {
        workspaceTurns: true,
        contextCompression: true,
        actions: false,
        artifacts: false,
        tasks: false,
      },
    });
    const operation = () => ({
      sessionId: 'compression-session',
      operationId: 'compression-op',
      type: 'context_compression',
      status: complete ? 'completed' : 'running',
      expectedCompactionRevision: 0,
      replayed: false,
      ...(complete ? { compactionRevision: 25, outcome: 'compressed' } : {}),
    });
    await page.route('**/api/agent/web-shell/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON();
      if (path.endsWith('/user-messages/query'))
        return route.fulfill({ json: { paused: false, messages: [] } });
      if (path.endsWith('/runtime-nodes/query'))
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path.endsWith('/sessions/query'))
        return route.fulfill({ json: { data: [session()], hasMore: false } });
      if (path.endsWith('/sessions/get'))
        return route.fulfill({ json: session() });
      if (path.endsWith('/workspaces/query'))
        return route.fulfill({ json: { data: [workspace], hasMore: false } });
      if (path.endsWith('/workspaces/get'))
        return route.fulfill({ json: workspace });
      if (path.endsWith('/transcript/query'))
        return route.fulfill({
          json: { items: [], events: [], lastSequence: 10, hasMore: false },
        });
      if (path.endsWith('/events/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path.endsWith('/sessions/compress')) {
        submissions.push(body);
        return route.fulfill({ status: 202, json: operation() });
      }
      if (path.endsWith('/operations/query')) {
        queries++;
        expect(body).toEqual({
          sessionId: 'compression-session',
          operationId: 'compression-op',
        });
        return route.fulfill({ json: operation() });
      }
      if (path.endsWith('/turns/submit')) {
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
      sessionId: 'compression-session',
      expectedCompactionRevision: 0,
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
