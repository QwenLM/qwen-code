import { expect, test, type Page } from '@playwright/test';
import type { DaemonPermissionRequestEvent } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  turnCompleteEvent,
} from './utils/mockDaemon';

interface CapturedNotification {
  title: string;
  options: NotificationOptions;
  onclick?: () => void;
  close(): void;
}

declare global {
  interface Window {
    __taskNotifications: CapturedNotification[];
    __taskNotificationFocused: boolean;
    __taskNotificationPermissionRequests: number;
    __taskNextNotificationPermission: NotificationPermission;
  }
}

interface NotificationCaptureOptions {
  enabled?: boolean;
  permission?: NotificationPermission | 'unavailable';
  savedPreference?: boolean;
}

async function captureNotifications(
  page: Page,
  options: boolean | NotificationCaptureOptions = true,
) {
  const {
    enabled = true,
    permission = 'granted',
    savedPreference = true,
  } = typeof options === 'boolean' ? { enabled: options } : options;
  await page.addInitScript(
    ({ enabled, permission, savedPreference }) => {
      if (!sessionStorage.getItem('notification-test-initialized')) {
        const preferenceKey = 'qwen-code-web-shell-browser-notifications';
        if (savedPreference)
          localStorage.setItem(preferenceKey, String(enabled));
        else localStorage.removeItem(preferenceKey);
        sessionStorage.setItem('notification-test-initialized', 'true');
      }
      window.__taskNotifications = [];
      window.__taskNotificationFocused = false;
      window.__taskNotificationPermissionRequests = Number(
        sessionStorage.getItem('notification-test-permission-requests') ?? 0,
      );
      window.__taskNextNotificationPermission = 'default';
      Object.defineProperty(document, 'hasFocus', {
        value: () => window.__taskNotificationFocused,
      });
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
      });
      Object.defineProperty(window, 'Notification', {
        value:
          permission === 'unavailable'
            ? undefined
            : class {
                static permission =
                  sessionStorage.getItem('notification-test-permission') ??
                  permission;
                static async requestPermission() {
                  window.__taskNotificationPermissionRequests++;
                  sessionStorage.setItem(
                    'notification-test-permission-requests',
                    String(window.__taskNotificationPermissionRequests),
                  );
                  this.permission = window.__taskNextNotificationPermission;
                  sessionStorage.setItem(
                    'notification-test-permission',
                    this.permission,
                  );
                  return this.permission;
                }
                onclick?: () => void;
                constructor(
                  public title: string,
                  public options: NotificationOptions,
                ) {
                  window.__taskNotifications.push(this);
                }
                close() {}
              },
      });
    },
    { enabled, permission, savedPreference },
  );
}

function actionRequest(
  sessionId: string,
  kind: 'approval' | 'question',
  id = 1,
): DaemonPermissionRequestEvent {
  const requestId = `action-${id}`;
  return {
    id,
    v: 1,
    type: 'permission_request',
    data: {
      requestId,
      sessionId,
      toolCall:
        kind === 'question'
          ? {
              toolCallId: requestId,
              title: 'Ask user 1 question',
              kind: 'think',
              _meta: { toolName: 'ask_user_question' },
              rawInput: {
                questions: [
                  {
                    header: 'Destination',
                    question: 'Which private deployment target?',
                    options: [{ label: 'Staging' }, { label: 'Production' }],
                  },
                ],
              },
            }
          : {
              name: 'Bash',
              input: { command: 'printf web-shell-e2e' },
            },
      options: [
        { optionId: 'allow_once', label: 'Allow once' },
        { optionId: 'reject_once', label: 'Reject' },
      ],
    },
  };
}

