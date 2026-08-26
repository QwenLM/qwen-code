import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  permissionRequestEvent,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';
import {
  emptyMobileComposerLayout,
  emptyMobileComposerSelectors,
  expectEmptyMobileComposerAnchored,
  expectEmptyMobileWelcomeChromeVisible,
  gotoEmptyMobileWelcomeHarness,
} from './utils/emptyMobileComposer';

const COMPOSER_VIEWPORT_HEIGHTS = [1000, 800, 600] as const;

const qwen38ReasoningConfigOptions = (currentValue = 'xhigh') => [
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    type: 'select',
    currentValue,
    options: [
      { value: 'none', name: 'Thinking off' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'xhigh', name: 'Extra high' },
    ],
    _meta: {
      'qwenCode/reasoning': { defaultEffort: 'xhigh' },
    },
  },
];

test('loads replayed transcript and connects to fake daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Hello from replay', { id: 1 }),
      assistantTextEvent('Hello from fake daemon', { id: 2 }),
      turnCompleteEvent('prompt-replay', { id: 3 }),
    ],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Hello from replay',
  );
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Hello from fake daemon',
  );

  // #8214: pin the explicit ::selection rule on message content. This
  // asserts the rule is present and matches every [data-user-selectable]
  // wrapper row (user and assistant alike), not just the first one; it
  // does not verify the Firefox paint effect itself (this repo's Playwright
  // projects are chromium-only).
  const selectionBackgrounds = await page.evaluate(() => {
    // Match the wrapper rows themselves, not their descendants - a single
    // row renders many descendant elements, so counting descendants does
    // not enforce the "both roles present" invariant.
    const rows = document.querySelectorAll('[data-user-selectable]');
    return Array.from(rows, (row) => {
      // ::selection applies to the element's text content; sample the first
      // text-bearing descendant (or the row itself if it has none).
      const target = row.querySelector('*') ?? row;
      return getComputedStyle(target, '::selection').backgroundColor;
    });
  });
  // The fixture renders both a user and an assistant message, so there must
  // be at least two selectable rows and every one must carry the rule.
  expect(selectionBackgrounds.length).toBeGreaterThanOrEqual(2);
  for (const bg of selectionBackgrounds) {
    expect(bg).toBe('rgba(0, 128, 255, 0.3)');
  }
});

test('branches from an earlier completed Assistant response and resumes the fork @smoke', async ({
  page,
}, testInfo) => {
  const branchRecordId = '11111111-1111-4111-8111-111111111111';
  const branchSessionId = 'web-shell-e2e-branch';
  const firstTurn = [
    userTextEvent('First question', { id: 1 }),
    assistantTextEvent('First completed answer', {
      id: 2,
      branchRecordId,
    }),
    turnCompleteEvent('prompt-1', { id: 3 }),
  ];
  const scenario = createWebShellDaemonScenario({
    events: [
      ...firstTurn,
      userTextEvent('Second question', { id: 4 }),
      assistantTextEvent('Second completed answer', {
        id: 5,
        branchRecordId: '22222222-2222-4222-8222-222222222222',
      }),
      turnCompleteEvent('prompt-2', { id: 6 }),
      userTextEvent('Third question', { id: 7 }),
      assistantTextEvent('Third completed answer', {
        id: 8,
        branchRecordId: '33333333-3333-4333-8333-333333333333',
      }),
      turnCompleteEvent('prompt-3', { id: 9 }),
    ],
    branch: {
      sessionId: branchSessionId,
      clientId: 'web-shell-e2e-branch-client',
      displayName: 'First answer branch',
      events: firstTurn,
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const firstAnswerRow = page
    .locator('[data-web-shell-message-row]')
    .filter({ hasText: 'First completed answer' });
  await firstAnswerRow.hover();
  await firstAnswerRow
    .getByRole('button', { name: 'Branch', exact: true })
    .click();

  await expect.poll(() => daemon.branchRequests().length).toBe(1);
  const branchRequest = firstRequest(daemon.branchRequests());
  expect(branchRequest.path).toBe(
    `/session/${encodeURIComponent(scenario.sessionId)}/branch`,
  );
  expect(requestBodyRecord(branchRequest)).toEqual({
    atRecordId: branchRecordId,
  });
  await expect(page).toHaveURL(
    new RegExp(`/session/${encodeURIComponent(branchSessionId)}$`),
  );
  await completeReplay(
    page,
    daemon,
    branchSessionId,
    scenario.branch?.events.length,
  );
  const messages = page.locator('[data-web-shell-message-list]');
  await expect(messages).toContainText('First completed answer');
  await expect(messages).not.toContainText('Second completed answer');
  await expect(messages).not.toContainText('Third completed answer');
  expect(scenario.events).toHaveLength(9);

  await fillComposer(page, 'Continue from the fork');
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect
    .poll(
      () =>
        daemon
          .promptRequests()
          .filter(
            (request) => request.path === `/session/${branchSessionId}/prompt`,
          ).length,
    )
    .toBe(1);

  await page.reload();
  await completeReplay(
    page,
    daemon,
    branchSessionId,
    scenario.branch?.events.length,
  );
  const restoredFirstAnswer = page
    .locator('[data-web-shell-message-row]')
    .filter({ hasText: 'First completed answer' });
  await restoredFirstAnswer.hover();
  await expect(
    restoredFirstAnswer.getByRole('button', { name: 'Branch', exact: true }),
  ).toBeVisible();
});

test('submits a prompt and renders a streamed assistant response @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await fillComposer(page, 'Ping from browser smoke');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const promptRequest = firstRequest(daemon.promptRequests());
  expect(promptRequest.method).toBe('POST');
  expect(promptRequest.path).toBe(`/session/${scenario.sessionId}/prompt`);
  expectPromptBodyToContainText(
    requestBodyRecord(promptRequest),
    'Ping from browser smoke',
  );

  await daemon.sse.split(assistantTextEvent('Pong from fake SSE', { id: 10 }));
  await daemon.sendEvent(turnCompleteEvent('prompt-e2e', { id: 11 }));

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Pong from fake SSE',
  );
});

test('configures qwen3.8-max reasoning from the model popover @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    state: {
      configOptions: qwen38ReasoningConfigOptions(),
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  await page.locator('[data-web-shell-model-button]').click();
  const controls = page.locator('[data-web-shell-model-reasoning]');
  const modelButton = page.locator('[data-web-shell-model-button]');
  const modelSubmenu = page.locator('[data-web-shell-model-submenu-trigger]');
  const thinking = controls.locator('[data-web-shell-thinking-toggle]');
  const medium = controls.locator('[data-web-shell-effort="medium"]');
  const xhigh = controls.locator('[data-web-shell-effort="xhigh"]');
  await expect(controls).toBeVisible();
  await expect(modelSubmenu).toBeVisible();
  await expect(modelButton).toContainText('Extra High');
  await expect(thinking).toBeChecked();
  await expect(xhigh).toHaveAttribute('aria-pressed', 'true');

  await medium.click();
  await expect.poll(() => daemon.configOptionRequests().length).toBe(1);
  expect(
    requestBodyRecord(firstRequest(daemon.configOptionRequests())),
  ).toEqual({ configId: 'reasoning_effort', value: 'medium' });
  await expect(medium).toHaveAttribute('aria-pressed', 'true');
  await expect(modelButton).toContainText('Medium');

  await thinking.click();
  await expect.poll(() => daemon.configOptionRequests().length).toBe(2);
  expect(requestBodyRecord(daemon.configOptionRequests()[1]!)).toEqual({
    configId: 'reasoning_effort',
    value: 'none',
  });
  await expect(thinking).not.toBeChecked();
  await expect(medium).toBeDisabled();
  await expect(medium).toHaveAttribute('aria-pressed', 'true');
  await expect(modelButton).toContainText('Thinking Off');

  await thinking.click();
  await expect.poll(() => daemon.configOptionRequests().length).toBe(3);
  expect(requestBodyRecord(daemon.configOptionRequests()[2]!)).toEqual({
    configId: 'reasoning_effort',
    value: 'medium',
  });
  await expect(thinking).toBeChecked();
  await expect(modelButton).toContainText('Medium');

  await modelSubmenu.click();
  await expect(page.locator('[data-web-shell-model-submenu]')).toBeVisible();
  await expect(
    page.locator('[data-web-shell-model-submenu] input[type="search"]'),
  ).toBeVisible();
});

