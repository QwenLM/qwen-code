import { expect, test } from '@playwright/test';
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

type Schemas = components['schemas'];

// The diagnostics snapshots are shared camelCase/millis bodies on both wires;
// only the Session projection and the routes change.
const session = (
  title: string,
  lastSequence: number,
): Schemas['PublicSession'] => ({
  id: 's1',
  object: 'agent.session',
  agent_id: 'agent-a',
  agent_revision: '1',
  title,
  status: 'closed',
  created_at: 1790777114,
  updated_at: 1790777114,
  last_event_id: lastSequence,
  capabilities: {
    items: false,
    snapshots: false,
    resync: false,
    // The Public contract derives diagnostics from tasks.
    tasks: true,
    actions: false,
    artifacts: false,
    workspace_turns: false,
  },
});

const sessionList = (summary: Schemas['PublicSession']) => ({
  object: 'list',
  data: [summary],
  has_more: false,
  next_cursor: null,
});

const workspaceList = {
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
  capabilities: { workspace_context: false, workspace_binding: false },
  default_workspace: null,
};

const transcript = (lastSequence: number) => ({
  items: [],
  events: [],
  last_sequence: lastSequence,
  covered_sequence: lastSequence,
  older_cursor: null,
  has_more: false,
});

for (const width of [1280, 390]) {
  test(`Managed diagnostics read persisted snapshots at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    const unexpected: string[] = [];
    const errors: string[] = [];
    const diagnosticRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const summary = session('Persisted diagnostics', 0);
    await page.route('**/v1/agents/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      if (path === '/v1/agents/sessions' && method === 'GET')
        return route.fulfill({ json: sessionList(summary) });
      if (path === '/v1/agents/sessions/s1')
        return route.fulfill({ json: summary });
      if (path === '/v1/agents/workspaces')
        return route.fulfill({ json: workspaceList });
      if (path === '/v1/agents/runtime-nodes')
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path === '/v1/agents/sessions/s1/user-messages')
        return route.fulfill({ json: { paused: false, messages: [] } });
      if (path === '/v1/agents/sessions/s1/transcript')
        return route.fulfill({ json: transcript(0) });
      if (
        path === '/v1/agents/sessions/s1/events' &&
        url.searchParams.get('stream') === 'true'
      )
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      const snapshots: Record<string, unknown> = {
        'context-usage': { ...diagnosticContext, stale: true },
        stats: diagnosticStats,
        resources: diagnosticResources,
        'agent-trace': {
          ...diagnosticTrace,
          items: [{ ...diagnosticTrace.items[0], childSessionId: null }],
        },
      };
      for (const [name, snapshot] of Object.entries(snapshots)) {
        if (path === `/v1/agents/sessions/s1/${name}`) {
          expect(method).toBe('GET');
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
      'context-usage',
      'stats',
      'resources',
      'agent-trace',
    ]);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`Managed activity and lazy child diagnostics at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    const measuredItem: Schemas['ManagedActivityInvocation'] = {
      ...activityItem,
      measurements: {
        availability: 'available',
        sourceSequence: '9',
        executionDurationMs: '0',
        file: null,
      },
    };
    const errors: string[] = [];
    const unexpected: string[] = [];
    const activityRequests: Array<{ kind: string; cursor?: string }> = [];
    const traceRequests: string[] = [];
    const statisticsRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const summary = session('Persisted activity', 20);
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
        measurementStartSequence: '9',
        tools: {
          ...activityStatistics.statistics!.tools,
          measurements: {
            availability: 'available',
            recorded: '1',
            unsupported: '0',
            partial: '0',
            executionDurationMs: '0',
            executionDurationSamples: '1',
            fileSamples: '0',
            modelDiffSamples: '0',
            appliedDiffSamples: '0',
            modelLinesAdded: '0',
            modelLinesRemoved: '0',
            appliedLinesAdded: '0',
            appliedLinesRemoved: '0',
          },
        },
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
    await page.route('**/v1/agents/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const sessionId = /^\/v1\/agents\/sessions\/([^/]+)/.exec(path)?.[1];
      if (path === '/v1/agents/sessions' && method === 'GET')
        return route.fulfill({ json: sessionList(summary) });
      // Any Session read answers the parent summary, as the WebShell stub did.
      if (sessionId && path === `/v1/agents/sessions/${sessionId}`)
        return route.fulfill({ json: summary });
      if (path === '/v1/agents/workspaces')
        return route.fulfill({ json: workspaceList });
      if (path === '/v1/agents/runtime-nodes')
        return route.fulfill({ json: { supported: false, data: [] } });
      if (path === `/v1/agents/sessions/${sessionId}/user-messages`)
        return route.fulfill({ json: { paused: false, messages: [] } });
      if (path === `/v1/agents/sessions/${sessionId}/transcript`)
        return route.fulfill({ json: transcript(20) });
      if (
        path === `/v1/agents/sessions/${sessionId}/events` &&
        url.searchParams.get('stream') === 'true'
      )
        return route.fulfill({ contentType: 'text/event-stream', body: '' });
      if (path === '/v1/agents/sessions/s1/context-usage')
        return route.fulfill({ json: diagnosticContext });
      if (path === `/v1/agents/sessions/${sessionId}/stats`) {
        statisticsRequests.push(sessionId!);
        return route.fulfill({
          json: {
            ...diagnosticStats,
            sessionId,
            statistics:
              sessionId === 'child-a'
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
      if (path === '/v1/agents/sessions/s1/activity-stats') {
        expect(sessionId).toBe('s1');
        return route.fulfill({ json: statistics });
      }
      if (path === '/v1/agents/sessions/s1/activity') {
        expect(sessionId).toBe('s1');
        expect(url.searchParams.get('limit')).toBe('50');
        const kind = url.searchParams.get('kind')!;
        const cursor = url.searchParams.get('cursor') ?? undefined;
        activityRequests.push({ kind, cursor });
        const firstToolsPage = kind === 'tools' && !cursor;
        const items =
          kind === 'skills'
            ? [skillItem]
            : cursor
              ? [deniedItem]
              : [measuredItem];
        return route.fulfill({
          json: {
            ...header,
            kind,
            items,
            hasMore: firstToolsPage,
            nextCursor: firstToolsPage ? 'tools-page-2' : null,
          },
        });
      }
      if (path === `/v1/agents/sessions/${sessionId}/agent-trace`) {
        traceRequests.push(sessionId!);
        expect(url.searchParams.get('cursor')).toBeNull();
        if (sessionId === 's1')
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
        if (sessionId === 'child-a')
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
    await expect(dialog).toContainText('Mean measured duration');
    await expect(dialog).toContainText('0.0 ms');
    await expect(dialog).toContainText('First measurement sequence');
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
      'Partial',
    );
    await expect(
      readCall.locator('dt:has-text("Output capture") + dd'),
    ).toHaveText('Complete');
    await expect(
      readCall.locator('dt:has-text("Executor duration") + dd'),
    ).toHaveText('0 ms');
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
      'Partial',
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
