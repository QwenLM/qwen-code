import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  thoughtTextEvent,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';

function stamp(
  event: DaemonEvent,
  promptId: string,
  recordId: string,
): DaemonEvent {
  const data = event.data as { update: Record<string, unknown> };
  return {
    ...event,
    data: {
      ...data,
      update: {
        ...data.update,
        _meta: { promptId, 'qwen.session.recordId': recordId },
      },
    },
  };
}

for (const code of [
  'transport',
  'unsupported_operation',
  'session_message_deletion_unsupported',
]) {
  test(`listing failure explains ${code} accurately @smoke`, async ({
    page,
  }, info) => {
    await setup(page, String(info.project.use.baseURL));
    await page.route('**/session/*/message-groups', (route) =>
      code === 'transport'
        ? route.abort('failed')
        : route.fulfill({
            status: code === 'unsupported_operation' ? 400 : 422,
            json: { error: 'Unsupported storage', code },
          }),
    );
    await startDeletion(
      page,
      page
        .getByRole('button', { name: 'More message actions', exact: true })
        .last(),
    );
    await expect(
      page.locator('[data-web-shell-message-deletion] [role="alert"]'),
    ).toHaveText(
      code === 'transport'
        ? 'Unable to delete messages. Please reload and try again.'
        : 'Deleting saved messages is not supported for this session.',
    );
    await expect(
      page.getByRole('checkbox', { name: 'Select message group' }),
    ).toHaveCount(0);
  });
}

for (const code of [
  'unsupported_operation',
  'session_message_deletion_unsupported',
]) {
  test(`unsupported deletion explains ${code} without a reload loop @smoke`, async ({
    page,
  }, info) => {
    await setup(page, String(info.project.use.baseURL));
    await page.route('**/session/*/messages/delete', (route) =>
      route.fulfill({
        status: code === 'unsupported_operation' ? 400 : 422,
        json: { error: 'Unsupported storage', code },
      }),
    );
    await startDeletion(
      page,
      page
        .getByRole('button', { name: 'More message actions', exact: true })
        .last(),
    );
    await page
      .getByRole('button', { name: 'Delete selected', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Delete permanently', exact: true })
      .click();
    await expect(
      page.locator('[data-web-shell-message-deletion] [role="alert"]'),
    ).toHaveText('Deleting saved messages is not supported for this session.');
    await expect(page.getByText('Question 3', { exact: true })).toBeVisible();
  });
}

test('unmatched saved history keeps its specific listing explanation @smoke', async ({
  page,
}, info) => {
  await setup(page, String(info.project.use.baseURL));
  await page.route('**/session/*/message-groups', (route) =>
    route.fulfill({ json: { snapshot: 'empty', groups: [] } }),
  );
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .last(),
  );
  await expect(
    page.locator('[data-web-shell-message-deletion] [role="alert"]'),
  ).toContainText('cannot be safely matched');
});

test('confirmation disables if a peer starts streaming after it opens @smoke', async ({
  page,
}, info) => {
  const { daemon, deletions } = await setup(
    page,
    String(info.project.use.baseURL),
  );
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .last(),
  );
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  const confirm = page.getByRole('button', {
    name: 'Delete permanently',
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await daemon.sendEvent(
    stamp(
      assistantTextEvent('Concurrent peer output', { id: 99 }),
      'peer-running',
      'peer-answer',
    ),
  );
  await expect(confirm).toBeDisabled();
  expect(deletions).toEqual([]);
});

test('peer deletion clears an active selection and its confirmation @smoke', async ({
  page,
}, info) => {
  const { daemon, scenario, groups } = await setup(
    page,
    String(info.project.use.baseURL),
  );
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .last(),
  );
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  scenario.events = scenario.events.filter((event) => {
    const data = event.data as {
      update?: { _meta?: { promptId?: string } };
      promptId?: string;
    };
    return (data.update?._meta?.promptId ?? data.promptId) !== 'p2';
  });
  groups.splice(2, 1);
  await daemon.sendEvent({
    v: 1,
    type: 'session_messages_deleted',
    originatorClientId: 'peer',
    data: {
      sessionId: scenario.sessionId,
      deletedGroupIds: ['u2'],
      deletedPromptIds: ['p2'],
    },
  });
  await expect(page.getByText('Question 3', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: 'Select message group' }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-web-shell-message-deletion] [role="alert"]'),
  ).toContainText('Select the messages again');
});

