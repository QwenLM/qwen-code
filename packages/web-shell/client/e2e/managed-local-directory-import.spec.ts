import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`Managed imports a local directory without a registered parent at ${width}px @smoke`, async ({
    page,
  }) => {
    const imports: Record<string, unknown>[] = [];
    const browsed: Record<string, unknown>[] = [];
    const errors: string[] = [];
    let loseResponse = width === 390;
    const workspace = {
      workspaceId: 'ws-imported',
      displayName: 'Local project',
      state: 'active',
      canCreateSession: true,
      canSelectDirectory: true,
      defaultCwdRelative: 'project',
    };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/agent/web-shell/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON();
      if (path.endsWith('/runtime-nodes/query'))
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path.endsWith('/sessions/query'))
        return route.fulfill({ json: { data: [], hasMore: false } });
      if (path.endsWith('/workspaces/query'))
        return route.fulfill({
          json: {
            data: [],
            hasMore: false,
            capabilities: {
              workspaceBinding: true,
              localDirectoryImport: true,
            },
          },
        });
      if (path.endsWith('/workspaces/directories/query')) {
        expect(Object.keys(body)).toEqual(['localPath']);
        browsed.push(body);
        const root = body.localPath?.replace(/\/$/, '') || '/Users/local';
        return route.fulfill({
          json: {
            root,
            cwdRelative: '.',
            directories: [{ name: 'project', cwdRelative: 'project' }],
            truncated: false,
          },
        });
      }
      if (path.endsWith('/workspaces/create')) {
        imports.push(body);
        if (loseResponse) {
          loseResponse = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: workspace });
      }
      if (path.endsWith('/workspaces/get'))
        return route.fulfill({ json: workspace });
      if (path.endsWith('/workspaces/files/query'))
        return route.fulfill({ json: { data: [], truncated: false } });
      return route.fulfill({
        status: 500,
        json: { error: `Unexpected request: ${path}` },
      });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/e2e/fixtures/managed-usability.html');
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.fill('Keep this draft');
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .getByRole('menuitem', { name: 'Choose existing directory', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add Workspace' });
    await expect(dialog).toBeVisible();
    await expect(page.locator('#managed-directory-root-label')).toHaveCount(0);
    await expect(
      dialog.getByRole('combobox', { name: 'Directory path' }),
    ).toHaveValue('/Users/local/');
    await dialog.getByRole('button', { name: /^cancel$/i }).click();
    expect(imports).toEqual([]);
    await expect(editor).toHaveText('Keep this draft');
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page
      .getByRole('menuitem', { name: 'Choose existing directory', exact: true })
      .click();
    await dialog
      .getByRole('combobox', { name: 'Directory path' })
      .fill('/Users/local/project');
    await dialog
      .getByRole('textbox', { name: 'Display name (optional)' })
      .fill('Local project');
    await dialog
      .getByRole('button', { name: 'Add this folder', exact: true })
      .click();
    if (width === 390) {
      await page
        .getByRole('button', { name: 'Retry the same request', exact: true })
        .click();
      expect(imports).toHaveLength(2);
      expect(imports[1]).toEqual(imports[0]);
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(imports[0]).toEqual({
      displayName: 'Local project',
      localPath: '/Users/local/project',
      idempotencyKey: expect.any(String),
    });
    expect(browsed[0]).toEqual({ localPath: '' });
    await expect(editor).toHaveText('Keep this draft');
    await expect(
      page.getByRole('button', { name: 'Workspace', exact: true }),
    ).toContainText('Local project');
    expect(errors).toEqual([]);
  });
}