test('previews qwen3.8-max reasoning before lazy session creation @smoke', async ({
  page,
}, testInfo) => {
  const stableModel = {
    modelId: 'qwen3.8-max',
    baseModelId: 'qwen3.8-max',
    name: 'qwen3.8-max',
    contextLimit: 131_072,
    isCurrent: true,
    isRuntime: false,
    configOptions: qwen38ReasoningConfigOptions(),
  };
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    state: {
      configOptions: qwen38ReasoningConfigOptions('none'),
      models: {
        currentModelId: 'qwen3.8-max',
        availableModels: [
          {
            modelId: 'qwen3.8-max',
            baseModelId: 'qwen3.8-max',
            name: 'qwen3.8-max',
            contextLimit: 131_072,
          },
        ],
      },
    },
    providers: {
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'qwen-oauth',
          current: true,
          models: [
            stableModel,
            {
              modelId: 'qwen3.8-max-preview',
              baseModelId: 'qwen3.8-max-preview',
              name: 'qwen3.8-max-preview',
              isCurrent: false,
              isRuntime: false,
            },
            {
              modelId: 'qwen3.8-max-latest',
              baseModelId: 'qwen3.8-max-latest',
              name: 'qwen3.8-max-latest',
              isCurrent: false,
              isRuntime: false,
            },
            {
              modelId: 'qwen-plus',
              baseModelId: 'qwen-plus',
              name: 'qwen-plus',
              isCurrent: false,
              isRuntime: false,
            },
          ],
        },
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page);

  const modelButton = page.locator('[data-web-shell-model-button]');
  await expect(modelButton).toContainText('qwen3.8-max · Extra High');
  await modelButton.click();
  const controls = page.locator('[data-web-shell-model-reasoning]');
  await expect(controls).toBeVisible();
  await expect(
    controls.locator('[data-web-shell-thinking-toggle]'),
  ).toBeChecked();
  await expect(
    controls.locator('[data-web-shell-thinking-toggle]'),
  ).toBeEnabled();
  await expect(controls.locator('[data-web-shell-effort="low"]')).toBeEnabled();
  const medium = controls.locator('[data-web-shell-effort="medium"]');
  await expect(medium).toBeEnabled();
  await expect(
    controls.locator('[data-web-shell-effort="xhigh"]'),
  ).toBeVisible();
  await medium.click();
  await expect(medium).toHaveAttribute('aria-pressed', 'true');
  await expect(modelButton).toContainText('qwen3.8-max · Medium');
  const thinking = controls.locator('[data-web-shell-thinking-toggle]');
  await thinking.click();
  await expect(thinking).not.toBeChecked();
  await expect(medium).toBeDisabled();
  await expect(medium).toHaveAttribute('aria-pressed', 'true');
  await expect(modelButton).toContainText('qwen3.8-max · Thinking Off');
  await thinking.click();
  await expect(thinking).toBeChecked();
  await expect(medium).toBeEnabled();
  await expect(modelButton).toContainText('qwen3.8-max · Medium');
  expect(daemon.configOptionRequests()).toHaveLength(0);
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toHaveLength(0);
  await page.locator('[data-web-shell-model-submenu-trigger]').click();
  await page
    .locator('[data-web-shell-model-submenu]')
    .getByRole('button', { name: 'qwen3.8-max-preview', exact: true })
    .click();
  await expect(modelButton).toContainText('qwen3.8-max-preview');
  await expect(modelButton).not.toContainText('Extra High');

  await modelButton.click();
  await expect(page.locator('[data-web-shell-model-reasoning]')).toHaveCount(0);
  await page
    .locator('[data-web-shell-toolbar-popover]:visible')
    .getByRole('button', { name: 'qwen3.8-max-latest', exact: true })
    .click();
  await expect(modelButton).toContainText('qwen3.8-max-latest');
  await expect(modelButton).not.toContainText('Extra High');

  await modelButton.click();
  await page
    .locator('[data-web-shell-toolbar-popover]:visible')
    .getByRole('button', { name: 'qwen-plus', exact: true })
    .click();
  await expect(modelButton).toContainText('qwen-plus');
  await expect(modelButton).not.toContainText('Extra High');

  await modelButton.click();
  await page
    .locator('[data-web-shell-toolbar-popover]:visible')
    .getByRole('button', { name: 'qwen3.8-max', exact: true })
    .click();
  await expect(modelButton).toContainText('qwen3.8-max · Medium');
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toHaveLength(0);

  await page.keyboard.press('Escape');
  await fillComposer(page, 'Create the lazy session');
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect
    .poll(
      () =>
        daemon.requests.filter(
          (request) => request.method === 'POST' && request.path === '/session',
        ).length,
    )
    .toBe(1);
  await expect.poll(() => daemon.configOptionRequests().length).toBe(1);
  expect(
    requestBodyRecord(firstRequest(daemon.configOptionRequests())),
  ).toEqual({
    configId: 'reasoning_effort',
    value: 'medium',
  });
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const configRequestIndex = daemon.requests.findIndex(
    (request) =>
      request.method === 'POST' &&
      /\/session\/[^/]+\/config-option$/.test(request.path),
  );
  const promptRequestIndex = daemon.requests.findIndex(
    (request) =>
      request.method === 'POST' &&
      /\/session\/[^/]+\/prompt\/?$/.test(request.path),
  );
  expect(configRequestIndex).toBeGreaterThanOrEqual(0);
  const modelRequestIndex = daemon.requests.findIndex(
    (request) =>
      request.method === 'POST' &&
      /\/session\/[^/]+\/model$/.test(request.path),
  );
  expect(modelRequestIndex).toBeGreaterThanOrEqual(0);
  expect(modelRequestIndex).toBeLessThan(configRequestIndex);
  expect(configRequestIndex).toBeLessThan(promptRequestIndex);
  await expect(modelButton).toContainText('qwen3.8-max · Medium');
  await modelButton.click();
  await expect(page.locator('[data-web-shell-thinking-toggle]')).toBeChecked();
  await expect(page.locator('[data-web-shell-thinking-toggle]')).toBeEnabled();
  await expect(
    page.locator('[data-web-shell-effort="medium"]'),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('does not apply a model-bound welcome effort after switching models @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    state: { configOptions: [], models: undefined },
    providers: {
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'qwen-oauth',
          current: true,
          models: [
            {
              modelId: 'qwen3.8-max',
              baseModelId: 'qwen3.8-max',
              name: 'qwen3.8-max',
              isCurrent: true,
              isRuntime: false,
              configOptions: qwen38ReasoningConfigOptions(),
            },
            {
              modelId: 'qwen-plus',
              baseModelId: 'qwen-plus',
              name: 'qwen-plus',
              isCurrent: false,
              isRuntime: false,
            },
          ],
        },
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page);

  const modelButton = page.locator('[data-web-shell-model-button]');
  await modelButton.click();
  await page.locator('[data-web-shell-effort="medium"]').click();
  await page.locator('[data-web-shell-model-submenu-trigger]').click();
  await page
    .locator('[data-web-shell-model-submenu]')
    .getByRole('button', { name: 'qwen-plus', exact: true })
    .click();
  await expect(modelButton).toContainText('qwen-plus');
  await expect(modelButton).not.toContainText('Medium');

  await page.keyboard.press('Escape');
  await fillComposer(page, 'Use the non-reasoning model');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expect(daemon.configOptionRequests()).toHaveLength(0);
});

