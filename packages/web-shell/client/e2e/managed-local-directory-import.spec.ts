import { expect, test } from '@playwright/test';
import type { components } from '../components/managed/generated/managed-agent-api';

type Schemas = components['schemas'];

for (const width of [1280, 390]) {
  test(`Managed imports a local directory without a registered parent at ${width}px @smoke`, async ({
    page,
  }) => {
    const imports: Record<string, unknown>[] = [];
    const browsed: Record<string, string>[] = [];
    const errors: string[] = [];
    let loseResponse = width === 390;
    const workspace: Schemas['PublicWorkspace'] = {
      id: 'ws-imported',
      object: 'agent.workspace',
      display_name: 'Local project',
      state: 'active',
      can_create_session: true,
      can_select_directory: true,
      default_cwd_relative: 'project',
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
      if (path === '/v1/agents/runtime-nodes')
        return route.fulfill({ json: { supported: false, data: [] } });
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
            capabilities: {
              workspace_context: false,
              workspace_binding: true,
              local_directory_import: true,
            },
            default_workspace: null,
          },
        });
      if (path === '/v1/agents/workspaces/directories') {
        expect([...url.searchParams.keys()]).toEqual(['local_path']);
        browsed.push(Object.fromEntries(url.searchParams));
        const localPath = url.searchParams.get('local_path') ?? '';
        const root = localPath.replace(/\/$/, '') || '/Users/local';
        return route.fulfill({
          json: {
            root,
            cwd_relative: '.',
            directories: [{ name: 'project', cwd_relative: 'project' }],
            truncated: false,
          },
        });
      }
      if (path === '/v1/agents/workspaces' && method === 'POST') {
        imports.push({
          ...body,
          idempotencyKey: request.headers()['idempotency-key'],
        });
        if (loseResponse) {
          loseResponse = false;
          return route.abort('failed');
        }
        return route.fulfill({
          json: {
            workspace_id: workspace.id,
            display_name: workspace.display_name,
            state: workspace.state,
            can_create_session: workspace.can_create_session,
            default_cwd_relative: workspace.default_cwd_relative ?? null,
            can_select_directory: workspace.can_select_directory ?? false,
          },
        });
      }
      if (path === '/v1/agents/workspaces/ws-imported')
        return route.fulfill({ json: workspace });
      if (path === '/v1/agents/workspace-files')
        return route.fulfill({
          json: {
            scope_revision: '1',
            directory: '.',
            entries: [],
            truncated: false,
          },
        });
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
    const dialog = page.getByRole('dialog', { name: 'Add workspace' });
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
      display_name: 'Local project',
      local_path: '/Users/local/project',
      idempotencyKey: expect.any(String),
    });
    expect(browsed[0]).toEqual({ local_path: '' });
    await expect(editor).toHaveText('Keep this draft');
    await expect(
      page.getByRole('button', { name: 'Workspace', exact: true }),
    ).toContainText('Local project');
    expect(errors).toEqual([]);
  });
}