async function setup(
  page: import('@playwright/test').Page,
  baseURL: string,
  count = 3,
  withSteps = false,
  language = 'en',
) {
  const events = Array.from({ length: count }, (_, index) => [
    stamp(
      userTextEvent(`Question ${index + 1}`, { id: index * 5 + 1 }),
      `p${index}`,
      `u${index}`,
    ),
    ...(withSteps && index === count - 1
      ? [
          stamp(
            thoughtTextEvent('Synthetic thinking', { id: index * 5 + 2 }),
            `p${index}`,
            `thinking${index}`,
          ),
          stamp(
            toolCallEvent(
              'selection-tool',
              'grep_search',
              { pattern: 'fixture' },
              {
                id: index * 5 + 3,
                rawOutput: { output: 'Synthetic tool result' },
              },
            ),
            `p${index}`,
            `tool${index}`,
          ),
        ]
      : []),
    stamp(
      assistantTextEvent(`Answer ${index + 1}`, { id: index * 5 + 4 }),
      `p${index}`,
      `a${index}`,
    ),
    turnCompleteEvent(`p${index}`, { id: index * 5 + 5 }),
  ]).flat();
  const scenario = createWebShellDaemonScenario({ events });
  scenario.capabilities.features.push('session_message_deletion');
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const groups = Array.from({ length: count }, (_, index) => ({
    id: `u${index}`,
    promptId: `p${index}`,
    recordIds: [
      `u${index}`,
      ...(withSteps && index === count - 1
        ? [`thinking${index}`, `tool${index}`]
        : []),
      `a${index}`,
    ],
  }));
  const deletions: unknown[] = [];
  let fail = false;
  let committedFailure = false;
  let busy = false;
  let snapshot = 'snapshot-1';
  await page.route('**/session/*/message-groups', (route) =>
    route.fulfill({ json: { snapshot, groups } }),
  );
  await page.route('**/session/*/messages/delete', async (route) => {
    const body = route.request().postDataJSON() as { groupIds: string[] };
    deletions.push(body);
    if (busy) {
      await route.fulfill({
        status: 409,
        json: { error: 'Session is busy', code: 'session_busy' },
      });
      return;
    }
    if (fail) {
      await route.fulfill({
        status: 409,
        json: {
          error: 'History changed; reload before deleting.',
          code: 'message_groups_conflict',
        },
      });
      return;
    }
    const removed = new Set(body.groupIds.map((id) => `p${id.slice(1)}`));
    scenario.events = scenario.events.filter((event) => {
      const data = event.data as {
        update?: { _meta?: { promptId?: string } };
        promptId?: string;
      };
      return !removed.has(data.update?._meta?.promptId ?? data.promptId ?? '');
    });
    await route.fulfill({
      status: committedFailure ? 503 : 200,
      json: {
        deletedGroupIds: body.groupIds,
        deletedPromptIds: [...removed],
        ...(committedFailure
          ? {
              error: 'Reopen this session',
              code: 'message_deletion_context_unavailable',
              persisted: true,
            }
          : {}),
      },
    });
    if (committedFailure)
      await daemon.sendEvent({
        v: 1,
        type: 'session_messages_deleted',
        originatorClientId: route.request().headers()['x-qwen-client-id'],
        data: {
          sessionId: scenario.sessionId,
          deletedGroupIds: body.groupIds,
          deletedPromptIds: [...removed],
        },
      });
  });
  await page.goto(`/session/${scenario.sessionId}?lang=${language}`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: events.length,
    }),
  );
  const entries = page
    .locator('[data-web-shell-message-row]')
    .getByRole('button', {
      name: language === 'zh-CN' ? '更多操作' : 'More message actions',
      exact: true,
    });
  if (count > 100) await expect(entries.last()).toBeVisible();
  else await expect(entries).toHaveCount(count);
  return {
    deletions,
    daemon,
    scenario,
    groups,
    setFail: (value: boolean) => {
      fail = value;
    },
    setSnapshot: (value: string) => {
      snapshot = value;
    },
    setCommittedFailure: () => {
      committedFailure = true;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

async function startDeletion(page: Page, trigger: Locator) {
  await trigger.hover();
  await page
    .getByRole('menuitem', { name: 'Delete messages', exact: true })
    .click();
}

async function expectSelectionLayout(page: import('@playwright/test').Page) {
  const row = page
    .locator('[data-web-shell-message-row]')
    .filter({ has: page.locator('[data-web-shell-user-bubble]') })
    .first();
  await expect
    .poll(async () => {
      const rowBox = await row.boundingBox();
      const toolbar = await page
        .locator('[data-web-shell-message-deletion]')
        .boundingBox();
      if (!rowBox || !toolbar) return Infinity;
      return Math.max(
        Math.abs(rowBox.x - toolbar.x),
        Math.abs(rowBox.width - toolbar.width),
      );
    })
    .toBeLessThanOrEqual(2);
  const bubble = await row
    .locator('[data-web-shell-user-bubble]')
    .boundingBox();
  const checkbox = await row.getByRole('checkbox').boundingBox();
  expect(bubble).not.toBeNull();
  expect(checkbox).not.toBeNull();
  expect(
    Math.abs(
      checkbox!.y + checkbox!.height / 2 - bubble!.y - bubble!.height / 2,
    ),
  ).toBeLessThanOrEqual(3);
}

test('linked group selection, earlier non-contiguous deletion and reload @smoke', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  const { deletions } = await setup(page, String(info.project.use.baseURL));
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .last(),
  );
  const checks = page.getByRole('checkbox', { name: 'Select message group' });
  await expect(checks).toHaveCount(6);
  await expect(checks.nth(4)).toBeChecked();
  await expect(checks.nth(5)).toBeChecked();
  await checks.nth(5).click();
  await expect(checks.nth(4)).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Delete selected', exact: true }),
  ).toBeDisabled();
  await checks.nth(4).click();
  await checks.nth(1).click();
  await expect(checks.nth(0)).toBeChecked();
  await expect(checks.nth(2)).not.toBeChecked();
  await expectSelectionLayout(page);
  await page.screenshot({
    path: info.outputPath('selection-mock-daemon.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toContainText(
    'Existing summaries',
  );
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('Question 1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Question 3', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
  expect(deletions).toEqual([
    { snapshot: 'snapshot-1', groupIds: ['u0', 'u2'] },
  ]);
  await page.reload();
  await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Question 1', { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('deleted-mock-daemon.png'),
    fullPage: true,
  });
});

