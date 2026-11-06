import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';
import {
  diagnosticContext,
  diagnosticResources,
  diagnosticStats,
  diagnosticTrace,
} from '../components/managed/managed-diagnostics.test-fixtures';
import {
  activityItem,
  activityStatistics,
} from '../components/managed/managed-activity.test-fixtures';
import type { components } from '../components/managed/generated/managed-agent-api';

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
    if (width === 390) {
      await dialog.evaluate((element) => {
        element.style.fontFamily = 'Verdana, sans-serif';
      });
    }
    const expectLayout = async () => {
      await expect
        .poll(() =>
          dialog.evaluate((element) => {
            const list = element.querySelector('[role="tablist"]')!;
            const listRect = list.getBoundingClientRect();
            const refresh = [...element.querySelectorAll('button')]
              .find((button) => button.textContent === 'Refresh')!
              .getBoundingClientRect();
            return (
              element.scrollWidth <= element.clientWidth &&
              [...list.querySelectorAll('[role="tab"]')].every((tab) => {
                const rect = tab.getBoundingClientRect();
                return (
                  rect.left >= listRect.left &&
                  rect.right <= listRect.right &&
                  rect.top >= listRect.top &&
                  rect.bottom <= listRect.bottom &&
                  (rect.bottom <= refresh.top ||
                    rect.top >= refresh.bottom ||
                    rect.right <= refresh.left ||
                    rect.left >= refresh.right)
                );
              })
            );
          }),
        )
        .toBe(true);
    };
    await expect(dialog).toContainText('System prompt');
    await expect(dialog).toContainText('predates a context change');
    await expectLayout();
    await dialog.getByRole('tab', { name: 'Statistics' }).click();
    await expect(dialog).toContainText('Counts belong to this Session');
    await expect(dialog).toContainText('Total tokens');
    await expectLayout();
    await dialog.getByRole('tab', { name: 'Resources', exact: true }).click();
    await expect(dialog).toContainText('manual-skill');
    await dialog.getByText('docs', { exact: false }).first().click();
    await expect(dialog).toContainText('Historical discovery');
    await expectLayout();
    await dialog.getByRole('tab', { name: 'Child agents' }).click();
    await expect(dialog).toContainText('Inspect changes');
    await expectLayout();
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

  test(`Managed activity and lazy child diagnostics at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    type Schemas = components['schemas'];
    const errors: string[] = [];
    const unexpected: string[] = [];
    const activityRequests: Array<{ kind: string; cursor?: string }> = [];
    const traceRequests: string[] = [];
    const statisticsRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const session: JavaAgentSession = {
      sessionId: 's1',
      agentId: 'agent-a',
      title: 'Persisted activity',
      status: 'closed',
      createdAt: 1,
      updatedAt: 1,
      lastSequence: 20,
      capabilities: { diagnostics: true, workspaceTurns: false },
    };
    const skill: Schemas['ManagedActivitySkill'] = {
      resourceKind: 'skill',
      name: 'review-skill',
      pin: 'sha256:pinned-review-instructions',
      origin: 'user',
      delivery: 'partial',
    };
    const skillItem: Schemas['ManagedActivityInvocation'] = {
      ...activityItem,
      invocationId: 'b'.repeat(64),
      assistantMessageId: 'assistant-skill',
      toolName: 'skill',
      functionCallId: 'call-skill',
      executionCallId: null,
      toolKind: 'hosted',
      file: null,
      skill,
    };
    const deniedItem: Schemas['ManagedActivityInvocation'] = {
      ...activityItem,
      invocationId: 'c'.repeat(64),
      assistantMessageId: 'assistant-denied',
      toolName: 'edit',
      functionCallId: 'call-denied',
      executionCallId: null,
      admission: 'denied',
      execution: 'not_started',
      delivery: 'complete',
      file: { operation: 'edit', path: 'src/denied.ts', cwdRelative: '.' },
    };
    const statistics: Schemas['ManagedDiagnosticActivityStats'] = {
      ...activityStatistics,
      statistics: {
        ...activityStatistics.statistics!,
        skills: activityStatistics.statistics!.tools,
        skillLoads: activityStatistics.statistics!.tools,
        skillBuckets: [
          {
            key: 'review-skill@pin',
            name: skill.name,
            resource: skill,
            metrics: activityStatistics.statistics!.tools,
          },
        ],
      },
    };
    const { statistics: _statistics, ...header } = activityStatistics;
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
            lastSequence: 20,
            coveredSequence: 20,
            hasMore: false,
          },
        });
      if (path.endsWith('/events/stream'))
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path.endsWith('/session-context-usage/query'))
        return route.fulfill({ json: diagnosticContext });
      if (path.endsWith('/session-stats/query')) {
        statisticsRequests.push(body.sessionId);
        return route.fulfill({
          json: {
            ...diagnosticStats,
            sessionId: body.sessionId,
            statistics:
              body.sessionId === 'child-a'
                ? {
                    ...diagnosticStats.statistics!,
                    totals: {
                      ...diagnosticStats.statistics!.totals,
                      requests: {
                        ...diagnosticStats.statistics!.totals.requests,
                        total: 2,
                        success: 2,
                      },
                      tokens: {
                        ...diagnosticStats.statistics!.totals.tokens,
                        total: 220,
                      },
                      usageKnown: {
                        ...diagnosticStats.statistics!.totals.usageKnown,
                        total: 2,
                      },
                    },
                  }
                : diagnosticStats.statistics,
          },
        });
      }
      if (path.endsWith('/session-activity-stats/query')) {
        expect(body.sessionId).toBe('s1');
        return route.fulfill({ json: statistics });
      }
      if (path.endsWith('/session-activity/query')) {
        expect(body.sessionId).toBe('s1');
        expect(body.limit).toBe(50);
        activityRequests.push({ kind: body.kind, cursor: body.cursor });
        const firstToolsPage = body.kind === 'tools' && !body.cursor;
        const items =
          body.kind === 'skills'
            ? [skillItem]
            : body.cursor
              ? [deniedItem]
              : [activityItem];
        return route.fulfill({
          json: {
            ...header,
            kind: body.kind,
            items,
            hasMore: firstToolsPage,
            nextCursor: firstToolsPage ? 'tools-page-2' : null,
          },
        });
      }
      if (path.endsWith('/session-agent-trace/query')) {
        traceRequests.push(body.sessionId);
        expect(body.cursor).toBeUndefined();
        if (body.sessionId === 's1')
          return route.fulfill({
            json: {
              ...diagnosticTrace,
              items: [
                {
                  ...diagnosticTrace.items[0],
                  predecessorTaskId: 'task-before',
                },
                {
                  ...diagnosticTrace.items[0],
                  taskId: 'task-unavailable',
                  childSessionId: null,
                  description: 'Unavailable invocation',
                },
              ],
            },
          });
        if (body.sessionId === 'child-a')
          return route.fulfill({
            json: {
              ...diagnosticTrace,
              sessionId: 'child-a',
              items: [
                {
                  ...diagnosticTrace.items[0],
                  taskId: 'task-grandchild',
                  parentSessionId: 'child-a',
                  childSessionId: 'grandchild-a',
                  description: 'Inspect tests',
                },
              ],
            },
          });
      }
      unexpected.push(path);
      return route.fulfill({
        status: 500,
        json: { error: 'Unexpected request' },
      });
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/e2e/fixtures/managed-usability.html?session=s1');
    await page.getByRole('button', { name: 'Session diagnostics' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Statistics', exact: true }).click();
    await dialog.getByRole('button', { name: 'Tools', exact: true }).click();
    await expect(dialog).toContainText('Observed since');
    await expect(dialog).toContainText(
      'Some observations are unavailable or incomplete.',
    );
    const readCall = dialog
      .locator('details')
      .filter({ hasText: 'assistant-1' });
    await readCall.locator('summary').click();
    await expect(readCall.locator('dt:has-text("Execution") + dd')).toHaveText(
      'Successful',
    );
    await expect(readCall.locator('dt:has-text("Delivery") + dd')).toHaveText(
      'Some observations are unavailable or incomplete.',
    );
    await expect(
      readCall.locator('dt:has-text("Output capture") + dd'),
    ).toHaveText('Complete');
    await page.screenshot({
      path: testInfo.outputPath('activity-tools.png'),
      animations: 'disabled',
    });
    await dialog
      .getByRole('button', { name: 'Next page', exact: true })
      .click();
    const deniedCall = dialog
      .locator('details')
      .filter({ hasText: 'assistant-denied' });
    await deniedCall.locator('summary').click();
    await expect(
      deniedCall.locator('dt:has-text("Admission") + dd'),
    ).toHaveText('Denied');
    await expect(
      deniedCall.locator('dt:has-text("Execution") + dd'),
    ).toHaveText('Not started');
    await expect(
      dialog.getByRole('button', { name: 'Next page', exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole('button', { name: 'Previous page', exact: true })
      .click();
    await expect(readCall).toBeVisible();
    await dialog
      .getByRole('button', { name: 'Explicit file operations', exact: true })
      .click();
    await expect(dialog).toContainText(
      'Only explicit file tools are included.',
    );
    await expect(dialog).toContainText('docs/说明.md');
    await dialog
      .getByRole('button', { name: 'Skill loading', exact: true })
      .click();
    const skillCall = dialog
      .locator('details')
      .filter({ hasText: 'assistant-skill' });
    await skillCall.locator('summary').click();
    await expect(skillCall).toContainText(skill.pin);
    await expect(skillCall).toContainText('User');
    await expect(skillCall.locator('dt:has-text("Delivery") + dd')).toHaveText(
      'Some observations are unavailable or incomplete.',
    );
    await page.screenshot({
      path: testInfo.outputPath('activity-skills.png'),
      animations: 'disabled',
    });
    await dialog
      .getByRole('tab', { name: 'Child agents', exact: true })
      .click();
    const root = dialog
      .locator('[role="treeitem"][aria-level="1"]')
      .filter({ hasText: 'Inspect changes' });
    await expect(root).toBeVisible();
    expect(traceRequests).toEqual(['s1']);
    expect(statisticsRequests).not.toContain('child-a');
    await expect(dialog).toContainText('Continues an earlier invocation');
    await expect(dialog).toContainText('Child Session is unavailable.');
    await root
      .getByRole('button', { name: 'Expand calls', exact: true })
      .click();
    await expect(
      dialog.locator('[role="treeitem"][aria-level="2"]'),
    ).toContainText('Inspect tests');
    expect(traceRequests).toEqual(['s1', 'child-a']);
    expect(statisticsRequests).not.toContain('child-a');
    await root
      .getByRole('button', { name: 'View own usage', exact: true })
      .first()
      .click();
    await expect(root).toContainText('Requests: 2 · Total tokens: 220');
    expect(statisticsRequests).toContain('child-a');
    await page.screenshot({
      path: testInfo.outputPath('activity-child-expanded.png'),
      animations: 'disabled',
    });
    await root
      .getByRole('button', { name: 'Collapse calls', exact: true })
      .click();
    await expect(
      dialog.locator('[role="treeitem"][aria-level="2"]'),
    ).toHaveCount(0);
    expect(traceRequests).toEqual(['s1', 'child-a']);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('activity-child-calls.png'),
      animations: 'disabled',
    });
    expect(activityRequests).toEqual([
      { kind: 'tools', cursor: undefined },
      { kind: 'tools', cursor: 'tools-page-2' },
      { kind: 'tools', cursor: undefined },
      { kind: 'files', cursor: undefined },
      { kind: 'skills', cursor: undefined },
    ]);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
