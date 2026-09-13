/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  DaemonAuthProviderCatalog,
  DaemonAuthProviderInstallRequest,
  DaemonModelConfiguration,
} from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

async function openModelSettings(page: Page, testInfo: TestInfo) {
  const scenario = createWebShellDaemonScenario({
    settings: {
      settings: (
        [
          ['fastModel', 'Fast Model'],
          ['advisorModel', 'Advisor Model'],
          ['imageModel', 'Image Model'],
          ['voiceModel', 'Voice Model'],
        ] as const
      ).map(([key, label]) => ({
        key,
        type: 'string',
        label,
        category: 'Model',
        requiresRestart: false,
        default: '',
        values: { effective: '' },
      })),
    },
    voice: {
      availableVoiceModels: [
        { id: 'qwen3-asr-flash', transport: 'qwen-asr-chat' },
        { id: 'qwen3-asr-flash-realtime', transport: 'qwen-asr-realtime' },
      ],
    },
  });
  scenario.capabilities.features.push('voice_transcribe');
  scenario.providers.providers.push({
    kind: 'model_provider',
    status: 'ok',
    authType: 'openai',
    current: false,
    models: [
      {
        modelId: 'configured-test-model',
        configurationKey: 'configured-test-key',
        baseModelId: 'configured-test-model',
        name: 'Configured Test Model',
        description: 'Configured for image and audio input.',
        contextLimit: 131072,
        modalities: { image: true, audio: true, video: false, pdf: false },
        baseUrl: 'https://models.example/v1',
        envKey: 'WEB_SHELL_TEST_API_KEY',
        isCurrent: false,
        isRuntime: false,
      },
      {
        modelId: 'configured-test-model',
        configurationKey: 'configured-second-key',
        baseModelId: 'configured-test-model',
        name: 'Configured Second Endpoint',
        baseUrl: 'https://second.example/v1',
        envKey: 'SECOND_API_KEY',
        isCurrent: false,
        isRuntime: false,
      },
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  const catalog: DaemonAuthProviderCatalog = {
    v: 1,
    workspaceCwd: scenario.workspaceCwd,
    providers: [
      {
        id: 'custom-openai-compatible',
        label: 'Custom Provider',
        description: 'Custom provider',
        protocol: 'openai',
        protocolOptions: ['openai', 'anthropic', 'gemini'],
        steps: ['protocol', 'baseUrl', 'apiKey', 'models', 'advancedConfig'],
        showAdvancedConfig: true,
      },
    ],
    groups: [
      {
        id: 'custom',
        label: 'Custom',
        description: 'Custom providers',
        providerIds: ['custom-openai-compatible'],
      },
    ],
  };
  await page.route('**/workspace/auth/providers', (route) =>
    route.fulfill({ json: catalog }),
  );
  const configurations: DaemonModelConfiguration[] = [
    {
      key: 'configured-test-key',
      authType: 'openai',
      modelId: 'configured-test-model',
      name: 'Configured Test Model',
      baseUrl: 'https://models.example/v1',
      envKey: 'WEB_SHELL_TEST_API_KEY',
      contextWindowSize: 131072,
      purpose: 'chat',
      advisorModel: 'openai:configured-test-model\0https://models.example/v1',
    },
    {
      key: 'configured-second-key',
      authType: 'openai',
      modelId: 'configured-test-model',
      name: 'Configured Second Endpoint',
      baseUrl: 'https://second.example/v1',
      envKey: 'SECOND_API_KEY',
      purpose: 'chat',
      advisorModel: 'openai:configured-test-model\0https://second.example/v1',
    },
    ...['one', 'two'].map((endpoint) => ({
      key: `image-${endpoint}-key`,
      authType: 'openai',
      modelId: 'image-model',
      name: `Image endpoint ${endpoint}`,
      baseUrl: `https://images-${endpoint}.example/v1`,
      envKey: `IMAGE_${endpoint.toUpperCase()}_KEY`,
      purpose: 'image' as const,
      imageModel: `openai:image-model\0https://images-${endpoint}.example/v1`,
    })),
    {
      key: 'voice-config-key',
      authType: 'openai',
      modelId: 'qwen3-asr-flash',
      name: 'Voice Only ASR',
      baseUrl: 'https://voice.example/v1',
      envKey: 'VOICE_API_KEY',
      purpose: 'voice',
    },
  ];
  await page.route('**/workspace/models', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { models: configurations } });
    } else {
      await route.fallback();
    }
  });
  await page.route('**/workspace/settings', async (route) => {
    let changed:
      | { key: string; value: unknown; scope: 'user' | 'workspace' }
      | undefined;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as {
        key: string;
        value: unknown;
        scope: 'user' | 'workspace';
      };
      const setting = scenario.settings.settings.find(
        (item) => item.key === body.key,
      );
      if (setting) {
        setting.values = {
          ...setting.values,
          effective: body.value,
          [body.scope]: body.value,
        };
      }
      changed = body;
    }
    await route.fallback();
    if (changed)
      await daemon.sendEvent({ v: 1, type: 'settings_changed', data: changed });
  });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({ sessionId: connection.sessionId }),
  );
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    await page
      .getByRole('button', { name: 'Toggle menu', exact: true })
      .click();
  }
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .first()
    .click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: /^Model/ })
    .click();
  const modelList = page.getByTestId('model-management');
  await expect(
    modelList.getByText('configured-test-model', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    modelList.getByText('Configured for image and audio input.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    modelList.getByText('Context: 131,072 tokens', { exact: true }),
  ).toBeVisible();
  await expect(
    modelList.getByText('WEB_SHELL_TEST_API_KEY', { exact: true }),
  ).toBeVisible();
  await expect(modelList.getByText('Image', { exact: true })).toBeVisible();
  await expect(modelList.getByText('Audio', { exact: true })).toBeVisible();
  await expect(modelList.getByText('Video', { exact: true })).toHaveCount(0);
  await expect(
    modelList.getByRole('button', { name: 'Delete Qwen Test', exact: true }),
  ).toHaveCount(0);
  await expect(
    modelList.getByRole('button', {
      name: 'Delete Configured Test Model',
      exact: true,
    }),
  ).toBeVisible();
  await modelList.scrollIntoViewIfNeeded();
  const listBounds = await modelList.boundingBox();
  expect(listBounds).not.toBeNull();
  expect(listBounds!.x).toBeGreaterThanOrEqual(0);
  expect(listBounds!.x + listBounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.screenshot({
    path: testInfo.outputPath('model-list.png'),
    fullPage: true,
  });
  return { daemon, scenario, configurations };
}

async function openAdvancedConfiguration(page: Page, testInfo: TestInfo) {
  await openModelSettings(page, testInfo);
  await page.getByRole('button', { name: '+ Add Model', exact: true }).click();
  await enterCustomConnection(page);
}

async function enterCustomConnection(page: Page) {
  await page.getByRole('button', { name: /Custom providers/ }).click();
  await page
    .getByRole('button', { name: /Standard OpenAI API format/ })
    .click();
  await page
    .getByLabel('Base URL', { exact: true })
    .fill('https://models.example/v1');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('test-only-api-key');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page
    .getByLabel('Model IDs', { exact: true })
    .fill('test-model, second-model, test-model');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await expect(
    page.getByLabel('Context window', { exact: true }),
  ).toBeVisible();
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`configures and reviews model limits at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openAdvancedConfiguration(page, testInfo);
    await page
      .getByRole('switch', { name: 'Enable thinking', exact: true })
      .check();
    await page
      .getByRole('switch', { name: 'Enable modality', exact: true })
      .check();
    await page.getByRole('checkbox', { name: 'Image', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Video', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Audio', exact: true }).check();
    await expect(
      page.getByRole('checkbox', { name: 'PDF', exact: true }),
    ).not.toBeChecked();
    const context = page.getByLabel('Context window', { exact: true });
    const maxTokens = page.getByLabel('Maximum output tokens', { exact: true });
    await context.fill('131072');
    await context.press('Tab');
    await expect(maxTokens).toBeFocused();
    await maxTokens.fill('8192');
    for (const input of [context, maxTokens]) {
      const bounds = await input.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.screenshot({
      path: testInfo.outputPath('advanced.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'previous', exact: true }).click();
    await expect(page.getByLabel('Model IDs', { exact: true })).toHaveValue(
      'test-model, second-model, test-model',
    );
    await page.getByRole('button', { name: 'next', exact: true }).click();
    await expect(context).toHaveValue('131072');
    await expect(maxTokens).toHaveValue('8192');
    await expect(
      page.getByRole('switch', { name: 'Enable thinking', exact: true }),
    ).toBeChecked();
    await page.getByRole('button', { name: 'next', exact: true }).click();
    await expect(page.getByText('131072', { exact: true })).toBeVisible();
    await expect(page.getByText('8192', { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole('dialog', { name: 'Connect a Provider' })
        .getByText('https://models.example/v1', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Image, Audio', { exact: true })).toBeVisible();
    await expect(page.getByText('Set (hidden)', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Connect a Provider' }),
    ).not.toContainText('test-only-api-key');
    await page.screenshot({
      path: testInfo.outputPath('review.png'),
      fullPage: true,
    });

    const requests: DaemonAuthProviderInstallRequest[] = [];
    let releaseSave: () => void = () => {};
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await page.route('**/workspace/auth/provider', async (route) => {
      requests.push(
        route.request().postDataJSON() as DaemonAuthProviderInstallRequest,
      );
      await saveGate;
      await route.fulfill({
        json: {
          v: 1,
          providerId: 'custom-openai-compatible',
          providerLabel: 'Custom Provider',
          authType: 'openai',
          message: 'Provider saved.',
        },
      });
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Saving...', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'previous', exact: true }),
    ).toBeDisabled();
    await expect
      .poll(() => requests)
      .toEqual([
        {
          providerId: 'custom-openai-compatible',
          protocol: 'openai',
          baseUrl: 'https://models.example/v1',
          apiKey: 'test-only-api-key',
          modelIds: ['test-model', 'second-model'],
          advancedConfig: {
            replaceExisting: true,
            enableThinking: true,
            multimodal: { image: true, audio: true },
            contextWindowSize: 131072,
            maxTokens: 8192,
          },
        },
      ]);
    releaseSave();
    await expect(
      page.getByRole('dialog', { name: 'Connect a Provider' }),
    ).toHaveCount(0);
  });
}

test('keeps invalid values editable and preserves defaults on a failed save', async ({
  page,
}, testInfo) => {
  await openAdvancedConfiguration(page, testInfo);
  const context = page.getByLabel('Context window', { exact: true });
  const maxTokens = page.getByLabel('Maximum output tokens', { exact: true });
  for (const input of [context, maxTokens]) {
    for (const value of ['0', '-1', '1.5', 'abc', '10000001']) {
      await input.fill(value);
      await page.getByRole('button', { name: 'next', exact: true }).click();
      await expect(input).toHaveValue(value);
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(
        page.getByRole('button', { name: 'Save', exact: true }),
      ).toHaveCount(0);
    }
    await input.fill('');
  }
  await page
    .getByRole('switch', { name: 'Enable modality', exact: true })
    .check();
  await page.getByRole('checkbox', { name: 'Image', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Video', exact: true }).uncheck();
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await expect(
    page.getByText('Select at least one input type or turn off modality.', {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole('switch', { name: 'Enable modality', exact: true })
    .uncheck();
  await page.getByRole('button', { name: 'next', exact: true }).click();

  const requests: DaemonAuthProviderInstallRequest[] = [];
  await page.route('**/workspace/auth/provider', async (route) => {
    requests.push(
      route.request().postDataJSON() as DaemonAuthProviderInstallRequest,
    );
    await route.fulfill(
      requests.length === 1
        ? {
            status: 500,
            json: {
              error: 'Test save failed',
              code: 'save_failed',
            },
          }
        : {
            json: {
              v: 1,
              providerId: 'custom-openai-compatible',
              providerLabel: 'Custom Provider',
              authType: 'openai',
              message: 'Provider saved.',
            },
          },
    );
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole('alert')).toContainText('Test save failed');
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'previous', exact: true }).click();
  await expect(context).toHaveValue('');
  await expect(maxTokens).toHaveValue('');
  await expect(
    page.getByRole('switch', { name: 'Enable modality', exact: true }),
  ).not.toBeChecked();
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toHaveProperty('advancedConfig', {
    replaceExisting: true,
  });
  expect(requests[1]).toEqual(requests[0]);
  await expect(
    page.getByRole('dialog', { name: 'Connect a Provider' }),
  ).toHaveCount(0);
});

test('starts a fresh provider configuration with default limits and capabilities', async ({
  page,
}, testInfo) => {
  await openAdvancedConfiguration(page, testInfo);
  await page.getByLabel('Context window', { exact: true }).fill('2048');
  await page.getByLabel('Maximum output tokens', { exact: true }).fill('4096');
  await page
    .getByRole('switch', { name: 'Enable thinking', exact: true })
    .check();
  await page
    .getByRole('switch', { name: 'Enable modality', exact: true })
    .check();
  await page.getByRole('checkbox', { name: 'Image', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Video', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Audio', exact: true }).check();
  await page.getByRole('combobox', { name: 'Model purpose' }).click();
  await page
    .getByRole('option', { name: 'Image generation', exact: true })
    .click();
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole('button', { name: 'previous', exact: true }).click();
  }
  await enterCustomConnection(page);
  await expect(
    page.getByRole('combobox', { name: 'Model purpose' }),
  ).toContainText('Conversation');
  await expect(page.getByLabel('Context window', { exact: true })).toHaveValue(
    '',
  );
  await expect(
    page.getByLabel('Maximum output tokens', { exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('switch', { name: 'Enable thinking', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('switch', { name: 'Enable modality', exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole('switch', { name: 'Enable modality', exact: true })
    .check();
  await expect(
    page.getByRole('checkbox', { name: 'Image', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Video', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Audio', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'PDF', exact: true }),
  ).not.toBeChecked();
});

function roleSetting(page: Page, name: string) {
  return page.getByRole('group').filter({
    has: page.locator('[data-slot="field-label"]').filter({ hasText: name }),
  });
}

test('retries role configurations after closing and reopening a failed picker', async ({
  page,
}, testInfo) => {
  const { configurations } = await openModelSettings(page, testInfo);
  let reads = 0;
  await page.route('**/workspace/models', async (route) => {
    reads += 1;
    await route.fulfill(
      reads === 1
        ? {
            status: 500,
            json: { error: 'Temporary model configuration failure' },
          }
        : { json: { models: configurations } },
    );
  });
  await roleSetting(page, 'Advisor Model').getByRole('button').click();
  const picker = page.getByRole('listbox', { name: 'Set Advisor Model' });
  await expect(picker.getByRole('alert')).toContainText(
    'Temporary model configuration failure',
  );
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await roleSetting(page, 'Advisor Model').getByRole('button').click();
  await expect(
    picker.getByRole('option', {
      name: /Configured (Test Model|Second Endpoint)/,
    }),
  ).toHaveCount(2);
  expect(reads).toBe(2);
});

test('selects Advisor defaults, endpoint-specific image routes, and voice-only ASR choices', async ({
  page,
}, testInfo) => {
  const { daemon } = await openModelSettings(page, testInfo);
  await roleSetting(page, 'Advisor Model').getByRole('button').click();
  const advisor = page.getByRole('listbox', { name: 'Set Advisor Model' });
  await expect(
    advisor.getByRole('option', {
      name: /Configured (Test Model|Second Endpoint)/,
    }),
  ).toHaveCount(2);
  await advisor
    .getByRole('option', { name: /Configured Second Endpoint/ })
    .click();
  await expect
    .poll(() =>
      daemon.requests
        .filter(
          (request) =>
            request.method === 'POST' && request.path === '/workspace/settings',
        )
        .map((request) => request.body),
    )
    .toContainEqual({
      scope: 'workspace',
      key: 'advisorModel',
      value: 'openai:configured-test-model\0https://second.example/v1',
    });
  await roleSetting(page, 'Advisor Model').getByRole('button').click();
  await advisor.getByRole('option', { name: /Use main model/ }).click();
  await expect
    .poll(() =>
      daemon.requests
        .filter(
          (request) =>
            request.method === 'POST' && request.path === '/workspace/settings',
        )
        .map((request) => request.body),
    )
    .toContainEqual({
      scope: 'workspace',
      key: 'advisorModel',
      value: '',
    });

  await roleSetting(page, 'Image Model').getByRole('button').click();
  const images = page.getByRole('listbox', { name: 'Set Image Model' });
  await expect(
    images.getByRole('option', { name: /Image endpoint/ }),
  ).toHaveCount(2);
  await images.getByRole('option', { name: /Image endpoint two/ }).click();
  await expect
    .poll(() =>
      daemon.requests
        .filter(
          (request) =>
            request.method === 'POST' && request.path === '/workspace/settings',
        )
        .map((request) => request.body),
    )
    .toContainEqual({
      scope: 'workspace',
      key: 'imageModel',
      value: 'openai:image-model\0https://images-two.example/v1',
    });
  await roleSetting(page, 'Image Model').getByRole('button').click();
  await expect(
    images.getByRole('option', { name: /Image endpoint two/ }),
  ).toHaveAttribute('aria-selected', 'true');
  await images.getByRole('option', { name: /Disabled/ }).click();
  await expect
    .poll(() =>
      daemon.requests
        .filter(
          (request) =>
            request.method === 'POST' && request.path === '/workspace/settings',
        )
        .map((request) => request.body),
    )
    .toContainEqual({
      scope: 'workspace',
      key: 'imageModel',
      value: '',
    });

  await roleSetting(page, 'Voice Model').getByRole('button').click();
  const voices = page.getByRole('listbox', { name: 'Set Voice Model' });
  await expect(voices.getByRole('option')).toHaveCount(2);
  await voices
    .getByRole('option', { name: /qwen3-asr-flash-realtime/ })
    .click();
  await expect
    .poll(() =>
      daemon.requests
        .filter(
          (request) =>
            request.method === 'POST' && request.path === '/workspace/settings',
        )
        .map((request) => request.body),
    )
    .toContainEqual({
      scope: 'workspace',
      key: 'voiceModel',
      value: 'qwen3-asr-flash-realtime',
    });
  expect(
    daemon.requests.some((request) => request.path === '/workspace/voice'),
  ).toBe(true);
  expect(daemon.modelRequests()).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath('model-roles.png'),
    fullPage: true,
  });
});

for (const [purpose, label, modelId] of [
  ['image', 'Image generation', 'image-generation-test'],
  ['voice', 'Voice transcription', 'qwen3-asr-flash'],
] as const) {
  test(`adds custom ${purpose} model configuration without a conversation-model request`, async ({
    page,
  }, testInfo) => {
    const { daemon } = await openModelSettings(page, testInfo);
    await page
      .getByRole('button', { name: '+ Add Model', exact: true })
      .click();
    await enterCustomConnection(page);
    await page.getByRole('button', { name: 'previous', exact: true }).click();
    await page.getByLabel('Model IDs', { exact: true }).fill(modelId);
    await page.getByRole('button', { name: 'next', exact: true }).click();
    await page.getByRole('combobox', { name: 'Model purpose' }).click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect(
      page.getByRole('switch', { name: 'Enable thinking', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Maximum output tokens', { exact: true }),
    ).toHaveCount(0);
    await page.getByLabel('Context window', { exact: true }).fill('32768');
    await page.getByRole('button', { name: 'next', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect a Provider' });
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    const requests: DaemonAuthProviderInstallRequest[] = [];
    await page.route('**/workspace/auth/provider', async (route) => {
      requests.push(
        route.request().postDataJSON() as DaemonAuthProviderInstallRequest,
      );
      await route.fulfill({
        json: {
          v: 1,
          providerId: 'custom-openai-compatible',
          providerLabel: 'Custom Provider',
          authType: 'openai',
          message: 'Provider saved.',
        },
      });
    });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => requests)
      .toEqual([
        {
          providerId: 'custom-openai-compatible',
          protocol: 'openai',
          baseUrl: 'https://models.example/v1',
          apiKey: 'test-only-api-key',
          modelIds: [modelId],
          advancedConfig: {
            replaceExisting: true,
            purpose,
            contextWindowSize: 32768,
          },
        },
      ]);
    await expect(dialog).toHaveCount(0);
    expect(daemon.modelRequests()).toHaveLength(0);
  });
}

test('reports a failed runtime sync after saving a context window', async ({
  page,
}, testInfo) => {
  const { configurations } = await openModelSettings(page, testInfo);
  await page.route('**/workspace/models', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    expect(route.request().postDataJSON()).toEqual({
      key: 'configured-test-key',
      contextWindowSize: 65536,
    });
    configurations.find(
      (item) => item.key === 'configured-test-key',
    )!.contextWindowSize = 65536;
    await route.fulfill({
      json: {
        updated: true,
        requiresRestart: true,
        runtimeSync: { status: 'failed' },
      },
    });
  });
  const edit = page.getByRole('button', {
    name: 'Edit context window Configured Test Model',
    exact: true,
  });
  await edit.click();
  await page.getByLabel('Context window', { exact: true }).fill('65536');
  await page
    .getByRole('button', { name: 'save Configured Test Model', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'The change was saved, but running sessions could not be refreshed. Restart qwen serve before using the updated model list.',
  );
  await edit.click();
  await expect(page.getByLabel('Context window', { exact: true })).toHaveValue(
    '65536',
  );
});

test('edits a persisted context window, retries a failure, and resets to automatic', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { configurations, daemon, scenario } = await openModelSettings(
    page,
    testInfo,
  );
  const reloadSettings = async () => {
    await page.reload();
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    await page
      .getByRole('button', { name: 'Toggle menu', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Settings', exact: true })
      .first()
      .click();
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: /^Model/ })
      .click();
  };
  const configuration = configurations.find(
    (item) => item.key === 'configured-test-key',
  )!;
  const updates: Array<{ key: string; contextWindowSize: number | null }> = [];
  let failNextSave = true;
  await page.route('**/workspace/models', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      key: string;
      contextWindowSize: number | null;
    };
    updates.push(body);
    if (failNextSave) {
      failNextSave = false;
      await route.fulfill({
        status: 500,
        json: {
          error: 'Test context save failed',
          code: 'write_failed',
        },
      });
      return;
    }
    if (body.contextWindowSize === null) delete configuration.contextWindowSize;
    else configuration.contextWindowSize = body.contextWindowSize;
    await route.fulfill({ json: { updated: true, requiresRestart: true } });
  });
  const edit = page.getByRole('button', {
    name: 'Edit context window Configured Test Model',
    exact: true,
  });
  await edit.click();
  const context = page.getByLabel('Context window', { exact: true });
  await expect(context).toHaveValue('131072');
  await context.fill('0');
  await expect(
    page.getByRole('button', {
      name: 'save Configured Test Model',
      exact: true,
    }),
  ).toBeDisabled();
  expect(updates).toHaveLength(0);
  await context.fill('65536');
  await page
    .getByRole('button', { name: 'save Configured Test Model', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Test context save failed',
  );
  await expect(context).toHaveValue('65536');
  await page
    .getByRole('button', { name: 'save Configured Test Model', exact: true })
    .click();
  await expect(edit).toBeVisible();
  await expect
    .poll(() => updates)
    .toEqual([
      { key: 'configured-test-key', contextWindowSize: 65536 },
      { key: 'configured-test-key', contextWindowSize: 65536 },
    ]);
  await expect(
    page.getByText('Saved. Restart existing sessions to apply.', {
      exact: true,
    }),
  ).toBeVisible();
  await edit.click();
  await expect(
    page.getByText('Saved. Restart existing sessions to apply.', {
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Cancel Configured Test Model', exact: true })
    .click();
  await reloadSettings();
  await edit.click();
  await expect(context).toHaveValue('65536');
  await context.fill('');
  await page
    .getByRole('button', { name: 'save Configured Test Model', exact: true })
    .click();
  await expect(edit).toBeVisible();
  await expect
    .poll(() => updates.at(-1))
    .toEqual({ key: 'configured-test-key', contextWindowSize: null });
  await reloadSettings();
  await edit.click();
  await expect(context).toHaveValue('');
  await page.screenshot({
    path: testInfo.outputPath('edit-context-window-mobile.png'),
    fullPage: true,
  });
});