test('cancels the first prompt when live reasoning capability is missing @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    state: { configOptions: [], models: undefined },
    providers: {
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'qwen-oauth',
          current: true,
          models: [
            {
              modelId: 'qwen3.8-max',
              baseModelId: 'qwen3.8-max',
              name: 'qwen3.8-max',
              isCurrent: true,
              isRuntime: false,
              configOptions: qwen38ReasoningConfigOptions(),
            },
          ],
        },
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page);

  const modelButton = page.locator('[data-web-shell-model-button]');
  await modelButton.click();
  await page.locator('[data-web-shell-effort="medium"]').click();
  await page.keyboard.press('Escape');
  const prompt = 'Keep this prompt for retry';
  await fillComposer(page, prompt);
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.configOptionRequests().length).toBe(1);
  await expect(
    page.locator('[data-web-shell-composer-editor] .cm-content'),
  ).toContainText(prompt);
  await expect(modelButton).toContainText('qwen3.8-max · Medium');
  expect(daemon.promptRequests()).toHaveLength(0);

  scenario.state.configOptions = qwen38ReasoningConfigOptions('none');
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect.poll(() => daemon.configOptionRequests().length).toBe(2);
  expect(requestBodyRecord(daemon.configOptionRequests()[1]!)).toEqual({
    configId: 'reasoning_effort',
    value: 'medium',
  });
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
});

test('does not invent welcome reasoning for an older daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    providers: {
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'qwen-oauth',
          current: true,
          models: [
            {
              modelId: 'qwen3.8-max',
              baseModelId: 'qwen3.8-max',
              name: 'qwen3.8-max',
              isCurrent: true,
              isRuntime: false,
            },
          ],
        },
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page);

  const modelButton = page.locator('[data-web-shell-model-button]');
  await expect(modelButton).toContainText('qwen3.8-max');
  await expect(modelButton).not.toContainText('Extra High');
  await modelButton.click();
  await expect(page.locator('[data-web-shell-model-reasoning]')).toHaveCount(0);
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toHaveLength(0);
});

test('does not fall back to welcome preview when live context lacks reasoning @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    contextDelayMs: 2_000,
    state: {
      configOptions: [],
      models: undefined,
    },
    providers: {
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'qwen-oauth',
          current: true,
          models: [
            {
              modelId: 'qwen3.8-max',
              baseModelId: 'qwen3.8-max',
              name: 'qwen3.8-max',
              isCurrent: true,
              isRuntime: false,
              configOptions: qwen38ReasoningConfigOptions(),
            },
          ],
        },
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page);

  const modelButton = page.locator('[data-web-shell-model-button]');
  await expect(modelButton).toContainText('qwen3.8-max · Extra High');
  await fillComposer(page, 'Attach a session without reasoning capability');
  const contextResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      /^\/session\/[^/]+\/context\/?$/.test(url.pathname) &&
      response.ok()
    );
  });
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect
    .poll(
      () =>
        daemon.requests.filter(
          (request) => request.method === 'POST' && request.path === '/session',
        ).length,
    )
    .toBe(1);
  await expect
    .poll(
      () =>
        daemon.requests.some(
          (request) =>
            request.method === 'GET' &&
            /^\/session\/[^/]+\/context\/?$/.test(request.path),
        ),
      { timeout: 1_000 },
    )
    .toBe(true);
  await expect(modelButton).not.toContainText('Extra High', { timeout: 1_000 });
  await contextResponse;
  await expect(modelButton).toContainText('qwen3.8-max');
  await expect(modelButton).not.toContainText('Extra High');
  await expect(modelButton).not.toContainText('Thinking');
  await modelButton.click();
  await expect(page.locator('[data-web-shell-model-reasoning]')).toHaveCount(0);
});