for (const kind of ['approval', 'question'] as const) {
  test(`notifies for a live ${kind} without approving it or consuming completion`, async ({
    page,
  }, testInfo) => {
    await captureNotifications(page);
    const scenario = createWebShellDaemonScenario({ events: [] });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    await page.goto(`/session/${scenario.sessionId}?language=en`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await expect(page.getByRole('banner')).toContainText(scenario.displayName);
    const event = actionRequest(scenario.sessionId, kind);
    await daemon.sendEvent(event);
    if (kind === 'question') {
      await expect(
        page.getByText('Which private deployment target?', { exact: true }),
      ).toBeVisible();
    } else {
      await expect(page.getByText('Allow once', { exact: true })).toBeVisible();
    }
    await expect
      .poll(() => page.evaluate(() => window.__taskNotifications.length))
      .toBe(1);
    const notification = await page.evaluate(() => {
      const { title, options } = window.__taskNotifications[0];
      return { title, options };
    });
    await page.screenshot({
      path: `../../.qwen/e2e-tests/browser-action-notifications/${kind}.png`,
      fullPage: true,
    });
    expect(notification.title).toBe(`QwenCode · ${scenario.displayName}`);
    expect(notification.options.body).toBe(
      kind === 'approval'
        ? 'This session needs your approval. Return to review the request.'
        : 'This session is waiting for your answer. Return to respond.',
    );
    expect(JSON.stringify(notification)).not.toMatch(
      /printf|private deployment|Staging/,
    );
    await daemon.sendEvent({ ...event, id: 2 });
    await page.evaluate(() => window.__taskNotifications[0].onclick?.());
    expect(daemon.permissionRequests()).toHaveLength(0);
    await daemon.sendEvent(
      turnCompleteEvent('finished-action-turn', {
        sessionId: scenario.sessionId,
        id: 3,
      }),
    );
    await expect
      .poll(() => page.evaluate(() => window.__taskNotifications.length))
      .toBe(2);
    expect(
      await page.evaluate(() => window.__taskNotifications[1].options.body),
    ).toBe('This turn has completed.');
  });
}

test('keeps history and foreground requests silent and allows a later background request', async ({
  page,
}, testInfo) => {
  await captureNotifications(page);
  const scenario = createWebShellDaemonScenario({ events: [] });
  scenario.events = [actionRequest(scenario.sessionId, 'approval')];
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect(page.getByRole('banner')).toContainText(scenario.displayName);
  await expect(
    page.getByRole('radio', { name: 'Allow once', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__taskNotifications.length)).toBe(0);
  await daemon.sendEvent({
    id: 2,
    v: 1,
    type: 'permission_resolved',
    data: {
      requestId: 'action-1',
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    },
  });
  await expect(page.getByRole('alertdialog')).not.toBeVisible();
  await page.evaluate(() => {
    window.__taskNotificationFocused = true;
  });
  await daemon.sendEvent(actionRequest(scenario.sessionId, 'question', 3));
  await expect(
    page.getByText('Which private deployment target?', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__taskNotifications.length)).toBe(0);
  await page.evaluate(() => {
    window.__taskNotificationFocused = false;
  });
  await daemon.sendEvent(actionRequest(scenario.sessionId, 'approval', 4));
  await expect
    .poll(() => page.evaluate(() => window.__taskNotifications.length))
    .toBe(1);
  expect(
    await page.evaluate(() => window.__taskNotifications[0].options.body),
  ).toContain('needs your approval');
});

test('does not notify when the existing browser notification setting is off', async ({
  page,
}, testInfo) => {
  await captureNotifications(page, false);
  const scenario = createWebShellDaemonScenario({ events: [] });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect(page.getByRole('banner')).toContainText(scenario.displayName);
  await daemon.sendEvent(actionRequest(scenario.sessionId, 'question'));
  await expect(
    page.getByText('Which private deployment target?', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__taskNotifications.length)).toBe(0);
});

async function waitForAnimations(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

async function openActionPanel(
  page: Page,
  baseURL: string,
  kind: 'approval' | 'question',
  language = 'en',
) {
  const scenario = createWebShellDaemonScenario({ events: [] });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${scenario.sessionId}?language=${language}`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect(page.getByRole('banner')).toContainText(scenario.displayName);
  await daemon.sendEvent(actionRequest(scenario.sessionId, kind));
  await expect(
    kind === 'question'
      ? page.getByText('Which private deployment target?', { exact: true })
      : page.getByText('Allow once', { exact: true }),
  ).toBeVisible();
  await waitForAnimations(page);
  return { scenario, daemon };
}

for (const kind of ['approval', 'question'] as const) {
  test(`exposes interactive browser notification help in the ${kind} header`, async ({
    page,
  }, testInfo) => {
    await captureNotifications(page);
    const { daemon } = await openActionPanel(
      page,
      String(testInfo.project.use.baseURL),
      kind,
    );
    const button = page.getByRole('button', {
      name: 'Task notifications',
      exact: true,
    });
    const help = page.locator('[data-web-shell-notification-help]');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.hover();
    await expect(help).toBeVisible();
    await help.hover();
    await expect(help).toBeVisible();
    await expect(help).toContainText('Enabled for this site.');
    await expect(help.locator('[data-slot="popover-title"]')).toHaveCSS(
      'font-size',
      '16px',
    );
    const enabledStatus = help.getByRole('button', {
      name: 'Enabled for this site.',
      exact: true,
    });
    await expect(enabledStatus).toBeDisabled();
    const successIcon = enabledStatus.locator('svg');
    await expect(successIcon).toBeVisible();
    const iconColors = await successIcon.evaluate((icon) => {
      const reference = document.createElement('span');
      reference.style.color = 'var(--success-color)';
      icon.parentElement!.append(reference);
      const expected = getComputedStyle(reference).color;
      reference.remove();
      return { actual: getComputedStyle(icon).color, expected };
    });
    expect(iconColors.actual).toBe(iconColors.expected);
    await expect(help).toContainText(/background|unfocused/);
    await expect(help).toContainText(
      'If no reminders appear, follow the steps below to check system notifications.',
    );
    await waitForAnimations(page);
    await expect
      .poll(() =>
        help.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
        }),
      )
      .toBe(true);
    await expect(help).toContainText(/macOS/);
    await expect(help).toContainText(/Windows/);
    for (const system of ['macOS', 'Windows']) {
      const guide = help.locator('details').filter({ hasText: system });
      const summary = guide.locator('summary');
      await expect(guide).not.toHaveAttribute('open');
      await expect(guide.locator('p')).not.toBeVisible();
      await expect(summary.locator('svg')).toBeVisible();
      await summary.click();
      await expect(guide).toHaveAttribute('open', '');
      await expect(guide.locator('p')).toBeVisible();
      await summary.press('Enter');
      await expect(guide).not.toHaveAttribute('open');
      await expect(guide.locator('p')).not.toBeVisible();
      expect(daemon.permissionRequests()).toHaveLength(0);
    }
    await page.screenshot({
      path: `../../.qwen/e2e-tests/browser-notification-access/${kind}-popover-final-v3.png`,
      fullPage: true,
    });
    await help.focus();
    for (const key of ['1', 'Control+Enter', 'Escape']) {
      await help.press(key);
      expect(daemon.permissionRequests()).toHaveLength(0);
      await button.focus();
      await expect(help).toBeVisible();
      await help.focus();
    }
    await button.click();
    await expect(help).toBeVisible();
    expect(daemon.permissionRequests()).toHaveLength(0);
    await expect(
      kind === 'question'
        ? page.getByText('Which private deployment target?', { exact: true })
        : page.getByText('Allow once', { exact: true }),
    ).toBeVisible();
  });
}

test('attempts permission once across panels and reload, then allows a manual grant', async ({
  page,
}, testInfo) => {
  await captureNotifications(page, {
    permission: 'default',
    savedPreference: false,
  });
  const { daemon, scenario } = await openActionPanel(
    page,
    String(testInfo.project.use.baseURL),
    'approval',
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.__taskNotificationPermissionRequests),
    )
    .toBe(1);
  await daemon.sendEvent({
    id: 2,
    v: 1,
    type: 'permission_resolved',
    data: {
      requestId: 'action-1',
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    },
  });
  const question = actionRequest(scenario.sessionId, 'question', 3);
  await daemon.sendEvent(question);
  await expect(
    page.getByText('Which private deployment target?', { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.__taskNotificationPermissionRequests),
  ).toBe(1);
  scenario.events = [question];
  await page.reload();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect(
    page.getByText('Which private deployment target?', { exact: true }),
  ).toBeVisible();
  const button = page.getByRole('button', {
    name: 'Task notifications',
    exact: true,
  });
  await button.focus();
  const help = page.locator('[data-web-shell-notification-help]');
  await expect(help).toContainText('Notifications are not authorized yet.');
  expect(
    await page.evaluate(() => window.__taskNotificationPermissionRequests),
  ).toBe(1);
  await page.evaluate(() => {
    window.__taskNextNotificationPermission = 'granted';
  });
  await help
    .getByRole('button', { name: 'Allow notifications', exact: true })
    .click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(help).toContainText('Enabled for this site.');
  expect(
    await page.evaluate(() => window.__taskNotificationPermissionRequests),
  ).toBe(2);
  expect(daemon.permissionRequests()).toHaveLength(0);
});

for (const permission of ['default', 'denied', 'unavailable'] as const) {
  test(`explains ${permission} notifications without an automatic prompt`, async ({
    page,
  }, testInfo) => {
    await captureNotifications(page, {
      enabled: false,
      permission,
      savedPreference: permission === 'default',
    });
    await openActionPanel(
      page,
      String(testInfo.project.use.baseURL),
      'approval',
    );
    const button = page.getByRole('button', {
      name: 'Task notifications',
      exact: true,
    });
    await button.click();
    const help = page.locator('[data-web-shell-notification-help]');
    await expect(help).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(help).toContainText(/site|browser|Browser/);
    expect(
      await page.evaluate(() => window.__taskNotificationPermissionRequests),
    ).toBe(0);
    if (permission === 'default') {
      await expect(
        help.getByRole('button', { name: 'Allow notifications', exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        help.getByRole('button', { name: 'Allow notifications', exact: true }),
      ).toBeDisabled();
      await expect(help.getByRole('status')).toHaveText(
        permission === 'denied'
          ? 'Notifications are blocked. Allow them in your browser site settings.'
          : 'Notifications are unavailable in this browser or page context.',
      );
    }
  });
}

test('shows localized notification help in the question header', async ({
  page,
}, testInfo) => {
  await captureNotifications(page);
  await openActionPanel(
    page,
    String(testInfo.project.use.baseURL),
    'question',
    'zh-CN',
  );
  await page.getByRole('button', { name: '任务通知', exact: true }).hover();
  const help = page.locator('[data-web-shell-notification-help]');
  await expect(help).toBeVisible();
  await expect(help).toContainText(/已|通知/);
  await waitForAnimations(page);
  await expect
    .poll(() =>
      help.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: '../../.qwen/e2e-tests/browser-notification-access/question-popover-zh-CN-final-v3.png',
    fullPage: true,
  });
});

test('enables an explicitly off preference with existing browser permission', async ({
  page,
}, testInfo) => {
  await captureNotifications(page, false);
  await openActionPanel(page, String(testInfo.project.use.baseURL), 'question');
  const button = page.getByRole('button', {
    name: 'Task notifications',
    exact: true,
  });
  await button.click();
  const help = page.locator('[data-web-shell-notification-help]');
  await expect(help.getByRole('status')).toHaveText('Disabled.');
  await help
    .getByRole('button', { name: 'Enable notifications', exact: true })
    .click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(help.getByRole('status')).toHaveText('Enabled for this site.');
  expect(
    await page.evaluate(() => window.__taskNotificationPermissionRequests),
  ).toBe(0);
});

for (const kind of ['approval', 'question'] as const) {
  test(`keeps notification help open while dragging to select text in the ${kind} panel`, async ({
    page,
  }, testInfo) => {
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    await captureNotifications(page);
    const { daemon } = await openActionPanel(
      page,
      String(testInfo.project.use.baseURL),
      kind,
    );
    await page
      .getByRole('button', { name: 'Task notifications', exact: true })
      .hover();
    const help = page.locator('[data-web-shell-notification-help]');
    await expect(help).toBeVisible();
    await waitForAnimations(page);
    const text = help.getByText(/^While this page is in the background/);
    const bounds = await text.boundingBox();
    expect(bounds).not.toBeNull();
    const start = { x: bounds!.x + 5, y: bounds!.y + 8 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 180, start.y + 20, { steps: 8 });
    await page.mouse.up();
    await expect(help).toBeVisible();
    const selectedText = await page.evaluate(
      () => window.getSelection()?.toString() ?? '',
    );
    expect(selectedText.length).toBeGreaterThan(0);
    await page.keyboard.press('ControlOrMeta+C');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(selectedText);
    expect(daemon.permissionRequests()).toHaveLength(0);
  });
}