test('only group can be deleted at mobile width, leaving the session open @smoke', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await setup(page, String(info.project.use.baseURL), 1);
  await startDeletion(
    page,
    page.getByRole('button', { name: 'More message actions', exact: true }),
  );
  await expect(
    page.getByRole('checkbox', { name: 'Select message group' }),
  ).toHaveCount(2);
  await expect(page.locator('[class*="processedLabel"]')).toHaveCount(0);
  await expect(
    page
      .locator('[data-web-shell-message-row]')
      .filter({ has: page.getByText('Answer 1', { exact: true }) })
      .getByRole('checkbox'),
  ).toBeChecked();
  await expectSelectionLayout(page);
  await page.screenshot({
    path: info.outputPath('mobile-selection-mock-daemon.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('Question 1', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.locator('[data-web-shell-composer-editor]')).toBeVisible();
});

test('all groups remain selectable, cancel preserves history, conflict allows fresh selection @smoke', async ({
  page,
}, info) => {
  const { deletions, setFail, setSnapshot } = await setup(
    page,
    String(info.project.use.baseURL),
  );
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .nth(1),
  );
  await expect(
    page.getByRole('checkbox', { name: 'Select message group' }).nth(4),
  ).toBeEnabled();
  await page
    .locator('[data-web-shell-message-deletion]')
    .getByRole('button', { name: 'cancel', exact: true })
    .click();
  expect(deletions).toEqual([]);
  await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
  setFail(true);
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .nth(1),
  );
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(
    page.locator('[data-web-shell-message-deletion] [role=alert]'),
  ).toContainText('Session history changed');
  await expect(
    page.getByRole('checkbox', { name: 'Select message group' }),
  ).toHaveCount(0);
  await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
  expect(deletions).toHaveLength(1);
  setFail(false);
  setSnapshot('snapshot-2');
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .nth(1),
  );
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('Question 2', { exact: true })).toHaveCount(0);
  expect(deletions).toEqual([
    { snapshot: 'snapshot-1', groupIds: ['u1'] },
    { snapshot: 'snapshot-2', groupIds: ['u1'] },
  ]);
});