test('toggles reasoning without effort tiers for qwen3.7-plus @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.7-plus',
    state: {
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'none', name: 'Thinking off' },
            { value: 'default', name: 'Thinking on' },
          ],
          _meta: {
            'qwenCode/reasoning': { toggleOnly: true },
          },
        },
      ],
    },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const modelButton = page.locator('[data-web-shell-model-button]');
  await modelButton.click();
  const controls = page.locator('[data-web-shell-model-reasoning]');
  const thinking = controls.locator('[data-web-shell-thinking-toggle]');
  await expect(controls).toBeVisible();
  await expect(thinking).toBeChecked();
  await expect(controls.locator('[data-web-shell-effort]')).toHaveCount(0);
  await expect(modelButton).toContainText('Thinking');

  await thinking.click();
  await expect.poll(() => daemon.configOptionRequests().length).toBe(1);
  expect(
    requestBodyRecord(firstRequest(daemon.configOptionRequests())),
  ).toEqual({ configId: 'reasoning_effort', value: 'none' });
  await expect(thinking).not.toBeChecked();
  await expect(modelButton).toContainText('Thinking Off');

  await thinking.click();
  await expect.poll(() => daemon.configOptionRequests().length).toBe(2);
  expect(requestBodyRecord(daemon.configOptionRequests()[1]!)).toEqual({
    configId: 'reasoning_effort',
    value: 'default',
  });
  await expect(thinking).toBeChecked();
  await expect(modelButton).toContainText('Thinking');
});

test('uploads an Extension archive from the manager @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  let uploadUrl = '';
  let uploadHeaders: Record<string, string> = {};
  let uploadBody: Buffer | null = null;
  let rejectUpload = false;
  await page.route(
    '**/workspace/extensions/install-archive?*',
    async (route) => {
      uploadUrl = route.request().url();
      uploadHeaders = route.request().headers();
      uploadBody = route.request().postDataBuffer();
      await route.fulfill({
        contentType: 'application/json',
        status: rejectUpload ? 400 : 202,
        body: JSON.stringify(
          rejectUpload
            ? { error: 'Archive rejected for test' }
            : { accepted: true, operationId: 'op-upload' },
        ),
      });
    },
  );
  await page.route(
    '**/workspace/extensions/operations/op-upload',
    async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          v: 1,
          operationId: 'op-upload',
          operation: 'install',
          status: 'succeeded',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          result: {
            status: 'installed',
            source: 'upload:demo.zip',
            name: 'demo',
            version: '1.0.0',
          },
        }),
      });
    },
  );

  await gotoSession(page, scenario, daemon);
  await submitLocalCommand(page, '/extensions');
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('tab', { name: 'Archive' }).click();
  const archiveInput = page.getByLabel('Select a .zip or .tar.gz archive.');
  await archiveInput.setInputFiles({
    name: 'stale.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('stale-archive'),
  });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('tab', { name: 'Archive' }).click();
  await expect(page.getByText('Selected archive: stale.zip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();

  await archiveInput.setInputFiles({
    name: 'backup.gz',
    mimeType: 'application/gzip',
    buffer: Buffer.from('archive-content'),
  });
  await expect(
    page.getByText(
      'Select a .zip or .tar.gz Extension archive with a valid filename up to 255 bytes.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();

  await archiveInput.setInputFiles({
    name: `${'扩'.repeat(84)}.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from('archive-content'),
  });
  await expect(
    page.getByText(
      'Select a .zip or .tar.gz Extension archive with a valid filename up to 255 bytes.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();

  for (const name of ['bad\\name.zip', 'bad\u007fname.zip']) {
    await archiveInput.setInputFiles({
      name,
      mimeType: 'application/zip',
      buffer: Buffer.from('archive-content'),
    });
    await expect(
      page.getByText(
        'Select a .zip or .tar.gz Extension archive with a valid filename up to 255 bytes.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();
  }

  await archiveInput.setInputFiles({
    name: 'empty.zip',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(0),
  });
  await expect(
    page.getByText('The selected Extension archive is empty.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();

  await archiveInput.setInputFiles({
    name: `${'a'.repeat(251)}.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from('archive-content'),
  });
  await expect(page.getByRole('button', { name: 'Install' })).toBeEnabled();

  await archiveInput.setInputFiles({
    name: 'exact.zip',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(10 * 1024 * 1024),
  });
  await expect(page.getByRole('button', { name: 'Install' })).toBeEnabled();

  await archiveInput.setInputFiles({
    name: 'large.zip',
    mimeType: 'application/zip',
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
  });
  await expect(
    page.getByText('Extension archives must be 10 MB or smaller.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();

  await archiveInput.setInputFiles({
    name: 'demo.tar.gz',
    mimeType: 'application/gzip',
    buffer: Buffer.from('archive-content'),
  });
  await expect(page.getByText('Selected archive: demo.tar.gz')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install' })).toBeEnabled();

  await archiveInput.setInputFiles({
    name: 'demo.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('archive-content'),
  });
  await expect(page.getByText('Selected archive: demo.zip')).toBeVisible();
  rejectUpload = true;
  await page.getByRole('button', { name: 'Install' }).click();
  await expect(page.getByText('Archive rejected for test')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Add Extension' }),
  ).toBeVisible();
  await expect(page.getByText('Selected archive: demo.zip')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install' })).toBeEnabled();

  uploadUrl = '';
  uploadHeaders = {};
  uploadBody = null;
  rejectUpload = false;
  await page.getByRole('button', { name: 'Install' }).click();

  await expect
    .poll(() => uploadUrl)
    .toContain(
      '/workspace/extensions/install-archive?filename=demo.zip&consent=true',
    );
  expect(uploadHeaders['content-type']).toBe('application/octet-stream');
  expect(uploadHeaders['x-qwen-client-id']).toBe(scenario.clientId);
  expect(uploadBody?.toString()).toBe('archive-content');
  await expect(
    page.getByRole('heading', { name: 'Add Extension' }),
  ).toHaveCount(0);
  await expect(page.getByText('Extension "demo" installed.')).toBeVisible();
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('tab', { name: 'Source' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Archive' }).click();
  await expect(page.getByText('Selected archive: demo.zip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Install' })).toBeDisabled();
});

test('pastes long plain text as editable composer content @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  const pasted = `${'original '.repeat(151)}end`;
  const edited = `${pasted} edited`;

  await gotoSession(page, scenario, daemon);
  await pasteComposerText(page, pasted);

  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await expect(editor).toHaveText(pasted);
  await expect(editor).not.toContainText('Pasted Content');

  await page.keyboard.type(' edited');
  await expect(editor).toHaveText(edited);
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    requestBodyRecord(firstRequest(daemon.promptRequests())),
    edited,
  );
});

test('keeps later SSE connections alive when an earlier one is cancelled @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await page.reload();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await completeReplay(page, daemon, scenario.sessionId);
  await fillComposer(page, 'Second connection should still stream');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await daemon.sse.split(
    assistantTextEvent('Reconnect-safe SSE payload', { id: 20 }),
  );
  await daemon.sendEvent(turnCompleteEvent('prompt-reconnect', { id: 21 }));

  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Reconnect-safe SSE payload',
  );
});

test('clears fake SSE connection records when streams close or error @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  const baseURL = String(testInfo.project.use.baseURL);

  await page.goto('data:text/html,<html></html>');
  await openRawSseConnection(page, baseURL, scenario.sessionId);
  const firstConnection = await daemon.sse.waitForConnection(
    scenario.sessionId,
  );
  expect(firstConnection.sessionId).toBe(scenario.sessionId);

  await daemon.sse.close();
  await expect
    .poll(async () => (await daemon.sse.connections()).length)
    .toBe(0);

  await openRawSseConnection(page, baseURL, scenario.sessionId);
  const secondConnection = await daemon.sse.waitForConnection(
    scenario.sessionId,
  );
  expect(secondConnection.sessionId).toBe(scenario.sessionId);

  await daemon.sse.error('test SSE error');
  await expect
    .poll(async () => (await daemon.sse.connections()).length)
    .toBe(0);
});

test('submits permission decisions through the fake daemon @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [permissionRequestEvent('perm-1', { id: 1 })],
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator('[data-web-shell-permission-panel]')).toBeVisible();
  await page
    .locator('[data-web-shell-permission-option][data-option-id="allow_once"]')
    .click();

  await expect.poll(() => daemon.permissionRequests().length).toBe(1);
  const permissionRequest = firstRequest(daemon.permissionRequests());
  expect(permissionRequest.method).toBe('POST');
  expect(permissionRequest.path).toBe(
    `/session/${scenario.sessionId}/permission/perm-1`,
  );
  expect(requestBodyRecord(permissionRequest)).toEqual({
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  });
});

