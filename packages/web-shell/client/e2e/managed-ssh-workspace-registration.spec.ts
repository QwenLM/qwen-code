import { expect, test } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

for (const width of [1280, 390]) {
  test(`Managed remote Workspace registration preserves its request at ${width}px @smoke`, async ({
    page,
  }) => {
    const creates: Record<string, unknown>[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    let loseResponse = width === 390;
    let operationReads = 0;
    const workspace: Schemas['PublicWorkspace'] = {
      id: 'ws-remote',
      object: 'agent.workspace',
      display_name: 'Remote project',
      can_create_session: true,
      state: 'active',
    };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/v1/agents/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const body = request.postDataJSON();
      if (path.endsWith('/user-messages'))
        return route.fulfill({ json: { paused: false, messages: [] } });
      expect(request.headers()['x-qwen-tenant-id']).toBe('managed-ui-test');
      if (path === '/v1/agents/sessions' && method === 'GET')
        return route.fulfill({
          json: {
            object: 'list',
            data: [],
            has_more: false,
            next_cursor: null,
          },
        });
      if (path === '/v1/agents/workspaces' && method === 'GET')
        return route.fulfill({
          json: {
            object: 'list',
            data: [],
            has_more: false,
            next_cursor: null,
            default_workspace: null,
            capabilities: {
              workspace_context: false,
              workspace_binding: true,
            },
          },
        });
      if (/^\/v1\/agents\/workspaces\/[^/]+\/extensions$/.test(path))
        return route.fulfill({ json: { supported: false, extensions: [] } });
      if (/^\/v1\/agents\/workspaces\/[^/]+\/worktrees\/options$/.test(path))
        return route.fulfill({
          json: {
            supported: false,
            reason: 'worktree_unsupported',
            branches: [],
          },
        });
      if (path === '/v1/agents/runtime-nodes')
        return route.fulfill({
          json: {
            supported: true,
            data: [{ node_id: 'mac', display_name: 'Remote Mac' }],
          },
        });
      if (path === '/v1/agents/runtime-nodes/mac/check-directory') {
        expect(method).toBe('POST');
        expect(body).toEqual({ path: '/projects/link' });
        return route.fulfill({
          json: {
            node_id: 'mac',
            canonical_path: '/projects/example',
            platform: 'darwin',
          },
        });
      }
      if (path === '/v1/agents/workspaces/registrations' && method === 'POST') {
        creates.push({
          ...body,
          idempotencyKey: request.headers()['idempotency-key'],
        });
        if (loseResponse) {
          loseResponse = false;
          return route.abort('failed');
        }
        return route.fulfill({
          status: 202,
          json: {
            operation_id: 'workspace-registration',
            type: 'workspace_create',
            status: 'running',
            replayed: creates.length > 1,
          },
        });
      }
      if (
        path === '/v1/agents/workspaces/registrations/workspace-registration'
      ) {
        operationReads++;
        expect(method).toBe('GET');
        return route.fulfill({
          json: {
            operation_id: 'workspace-registration',
            type: 'workspace_create',
            status: 'completed',
            workspace_id: 'ws-remote',
            replayed: false,
          },
        });
      }
      if (path === '/v1/agents/workspaces/ws-remote') {
        expect(method).toBe('GET');
        return route.fulfill({ json: workspace });
      }
      unexpected.push(path);
      return route.fulfill({
        status: 500,
        json: { error: 'Unexpected request' },
      });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/e2e/fixtures/managed-usability.html');
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .getByRole('menuitem', { name: 'New workspace', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Use an existing folder…', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add Workspace' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Machine' }).click();
    await page.getByRole('option', { name: 'Remote Mac', exact: true }).click();
    await dialog.getByLabel('Directory on this machine').fill('/projects/link');
    await dialog.getByLabel('Workspace name').fill('Remote project');
    await dialog
      .getByRole('button', { name: 'Check directory', exact: true })
      .click();
    await expect(dialog.getByRole('status')).toHaveText('/projects/example');
    await dialog
      .getByRole('button', { name: 'Register Workspace', exact: true })
      .click();
    if (width === 390) {
      await expect(dialog.getByRole('alert')).toContainText('unconfirmed');
      await page.reload();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByLabel('Directory on this machine'),
      ).toBeDisabled();
      await dialog
        .getByRole('button', {
          name: 'Continue confirming registration',
          exact: true,
        })
        .click();
    }
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Workspace', exact: true }),
    ).toHaveText('Remote project · Managed');
    expect(creates).toHaveLength(width === 390 ? 2 : 1);
    expect(creates[0]).toMatchObject({
      node_id: 'mac',
      path: '/projects/example',
      display_name: 'Remote project',
    });
    expect(creates[0].idempotencyKey).toEqual(expect.any(String));
    if (width === 390) {
      // The Public body carries no requestId: a retry repeats the body
      // verbatim under the same Idempotency-Key header.
      expect(creates[1]).toEqual(creates[0]);
    }
    expect(operationReads).toBe(1);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