test('middle entry allows both directions and keeps the deletion menu visible but disabled @smoke', async ({
  page,
}, info) => {
  const { deletions } = await setup(page, String(info.project.use.baseURL));
  const triggers = page.getByRole('button', {
    name: 'More message actions',
    exact: true,
  });
  await startDeletion(page, triggers.nth(1));
  const checks = page.getByRole('checkbox', { name: 'Select message group' });
  await expect(checks).toHaveCount(6);
  for (let index = 0; index < 6; index++) {
    await expect(checks.nth(index)).toBeEnabled();
    if (index === 2 || index === 3)
      await expect(checks.nth(index)).toBeChecked();
    else await expect(checks.nth(index)).not.toBeChecked();
  }
  await checks.nth(5).click();
  await expect(checks.nth(4)).toBeChecked();
  await checks.nth(1).click();
  await expect(checks.nth(0)).toBeChecked();
  await checks.nth(1).click();
  await expect(checks.nth(0)).not.toBeChecked();
  await triggers.nth(1).hover();
  const entry = page.getByRole('menuitem', {
    name: 'Delete messages',
    exact: true,
  });
  await expect(entry).toBeVisible();
  await expect(entry).toBeDisabled();
  await entry.dispatchEvent('click');
  await expect(checks.nth(2)).toBeChecked();
  await expect(checks.nth(4)).toBeChecked();
  await expect(
    page.locator('[data-web-shell-message-deletion] [role=status]'),
  ).toHaveText('2 groups selected');
  expect(deletions).toEqual([]);
  await page.screenshot({
    path: info.outputPath('all-groups-disabled-menu-mock-daemon.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('[data-web-shell-composer-editor]').hover();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('Question 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Question 2', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Question 3', { exact: true })).toHaveCount(0);
  expect(deletions).toEqual([
    { snapshot: 'snapshot-1', groupIds: ['u1', 'u2'] },
  ]);
});

test('committed 503 reconciles the originator and explains reopening @smoke', async ({
  page,
}, info) => {
  const { setCommittedFailure } = await setup(
    page,
    String(info.project.use.baseURL),
  );
  setCommittedFailure();
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .last(),
  );
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('Question 3', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(
    page.locator('[data-web-shell-message-deletion] [role=alert]'),
  ).toContainText('Reopen this session');
});

test('server busy preserves selection for an explicit retry @smoke', async ({
  page,
}, info) => {
  const { setBusy, deletions } = await setup(
    page,
    String(info.project.use.baseURL),
  );
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .last(),
  );
  setBusy(true);
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(
    page.locator('[data-web-shell-message-deletion] [role=alert]'),
  ).toContainText('processing a turn');
  await expect(
    page.getByRole('checkbox', { name: 'Select message group' }).last(),
  ).toBeChecked();
  expect(deletions).toHaveLength(1);
  setBusy(false);
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('Question 3', { exact: true })).toHaveCount(0);
});

