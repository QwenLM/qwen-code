import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`Managed remote Workspace registration preserves its request at ${width}px @smoke`, async ({
    page,
  }) => {
    const creates: Record<string, unknown>[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    let loseResponse = width === 390;
    let operationReads = 0;
    const workspace = {
      workspaceId: 'ws-remote',
      displayName: 'Remote project',
      canCreateSession: true,
      state: 'active',
    };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/agent/web-shell/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      expect(request.headers()['x-qwen-tenant-id']).toBe('managed-ui-test');
      if (path.endsWith('/sessions/query'))
        return route.fulfill({ json: { data: [], hasMore: false } });
      if (path.endsWith('/workspaces/query'))
        return route.fulfill({
          json: {
            data: [],
            hasMore: false,
            defaultWorkspace: null,
            capabilities: { workspaceBinding: true },
          },
        });
      if (path.endsWith('/runtime-nodes/query'))
        return route.fulfill({
          json: {
            supported: true,
            data: [{ nodeId: 'mac', displayName: 'Remote Mac' }],
          },
        });
      if (path.endsWith('/workspaces/check-directory')) {
        expect(body).toEqual({ nodeId: 'mac', path: '/projects/link' });
        return route.fulfill({
          json: {
            nodeId: 'mac',
            canonicalPath: '/projects/example',
            platform: 'darwin',
          },
        });
      }
      if (path.endsWith('/workspaces/register')) {
        creates.push(body);
        if (loseResponse) {
          loseResponse = false;
          return route.abort('failed');
        }
        return route.fulfill({
          status: 202,
          json: {
            operationId: 'workspace-registration',
            type: 'workspace_create',
            status: 'running',
            replayed: creates.length > 1,
          },
        });
      }
      if (path.endsWith('/workspaces/operations/get')) {
        operationReads++;
        expect(body).toEqual({ operationId: 'workspace-registration' });
        return route.fulfill({
          json: {
            operationId: 'workspace-registration',
            type: 'workspace_create',
            status: 'completed',
            workspaceId: 'ws-remote',
            replayed: false,
          },
        });
      }
      if (path.endsWith('/workspaces/get')) {
        expect(body).toEqual({ workspaceId: 'ws-remote' });
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
    ).toHaveText('Remote project');
    expect(creates).toHaveLength(width === 390 ? 2 : 1);
    expect(creates[0]).toMatchObject({
      nodeId: 'mac',
      path: '/projects/example',
      displayName: 'Remote project',
    });
    if (width === 390) {
      const { requestId: _first, ...first } = creates[0];
      const { requestId: _second, ...second } = creates[1];
      expect(second).toEqual(first);
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