test('opens slash menu, resume dialog, model dialog, and theme dialog @smoke', async ({
  page,
}, testInfo) => {
  const resumedSessionId = 'previous-session';
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await fillComposer(page, '/');
  await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();
  const composingEscapePrevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(composingEscapePrevented).toBe(false);
  await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();

  await submitLocalCommand(page, '/resume');
  await expect(page.locator('[data-web-shell-resume-dialog]')).toBeVisible();
  await page
    .locator(
      `[data-web-shell-resume-session][data-session-id="${resumedSessionId}"]`,
    )
    .click();
  await expect(page.locator('[data-web-shell-resume-dialog]')).toHaveCount(0);
  await completeReplay(page, daemon, resumedSessionId);

  await submitLocalCommand(page, '/model');
  await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
  await page
    .locator('[data-web-shell-model-option][data-model-id="qwen-test-alt"]')
    .click();
  await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);
  await expect.poll(() => daemon.modelRequests().length).toBe(1);
  const modelRequest = firstRequest(daemon.modelRequests());
  expect(modelRequest.method).toBe('POST');
  expect(modelRequest.path).toBe(`/session/${resumedSessionId}/model`);
  expect(requestBodyRecord(modelRequest)).toEqual({
    modelId: 'qwen-test-alt',
  });

  await page.reload();
  await completeReplay(page, daemon);
  await submitLocalCommand(page, '/model');
  await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
  await expect(
    page.locator(
      '[data-web-shell-model-option][data-model-id="qwen-test-alt"]',
    ),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'close' }).click();
  await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);

  await submitLocalCommand(page, '/theme');
  await expect(page.locator('[data-web-shell-theme-dialog]')).toBeVisible();
  await page
    .locator('[data-web-shell-theme-option][data-theme-id="light"]')
    .click();
  await expect(page.locator('[data-web-shell-theme-dialog]')).toHaveCount(0);
});

test('selects and scrolls scheduled-task prompt references @smoke', async ({
  page,
}, testInfo) => {
  const extensions = Array.from({ length: 20 }, (_, index) => ({
    id: `extension-${index + 1}`,
    name: `extension-${index + 1}`,
    displayName: `Extension ${index + 1}`,
    description: '',
    version: '1.0.0',
    isActive: true,
    path: `/extensions/${index + 1}`,
    capabilities: {},
  }));
  const scenario = createWebShellDaemonScenario({
    extensions: { extensions },
  });
  const daemon = await installScenario(page, scenario, testInfo);
  await page.route('**/scheduled-tasks', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    });
  });

  await gotoSession(page, scenario, daemon);
  await page.getByRole('button', { name: 'Scheduled Tasks' }).click();
  await page.getByRole('button', { name: 'New scheduled task' }).click();

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect
    .poll(() => prompt.evaluate((element) => getComputedStyle(element).cursor))
    .toBe('text');

  const extensionsButton = page.getByRole('button', { name: 'Extensions' });
  const promptStyles = await prompt.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, color: style.color };
  });
  const referenceButtonStyles = await page
    .getByRole('button', { name: /^(Extensions|Skills|MCP)$/ })
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          color: style.color,
        };
      }),
    );
  expect(referenceButtonStyles).toHaveLength(3);
  for (const style of referenceButtonStyles) {
    expect(style.backgroundColor).toBe(promptStyles.backgroundColor);
    expect(style.borderColor).not.toBe(promptStyles.color);
    expect(style.color).not.toBe(promptStyles.color);
  }

  await extensionsButton.hover();
  await expect
    .poll(() =>
      extensionsButton.evaluate((element) => {
        const style = getComputedStyle(element);
        return { borderColor: style.borderColor, color: style.color };
      }),
    )
    .toEqual({
      borderColor: promptStyles.color,
      color: promptStyles.color,
    });
  await extensionsButton.click();

  const picker = page.getByRole('listbox', { name: 'Reference picker' });
  await expect(picker).toBeVisible();
  await expect
    .poll(() =>
      picker.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      ),
    )
    .toBe(true);

  await picker.hover();
  await page.mouse.wheel(0, 400);
  await expect
    .poll(() => picker.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  await page.getByRole('option', { name: /extension-20 Extension 20/ }).click();
  const tag = prompt.locator(
    '[data-prompt-tag-serialized="@ext:extension-20"]',
  );
  await expect(tag).toBeVisible();
  const promptBox = await prompt.boundingBox();
  if (!promptBox) throw new Error('Prompt editor has no bounding box');
  const blankPosition = {
    x: promptBox.width - 40,
    y: promptBox.height / 2,
  };
  const remove = tag.locator('[data-prompt-tag-remove]');

  await prompt.hover({ position: blankPosition });
  await expect(
    remove.evaluate((element) => element.matches(':hover')),
  ).resolves.toBe(false);
  await prompt.click({ position: blankPosition });
  await expect(tag).toBeVisible();

  await remove.click();
  await expect(tag).toHaveCount(0);
});

