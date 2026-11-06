import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';
import {
  diagnosticContext,
  diagnosticResources,
  diagnosticStats,
  diagnosticTrace,
} from '../components/managed/managed-diagnostics.test-fixtures';

for (const width of [1280, 390]) {
  test(`Managed diagnostics read persisted snapshots at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    const unexpected: string[] = [];
    const errors: string[] = [];
    const diagnosticRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const session: JavaAgentSession = {
      sessionId: 's1',
      agentId: 'agent-a',
      title: 'Persisted diagnostics',
      status: 'closed',
      createdAt: 1,
      updatedAt: 1,
      lastSequence: 0,
      capabilities: {
        tasks: true,
        actions: false,
        artifacts: false,
        diagnostics: true,
        workspaceTurns: false,
      },
    };
    await page.route('**/api/agent/web-shell/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().postDataJSON();
      if (path.endsWith('/sessions/query'))
        return route.fulfill({ json: { data: [session], hasMore: false } });
      if (path.endsWith('/sessions/get'))
        return route.fulfill({ json: session });
      if (path.endsWith('/workspaces/query'))
        return route.fulfill({ json: { data: [], hasMore: false } });
      if (path.endsWith('/runtime-nodes/query'))
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path.endsWith('/user-messages/query'))
        return route.fulfill({ json: { paused: false, messages: [] } });
      if (path.endsWith('/transcript/query'))
        return route.fulfill({
          json: {
            items: [],
            events: [],
            lastSequence: 0,
            coveredSequence: 0,
            hasMore: false,
          },
        });
      if (path.endsWith('/events/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      const snapshots = {
        'session-context-usage': { ...diagnosticContext, stale: true },
        'session-stats': diagnosticStats,
        'session-resources': diagnosticResources,
        'session-agent-trace': {
          ...diagnosticTrace,
          items: [{ ...diagnosticTrace.items[0], childSessionId: null }],
        },
      };
      for (const [name, snapshot] of Object.entries(snapshots)) {
        if (path.endsWith(`/${name}/query`)) {
          expect(body.sessionId).toBe('s1');
          diagnosticRequests.push(name);
          return route.fulfill({ json: snapshot });
        }
      }
      unexpected.push(path);
      return route.fulfill({
        status: 500,
        json: { error: 'Unexpected request' },
      });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/e2e/fixtures/managed-usability.html?session=s1');
    const trigger = page.getByRole('button', { name: 'Session diagnostics' });
    await expect(trigger).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(diagnosticRequests).toEqual([]);
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('System prompt');
    await expect(dialog).toContainText('predates a context change');
    await dialog.getByRole('tab', { name: 'Model statistics' }).click();
    await expect(dialog).toContainText('Counts belong to this Session');
    await expect(dialog).toContainText('Total tokens');
    await dialog.getByRole('tab', { name: 'Resources', exact: true }).click();
    await expect(dialog).toContainText('manual-skill');
    await dialog.getByText('docs', { exact: false }).first().click();
    await expect(dialog).toContainText('Historical discovery');
    await dialog.getByRole('tab', { name: 'Child agents' }).click();
    await expect(dialog).toContainText('Inspect changes');
    await expect(
      dialog.getByRole('button', { name: 'Open child Session' }),
    ).toHaveCount(0);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('diagnostics.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(diagnosticRequests).toEqual([
      'session-context-usage',
      'session-stats',
      'session-resources',
      'session-agent-trace',
    ]);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