test('frontend command echo and result delete together without a history mutation @smoke', async ({
  page,
}, info) => {
  const { deletions } = await setup(page, String(info.project.use.baseURL));
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('/tools');
  await editor.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const command = page
    .locator('[data-web-shell-message-row]')
    .filter({ has: page.getByText('/tools', { exact: true }) });
  await startDeletion(
    page,
    command.getByRole('button', { name: 'More message actions', exact: true }),
  );
  const checks = page.getByRole('checkbox', { name: 'Select message group' });
  await expect(checks).toHaveCount(8);
  await expect(checks.nth(6)).toBeChecked();
  await expect(checks.nth(7)).toBeChecked();
  await checks.nth(7).click();
  await expect(checks.nth(6)).not.toBeChecked();
  await checks.nth(6).click();
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('/tools', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Question 3', { exact: true })).toBeVisible();
  expect(deletions).toEqual([]);
});

test('peer invalidation clears an empty transcript and preserves local command records @smoke', async ({
  page,
}, info) => {
  const { daemon, scenario } = await setup(
    page,
    String(info.project.use.baseURL),
  );
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('/tools');
  await editor.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('/tools', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'More message actions', exact: true }),
  ).toHaveCount(5);
  scenario.events = [];
  await daemon.sendEvent({
    v: 1,
    type: 'session_messages_deleted',
    data: {
      sessionId: scenario.sessionId,
      deletedGroupIds: ['u0', 'u1', 'u2'],
      deletedPromptIds: ['p0', 'p1', 'p2'],
    },
  });
  await expect(page.getByText('Question 1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('/tools', { exact: true })).toBeVisible();
});

test('an executing frontend command disables deletion until its result arrives @smoke', async ({
  page,
}, info) => {
  await setup(page, String(info.project.use.baseURL));
  let release!: () => void;
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/session/*/stats', async (route) => {
    await response;
    await route.fallback();
  });
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('/stats');
  await editor.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  try {
    await expect(page.getByText('/stats', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'More message actions', exact: true })
      .first()
      .hover();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'Delete messages', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    release();
  }
  await expect(
    page.getByRole('button', { name: 'More message actions', exact: true }),
  ).toHaveCount(5);
});

test('newly admitted optimistic user prompt can be deleted without refreshing @smoke', async ({
  page,
}, info) => {
  const { daemon, scenario } = await setup(
    page,
    String(info.project.use.baseURL),
    0,
  );
  await page.route('**/session/*/message-groups', (route) =>
    route.fulfill({
      json: {
        snapshot: 'live-snapshot',
        groups: [
          {
            id: 'live-user',
            promptId: 'prompt-e2e',
            recordIds: ['live-user', 'live-answer'],
          },
        ],
      },
    }),
  );
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('Fresh live question');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await daemon.sendEvent(
    stamp(
      assistantTextEvent('Fresh live answer', { id: 1 }),
      'prompt-e2e',
      'live-answer',
    ),
  );
  await daemon.sendEvent(
    turnCompleteEvent('prompt-e2e', { id: 2, sessionId: scenario.sessionId }),
  );
  await expect(
    page.getByRole('button', { name: 'More message actions', exact: true }),
  ).toHaveCount(1);
  await startDeletion(
    page,
    page.getByRole('button', { name: 'More message actions', exact: true }),
  );
  const checks = page.getByRole('checkbox', { name: 'Select message group' });
  await expect(checks).toHaveCount(2);
  await expect(checks.nth(0)).toBeChecked();
  await expect(checks.nth(1)).toBeChecked();
});

for (const count of [1, 105]) {
  test(`reply checkbox stays on Processed through expansion (${count === 1 ? 'ordinary' : 'virtual'} list) @smoke`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await setup(page, String(info.project.use.baseURL), count, true);
    const userRow = page.locator('[data-web-shell-message-row]').filter({
      has: page.getByText(`Question ${count}`, { exact: true }),
    });
    const answerRow = page.locator('[data-web-shell-message-row]').filter({
      has: page.getByText(`Answer ${count}`, { exact: true }),
    });
    await startDeletion(
      page,
      userRow.getByRole('button', {
        name: 'More message actions',
        exact: true,
      }),
    );
    const header = page.getByRole('button', {
      name: /^(Expand|Collapse) steps$/,
      exact: true,
    });
    const headerRow = page
      .locator('[data-web-shell-message-row]')
      .filter({ has: header });
    const replyCheck = headerRow.getByRole('checkbox');
    const selected = page.getByRole('checkbox', {
      name: 'Select message group',
      checked: true,
    });
    for (const expanded of [false, true, false]) {
      await expect(header).toHaveAttribute('aria-expanded', String(expanded));
      await expect(replyCheck).toBeChecked();
      await expect(selected).toHaveCount(2);
      await expect(answerRow.getByRole('checkbox')).toHaveCount(0);
      // Read both positions in one frame while the virtual list may scroll.
      const { horizontalGap, verticalOffset } = await headerRow.evaluate(
        (row) => {
          const label = row
            .querySelector('[class*="processedLabel"]')!
            .getBoundingClientRect();
          const checkbox = row
            .querySelector('[role="checkbox"]')!
            .getBoundingClientRect();
          return {
            horizontalGap: label.left - checkbox.right,
            verticalOffset: Math.abs(
              (checkbox.top + checkbox.bottom - label.top - label.bottom) / 2,
            ),
          };
        },
      );
      expect(horizontalGap).toBeGreaterThan(0);
      expect(verticalOffset).toBeLessThanOrEqual(3);
      await replyCheck.click();
      await expect(userRow.getByRole('checkbox')).not.toBeChecked();
      await expect(header).toHaveAttribute('aria-expanded', String(expanded));
      await replyCheck.click();
      await expect(userRow.getByRole('checkbox')).toBeChecked();
      await expect(header).toHaveAttribute('aria-expanded', String(expanded));
      await header.click();
    }
  });
}

test('message actions use a hoverable menu that also supports click and keyboard @smoke', async ({
  page,
}, info) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await setup(page, String(info.project.use.baseURL), 1);
  const row = page.locator('[data-web-shell-message-row]').filter({
    has: page.getByText('Question 1', { exact: true }),
  });
  await row.hover();
  await expect(row.getByRole('button')).toHaveCount(2);
  await expect(
    row.getByRole('button', { name: 'Copy', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        document.documentElement.dataset['copiedMessage'] = text;
      },
    });
  });
  await row.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-copied-message',
    'Question 1',
  );
  const composer = page.locator('[data-web-shell-composer-editor] .cm-content');
  await composer.fill('Unsent draft');
  const trigger = row.getByRole('button', {
    name: 'More message actions',
    exact: true,
  });
  const menu = page.getByRole('menu');
  await expect(menu).toHaveCount(0);
  await trigger.hover();
  await expect(menu).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(menu.getByRole('menuitem')).toHaveText([
    'View tool calls',
    'Edit message',
    'Delete messages',
  ]);
  await menu.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  const gapY =
    menuBox!.y >= triggerBox!.y + triggerBox!.height
      ? (triggerBox!.y + triggerBox!.height + menuBox!.y) / 2
      : (menuBox!.y + menuBox!.height + triggerBox!.y) / 2;
  await page.mouse.move(triggerBox!.x + triggerBox!.width / 2, gapY);
  await page.clock.runFor(60);
  await expect(menu).toBeVisible();
  const hoveredItem = menu.getByRole('menuitem', {
    name: 'Edit message',
    exact: true,
  });
  // Cross into the menu with raw pointer moves. `hoveredItem.hover()` spends
  // its actionability budget (visible, stable for two frames, receives
  // events) while the pointer is still parked in the gap, so on a busy pool
  // host the menu's 120 ms close delay expires before the pointer arrives.
  const hoveredItemBox = (await hoveredItem.boundingBox())!;
  await page.mouse.move(
    hoveredItemBox.x + hoveredItemBox.width / 2,
    hoveredItemBox.y + hoveredItemBox.height / 2,
    { steps: 5 },
  );
  await page.clock.runFor(180);
  await expect(menu).toBeVisible();
  await expect(hoveredItem).toBeFocused();
  await expect(hoveredItem).toHaveAttribute('data-highlighted', '');
  await page.screenshot({
    path: info.outputPath('actions-hover-mock-daemon.png'),
    fullPage: true,
  });
  await page.locator('[data-web-shell-composer-editor]').hover();
  await page.clock.runFor(121);
  await expect(menu).toHaveCount(0);
  await page.clock.resume();
  await composer.focus();
  await trigger.hover();
  await expect(menu).toHaveAttribute('data-state', 'open');
  await expect(composer).toBeFocused();
  await page.locator('[data-web-shell-composer-editor]').hover();
  await expect(menu).toHaveCount(0);
  await expect(composer).toBeFocused();
  await trigger.click();
  await expect(menu).toHaveAttribute('data-state', 'open');
  await page.waitForTimeout(250);
  await expect(menu).toHaveAttribute('data-state', 'open');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await trigger.focus();
  await trigger.press('Enter');
  await expect(menu).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'View tool calls', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('menuitem', { name: 'Edit message', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    row.getByRole('textbox', { name: 'Edit message' }),
  ).toBeVisible();
  await expect(
    row.getByRole('textbox', { name: 'Edit message' }),
  ).toBeFocused();
});

test('touch users can tap the message action menu and delete entry @smoke', async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 850 },
    hasTouch: true,
    isMobile: true,
    baseURL: String(info.project.use.baseURL),
  });
  const page = await context.newPage();
  try {
    await setup(page, String(info.project.use.baseURL), 1);
    await page
      .getByRole('button', { name: 'More message actions', exact: true })
      .tap();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.screenshot({
      path: info.outputPath('actions-touch-mock-daemon.png'),
      fullPage: true,
    });
    await page
      .getByRole('menuitem', { name: 'Delete messages', exact: true })
      .tap();
    await expect(
      page.getByRole('checkbox', { name: 'Select message group' }),
    ).toHaveCount(2);
  } finally {
    await context.close();
  }
});

test('a Chinese snapshot conflict clears selection with a localized explanation @smoke', async ({
  page,
}, info) => {
  const { setFail, deletions } = await setup(
    page,
    String(info.project.use.baseURL),
    1,
    false,
    'zh-CN',
  );
  setFail(true);
  await page
    .locator('[data-web-shell-message-row]')
    .getByRole('button', { name: '更多操作', exact: true })
    .hover();
  await page.getByRole('menuitem', { name: '删除消息', exact: true }).click();
  await page.getByRole('button', { name: '删除所选', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(
    page.locator('[data-web-shell-message-deletion] [role=alert]'),
  ).toHaveText('会话历史已变化，请重新选择要删除的消息。');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  expect(deletions).toHaveLength(1);
});

test('unselected local commands retain position and identity across deletion reload @smoke', async ({
  page,
}, info) => {
  const { daemon, scenario, groups } = await setup(
    page,
    String(info.project.use.baseURL),
    1,
  );
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('/tools');
  await editor.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const command = page
    .locator('[data-web-shell-message-row]')
    .filter({ has: page.getByText('/tools', { exact: true }) });
  await expect(command).toBeVisible();
  const key = await command
    .locator('xpath=ancestor-or-self::*[@data-message-row-key][1]')
    .getAttribute('data-message-row-key');
  for (const index of [1, 2]) {
    groups.push({
      id: `u${index}`,
      promptId: `p${index}`,
      recordIds: [`u${index}`, `a${index}`],
    });
    const events = [
      stamp(
        userTextEvent(`Question ${index + 1}`, { id: index * 5 + 1 }),
        `p${index}`,
        `u${index}`,
      ),
      stamp(
        assistantTextEvent(`Answer ${index + 1}`, { id: index * 5 + 4 }),
        `p${index}`,
        `a${index}`,
      ),
      turnCompleteEvent(`p${index}`, { id: index * 5 + 5 }),
    ];
    scenario.events.push(...events);
    for (const event of events) await daemon.sendEvent(event);
  }
  await expect(page.getByText('Answer 3', { exact: true })).toBeVisible();
  const third = page
    .locator('[data-web-shell-message-row]')
    .filter({ has: page.getByText('Question 3', { exact: true }) });
  await startDeletion(
    page,
    third.getByRole('button', { name: 'More message actions', exact: true }),
  );
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(page.getByText('Question 3', { exact: true })).toHaveCount(0);
  await expect(command).toBeVisible();
  const rows = await page
    .locator('[data-web-shell-message-row]')
    .allTextContents();
  expect(rows.findIndex((text) => text.includes('/tools'))).toBeLessThan(
    rows.findIndex((text) => text.includes('Question 2')),
  );
  expect(
    await command
      .locator('xpath=ancestor-or-self::*[@data-message-row-key][1]')
      .getAttribute('data-message-row-key'),
  ).toBe(key);
});

test('unselected local echo and result survive failed reload and later peer recovery @smoke', async ({
  page,
}, info) => {
  const { daemon, scenario } = await setup(
    page,
    String(info.project.use.baseURL),
    2,
  );
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('/tools');
  await editor.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'More message actions', exact: true }),
  ).toHaveCount(4);
  const result = (
    await page.locator('[data-web-shell-message-row]').allTextContents()
  ).at(-1)!;
  let failReload = false;
  await page.route(
    /\/session\/[^/]+\/(load|resume|transcript)(?:\?|$)/,
    async (route) => {
      if (failReload)
        await route.fulfill({
          status: 503,
          json: { error: 'Reload unavailable' },
        });
      else await route.fallback();
    },
  );
  await page.route('**/session/*/messages/delete', async (route) => {
    failReload = true;
    await route.fallback();
  });
  await startDeletion(
    page,
    page
      .getByRole('button', { name: 'More message actions', exact: true })
      .first(),
  );
  await page
    .getByRole('button', { name: 'Delete selected', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete permanently', exact: true })
    .click();
  await expect(
    page.locator('[data-web-shell-message-deletion] [role=alert]'),
  ).toBeVisible();
  await expect(page.getByText('Question 1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
  await expect(
    page.locator('[data-web-shell-message-deletion] [role=alert]'),
  ).toContainText('Messages were deleted');
  await page.screenshot({
    path: info.outputPath('deleted-reload-failed-mock-daemon.png'),
    fullPage: true,
  });
  await expect(page.getByText('/tools', { exact: true })).toBeVisible();
  expect(
    await page.locator('[data-web-shell-message-row]').allTextContents(),
  ).toContain(result);
  failReload = false;
  await daemon.sendEvent({
    v: 1,
    type: 'session_messages_deleted',
    originatorClientId: 'peer',
    data: {
      sessionId: scenario.sessionId,
      deletedGroupIds: ['u0'],
      deletedPromptIds: ['p0'],
    },
  });
  await expect(page.getByText('Question 1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('/tools', { exact: true })).toBeVisible();
  expect(
    await page.locator('[data-web-shell-message-row]').allTextContents(),
  ).toContain(result);
});

test('peer deletion preserves surviving rows if history reload is unavailable @smoke', async ({
  page,
}, info) => {
  const { daemon, scenario } = await setup(
    page,
    String(info.project.use.baseURL),
    2,
  );
  await page.route(
    /\/session\/[^/]+\/(load|resume|transcript)(?:\?|$)/,
    (route) =>
      route.fulfill({ status: 503, json: { error: 'Reload unavailable' } }),
  );
  await daemon.sendEvent({
    v: 1,
    type: 'session_messages_deleted',
    originatorClientId: 'peer',
    data: {
      sessionId: scenario.sessionId,
      deletedGroupIds: ['u0'],
      deletedPromptIds: ['p0'],
    },
  });
  await expect(page.getByText('Question 1', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      daemon.requests.some((request) => /\/(load|resume)$/.test(request.path)),
    )
    .toBe(true);
  await expect(page.getByText('Question 2', { exact: true })).toBeVisible();
});