test('gates voice dictation on the workspace voice setting @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    voice: {
      enabled: false,
    },
  });
  scenario.capabilities.features = [
    ...scenario.capabilities.features,
    'voice_transcribe',
  ];
  const daemon = await installScenario(page, scenario, testInfo);
  const voiceButton = page.getByRole('button', {
    name: 'Start voice dictation',
  });

  await gotoSession(page, scenario, daemon);
  await expect(voiceButton).toHaveCount(0);

  scenario.voice.enabled = true;
  await page.reload();
  await completeReplay(page, daemon);
  await expect(voiceButton).toBeVisible();
});

test('loads Voice status from the active secondary workspace @smoke', async ({
  page,
}, testInfo) => {
  const secondaryCwd = '/work/secondary';
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: secondaryCwd,
    capabilities: {
      workspaceCwd: '/work/primary',
      features: [
        'session_events',
        'workspace_qualified_voice',
        'workspace_qualified_rest_core',
        'workspace_settings',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/work/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: secondaryCwd,
          primary: false,
          trusted: true,
        },
      ],
    },
    voice: { enabled: true, workspaceCwd: secondaryCwd },
  });
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  await expect(
    page.getByRole('button', { name: 'Start voice dictation' }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        daemon.requests.filter(
          (request) =>
            request.method === 'GET' &&
            request.path === '/workspaces/secondary/voice',
        ).length,
    )
    .toBeGreaterThan(0);
  expect(
    daemon.requests.some(
      (request) =>
        request.method === 'GET' && request.path === '/workspace/voice',
    ),
  ).toBe(false);
});

test('anchors the empty mobile composer to the chat pane across the breakpoint @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const scenario = createWebShellDaemonScenario();
  await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page);
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await expectEmptyMobileWelcomeChromeVisible(page);

  const narrowLayout = await emptyMobileComposerLayout(page);
  expectEmptyMobileComposerAnchored(narrowLayout);

  await editor.click();
  await page.keyboard.type('Composer remains interactive');
  await expect(editor).toContainText('Composer remains interactive');

  await page.setViewportSize({ width: 761, height: 900 });
  await expect
    .poll(() => emptyMobileComposerLayout(page))
    .toMatchObject({
      chatViewPosition: 'static',
      footerPosition: 'relative',
    });
  const wideLayout = await emptyMobileComposerLayout(page);
  if (
    wideLayout.welcomeFooterTop === null ||
    wideLayout.welcomeFooterBottom === null
  ) {
    throw new Error('Expected a visible welcome footer above the breakpoint.');
  }
  expect(wideLayout.welcomeFooterBottom).toBeGreaterThan(
    wideLayout.welcomeFooterTop,
  );

  await page.setViewportSize({ width: 760, height: 900 });
  await expect
    .poll(() => emptyMobileComposerLayout(page))
    .toMatchObject({
      chatViewPosition: 'static',
      footerPosition: 'absolute',
    });
  const narrowLayoutAfterResize = await emptyMobileComposerLayout(page);
  expectEmptyMobileComposerAnchored(narrowLayoutAfterResize);
});

test('anchors the empty mobile composer without a welcome footer @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const scenario = createWebShellDaemonScenario();
  await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page, { welcomeFooter: false });
  await expectEmptyMobileWelcomeChromeVisible(page, {
    requireWelcomeFooter: false,
  });

  const layout = await emptyMobileComposerLayout(page, {
    requireWelcomeFooter: false,
  });
  expectEmptyMobileComposerAnchored(layout, {
    requireWelcomeFooter: false,
  });
});

test('keeps the bottom status panel visible in the custom footer mobile welcome variant @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const scenario = createWebShellDaemonScenario();
  await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page, { customFooter: true });
  const composer = page.locator(emptyMobileComposerSelectors.composerSurface);
  const customFooter = page.locator('[data-e2e-custom-footer]');
  const statusItem = page.getByText('Bottom status item');
  const chatPane = page.getByTestId('chat-pane-container');

  await expect(composer).toBeVisible();
  await expect(customFooter).toBeVisible();
  await expect(statusItem).toHaveCount(1);

  const statusPanelBox = await statusItem.boundingBox();
  const chatPaneBox = await chatPane.boundingBox();
  if (!statusPanelBox || !chatPaneBox) {
    throw new Error('Expected the status panel and chat pane to be measured.');
  }
  expect(statusPanelBox.height).toBeGreaterThan(0);
  expect(statusPanelBox.y).toBeGreaterThanOrEqual(chatPaneBox.y);
  expect(statusPanelBox.y + statusPanelBox.height).toBeLessThanOrEqual(
    chatPaneBox.y + chatPaneBox.height,
  );

  // This variant renders the composer footer `display: contents`, so the
  // anchored-layout helper has no footer box to measure and must reject
  // instead of reporting a misleading zero rect.
  await expect(emptyMobileComposerLayout(page)).rejects.toThrow(
    /custom footer welcome variant/,
  );
});

test('anchors the empty mobile composer with a custom footer but no welcome footer @smoke', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const scenario = createWebShellDaemonScenario();
  await installScenario(page, scenario, testInfo);

  await gotoEmptyMobileWelcomeHarness(page, {
    customFooter: true,
    welcomeFooter: false,
  });
  await expect(page.locator('[data-e2e-custom-footer]')).toBeVisible();
  await expectEmptyMobileWelcomeChromeVisible(page, {
    requireWelcomeFooter: false,
  });

  const layout = await emptyMobileComposerLayout(page, {
    requireWelcomeFooter: false,
  });
  expectEmptyMobileComposerAnchored(layout, {
    requireWelcomeFooter: false,
  });
});

for (const viewportHeight of COMPOSER_VIEWPORT_HEIGHTS) {
  test(`grows long text to the responsive composer cap at ${viewportHeight}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: viewportHeight });
    const scenario = createWebShellDaemonScenario();
    const daemon = await installScenario(page, scenario, testInfo);

    await gotoSession(page, scenario, daemon);
    const surface = page.locator('[data-web-shell-composer-surface]');
    const initialHeight = await composerHeight(page);
    expect(initialHeight).toBe(140);

    await replaceComposerText(
      page,
      Array.from(
        { length: 10 },
        (_, index) => `Visible line ${index + 1}`,
      ).join('\n'),
    );
    await expect
      .poll(() => composerHeight(page))
      .toBeGreaterThan(initialHeight);

    await replaceComposerText(
      page,
      Array.from({ length: 80 }, (_, index) => `Capped line ${index + 1}`).join(
        '\n',
      ),
    );
    await expectCappedComposerLayout(page, viewportHeight);
    await expect(surface).toBeVisible();

    await page.keyboard.press('Control+r');
    const historySearch = surface.locator('input');
    await expect(historySearch).toBeVisible();
    const searchPanel = historySearch.locator('..').locator('..');
    await expect
      .poll(async () => {
        const [panelBox, surfaceBox] = await Promise.all([
          searchPanel.boundingBox(),
          surface.boundingBox(),
        ]);
        if (!panelBox || !surfaceBox) return Number.POSITIVE_INFINITY;
        return panelBox.y + panelBox.height - surfaceBox.y;
      })
      .toBeLessThanOrEqual(-7);
    // The search input takes focus asynchronously after Ctrl+R; Escape only
    // dismisses the panel when it lands on that input, so pin focus first.
    await expect(historySearch).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(historySearch).toHaveCount(0);

    const modeButton = page.locator('[data-web-shell-mode-button]');
    await modeButton.click();
    const modeDropdown = page.locator(
      '[data-web-shell-toolbar-popover][data-state="open"]',
    );
    await expect(modeDropdown).toBeVisible();
    await expect
      .poll(async () => {
        const [dropdownBox, buttonBox] = await Promise.all([
          modeDropdown.boundingBox(),
          modeButton.boundingBox(),
        ]);
        if (!dropdownBox || !buttonBox) return Number.POSITIVE_INFINITY;
        return dropdownBox.y + dropdownBox.height - buttonBox.y;
      })
      .toBeLessThanOrEqual(-3);

    const modelButton = page.locator('[data-web-shell-model-button]');
    await modelButton.click();
    await expect(
      page.locator('[data-web-shell-toolbar-popover] input[type="search"]'),
    ).toBeVisible();
    await modeButton.click();
    await expect(modeDropdown).toBeVisible();
    await expect(modeDropdown.locator('input[type="search"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await replaceComposerText(page, 'Short draft');
    await expect.poll(() => composerHeight(page)).toBe(initialHeight);
  });
}

for (const viewportHeight of COMPOSER_VIEWPORT_HEIGHTS) {
  test(`bounds attachments and long text at ${viewportHeight}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: viewportHeight });
    const scenario = createWebShellDaemonScenario({
      sessionId: `composer-layout-${viewportHeight}`,
    });
    const daemon = await installScenario(page, scenario, testInfo);

    await gotoComposerLayoutHarness(page, scenario, daemon);
    const tags = page.locator('[data-web-shell-composer-tag]');
    await expect(tags).toHaveCount(18);
    await expect(tags.first()).toBeVisible();

    await pasteComposerImages(page, 8);
    const images = page.locator(
      '[data-web-shell-composer-images] img[src^="data:image/png;base64,"]',
    );
    await expect(images).toHaveCount(8);
    await expectImagesDecoded(images);
    await replaceComposerText(
      page,
      Array.from(
        { length: 80 },
        (_, index) => `Attachment line ${index + 1}`,
      ).join('\n'),
    );

    await expectCappedComposerLayout(page, viewportHeight);
    const attachments = page.locator('[data-web-shell-composer-attachments]');
    await expect(attachments).toBeVisible();
    await expect
      .poll(async () => (await attachments.boundingBox())?.height ?? 0)
      .toBeLessThanOrEqual(136);
    await expect
      .poll(() =>
        attachments.evaluate(
          (element) => element.scrollHeight > element.clientHeight + 1,
        ),
      )
      .toBe(true);

    if (viewportHeight === 600) {
      await tags
        .first()
        .locator('[data-web-shell-composer-tag-trigger]')
        .hover();
      const portalRoot = page.locator('[data-web-shell-portal-root]');
      const tooltip = portalRoot.locator(
        '[data-web-shell-composer-tag-tooltip]',
      );
      await expect(tooltip).toBeVisible();
      await expect
        .poll(async () =>
          tooltip.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const tolerance = 1;
            return (
              getComputedStyle(element).overflowY === 'auto' &&
              rect.top >= 8 - tolerance &&
              rect.left >= 8 - tolerance &&
              rect.right <= window.innerWidth - 8 + tolerance &&
              rect.bottom <= window.innerHeight - 8 + tolerance
            );
          }),
        )
        .toBe(true);
    }

    await attachments.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(async () => {
        const [attachmentsBox, tagBox] = await Promise.all([
          attachments.boundingBox(),
          tags.last().boundingBox(),
        ]);
        if (!attachmentsBox || !tagBox) return false;
        const tolerance = 1;
        return (
          tagBox.y >= attachmentsBox.y - tolerance &&
          tagBox.y + tagBox.height <=
            attachmentsBox.y + attachmentsBox.height + tolerance
        );
      })
      .toBe(true);
  });
}

test('lets a pasted image grow the composer without collapsing the text viewport @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const initialHeight = await composerHeight(page);
  await pasteComposerImages(page, 1);

  const image = page.locator(
    '[data-web-shell-composer-surface] img[src^="data:image/png;base64,"]',
  );
  await expect(image).toHaveCount(1);
  await expectImagesDecoded(image);
  await expect.poll(() => composerHeight(page)).toBeGreaterThan(initialHeight);
  await expect
    .poll(async () => {
      const box = await page
        .locator('[data-web-shell-composer-editor]')
        .boundingBox();
      return box?.height ?? 0;
    })
    .toBeGreaterThanOrEqual(44);

  await image.locator('..').getByRole('button').click();
  await expect(image).toHaveCount(0);
  await expect.poll(() => composerHeight(page)).toBe(initialHeight);
});

test('drops ordered PNG and BMP images and submits them without text @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const surface = page.locator('[data-web-shell-composer-surface]');
  await dragComposerFileOver(surface);
  await expect(surface).toHaveAttribute('data-image-drag-active', 'true');

  await dropComposerImages(surface);
  await expect(surface).not.toHaveAttribute('data-image-drag-active');
  await expect(surface).not.toHaveAttribute('aria-busy');
  const images = surface.locator(
    '[data-web-shell-composer-images] img[src^="data:image/"]',
  );
  await expect(images).toHaveCount(2);
  await expectImagesDecoded(images);

  const submit = page.locator('[data-web-shell-composer-submit]');
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const prompt = requestBodyRecord(firstRequest(daemon.promptRequests()))[
    'prompt'
  ];
  expect(Array.isArray(prompt)).toBe(true);
  const blocks = prompt as Array<Record<string, unknown>>;
  expect(blocks[0]).toMatchObject({ type: 'text', text: '' });
  expect(blocks.slice(1)).toEqual([
    {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      mimeType: 'image/png',
    },
    {
      type: 'image',
      data: 'Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==',
      mimeType: 'image/bmp',
    },
  ]);
  const transcriptImages = page.locator(
    '[data-web-shell-message-list] img[src^="data:image/"]',
  );
  await expect(transcriptImages).toHaveCount(2);
  await expectImagesDecoded(transcriptImages);
});

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(
    page,
    daemon,
    scenario.sessionId,
    scenario.events.length,
  );
}

async function gotoComposerLayoutHarness(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(
    `/e2e/composer-layout-harness.html?sessionId=${encodeURIComponent(scenario.sessionId)}`,
  );
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(page, daemon, scenario.sessionId);
}

async function completeReplay(
  page: Page,
  daemon: MockDaemonController,
  sessionId?: string,
  replayedCount = 0,
): Promise<void> {
  const connection = await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.type(text);
}

async function replaceComposerText(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.insertText(text);
}

async function pasteComposerText(page: Page, text: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.evaluate((clipboardText) => {
    return navigator.clipboard.writeText(clipboardText);
  }, text);
  await page.locator('[data-web-shell-composer-editor] .cm-content').click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+V' : 'Control+V',
  );
}

async function pasteComposerImages(page: Page, count: number): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.evaluate((element, imageCount) => {
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const binary = atob(pngBase64);
    const pngBytes = Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
    const clipboard = new DataTransfer();
    for (let index = 0; index < imageCount; index += 1) {
      clipboard.items.add(
        new File([pngBytes], `pasted-${index + 1}.png`, { type: 'image/png' }),
      );
    }
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, count);
}

async function dragComposerFileOver(surface: Locator): Promise<void> {
  await surface.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([0])], 'dragged.png', { type: 'image/png' }),
    );
    element.dispatchEvent(
      new DragEvent('dragenter', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
}

async function dropComposerImages(surface: Locator): Promise<void> {
  await surface.evaluate((element) => {
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const binary = atob(pngBase64);
    const pngBytes = Uint8Array.from(binary, (byte) => byte.charCodeAt(0));
    const bmpBytes = new Uint8Array(58);
    const view = new DataView(bmpBytes.buffer);
    bmpBytes.set([0x42, 0x4d]);
    view.setUint32(2, bmpBytes.length, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, 1, true);
    view.setInt32(22, 1, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    view.setUint32(34, 4, true);
    bmpBytes.set([0x00, 0x00, 0xff, 0x00], 54);
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([pngBytes], 'first.png', { type: 'image/png' }),
    );
    transfer.items.add(
      new File([bmpBytes], 'second.bmp', { type: 'image/bmp' }),
    );
    element.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
}

async function expectImagesDecoded(images: Locator): Promise<void> {
  await expect
    .poll(() =>
      images.evaluateAll((elements) =>
        elements.every(
          (element) =>
            element instanceof HTMLImageElement &&
            element.complete &&
            element.naturalWidth > 0 &&
            element.naturalHeight > 0,
        ),
      ),
    )
    .toBe(true);
}

async function expectCappedComposerLayout(
  page: Page,
  viewportHeight: number,
): Promise<void> {
  const maximumHeight = Math.min(350, viewportHeight * 0.4);
  await expect
    .poll(() => composerHeight(page))
    .toBeGreaterThanOrEqual(maximumHeight - 1);
  await expect
    .poll(() => composerHeight(page))
    .toBeLessThanOrEqual(maximumHeight + 1);

  const surface = page.locator('[data-web-shell-composer-surface]');
  const editorHost = page.locator('[data-web-shell-composer-editor]');
  const editorArea = editorHost.locator('..');
  const scroller = editorHost.locator('.cm-scroller');
  const content = scroller.locator('.cm-content');
  const toolbar = page
    .locator('[data-web-shell-composer-submit]')
    .locator('..')
    .locator('..');

  await expect
    .poll(async () => (await editorArea.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
  await expect(toolbar).toBeVisible();
  await expect
    .poll(async () => {
      const [surfaceBox, toolbarBox] = await Promise.all([
        surface.boundingBox(),
        toolbar.boundingBox(),
      ]);
      if (!surfaceBox || !toolbarBox) return false;
      return (
        toolbarBox.y >= surfaceBox.y - 1 &&
        toolbarBox.y + toolbarBox.height <= surfaceBox.y + surfaceBox.height + 1
      );
    })
    .toBe(true);

  await expect
    .poll(() =>
      editorArea.evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe('clip');
  await expect
    .poll(() =>
      editorHost.evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe('clip');
  await expect
    .poll(() =>
      scroller.evaluate((element) => getComputedStyle(element).overflowY),
    )
    .toBe('auto');
  await expect
    .poll(() =>
      editorArea.evaluate(
        (element) => element.scrollHeight <= element.clientHeight + 1,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      editorHost.evaluate(
        (element) => element.scrollHeight <= element.clientHeight + 1,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      ),
    )
    .toBe(true);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop > 0))
    .toBe(true);
  await expect(content).toBeFocused();
}

async function composerHeight(page: Page): Promise<number> {
  const box = await page
    .locator('[data-web-shell-composer-surface]')
    .boundingBox();
  if (!box) throw new Error('Expected the composer surface to be visible.');
  return box.height;
}

async function submitLocalCommand(page: Page, text: string): Promise<void> {
  await fillComposer(page, text);
  await page.locator('[data-web-shell-composer-submit]').click();
}

async function openRawSseConnection(
  page: Page,
  baseURL: string,
  sessionId: string,
): Promise<void> {
  await page.evaluate(
    async ({ baseURL, sessionId }) => {
      const response = await fetch(
        `${baseURL}/session/${encodeURIComponent(sessionId)}/events`,
      );
      const holder = window as Window & {
        __webShellRawSseResponses?: Response[];
      };
      holder.__webShellRawSseResponses ??= [];
      holder.__webShellRawSseResponses.push(response);
    },
    { baseURL, sessionId },
  );
}

function firstRequest(
  requests: readonly DaemonRequestRecord[],
): DaemonRequestRecord {
  const request = requests[0];
  if (!request) throw new Error('Expected a recorded daemon request.');
  return request;
}

function requestBodyRecord(
  request: DaemonRequestRecord,
): Record<string, unknown> {
  expect(typeof request.body).toBe('object');
  expect(request.body).not.toBeNull();
  expect(Array.isArray(request.body)).toBe(false);
  return request.body as Record<string, unknown>;
}

function expectPromptBodyToContainText(
  body: Record<string, unknown>,
  text: string,
): void {
  const prompt = body['prompt'];
  expect(Array.isArray(prompt)).toBe(true);
  const blocks = prompt as readonly unknown[];
  expect(
    blocks.some(
      (block) =>
        isRecord(block) && block['type'] === 'text' && block['text'] === text,
    ),
  ).toBe(true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
