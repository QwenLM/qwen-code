import { expect, test } from '@playwright/test';
import type {
  DaemonSessionContextUsageStatus,
  PromptRequest,
} from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
} from './utils/mockDaemon';

test('shows context usage after first-prompt model metadata overtakes attach metadata', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    currentModel: 'qwen3.8-max',
    state: {
      models: {
        currentModelId: 'qwen3.8-max',
        availableModels: [
          {
            modelId: 'qwen3.8-max',
            name: 'qwen3.8-max',
            _meta: { contextLimit: 65_536 },
          },
        ],
      },
      configOptions: [
        {
          id: 'reasoning_effort',
          currentValue: 'medium',
          options: [{ value: 'none' }, { value: 'medium' }],
        },
      ],
    },
  });
  for (const provider of scenario.providers.providers) {
    for (const model of provider.models) {
      delete model.contextLimit;
      model.name = model.baseModelId;
    }
  }
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let contextReads = 0;
  let releaseInitialContext!: () => void;
  const initialContextReady = new Promise<void>((resolve) => {
    releaseInitialContext = resolve;
  });
  await page.route(/\/session\/[^/]+\/context(?:\?|$)/, async (route) => {
    if (++contextReads === 1) await initialContextReady;
    await route.fulfill({
      json: {
        v: 1,
        sessionId: scenario.sessionId,
        workspaceCwd: scenario.workspaceCwd,
        state: scenario.state,
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('[data-web-shell-model-button]')).toContainText(
    'qwen3.8-max',
  );
  await page.locator('[data-web-shell-composer-editor] .cm-content').fill('Hi');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => contextReads).toBe(2);
  await expect(page.locator('[data-web-shell-model-button]')).toContainText(
    'Medium',
  );
  releaseInitialContext();
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  const prompt = daemon.promptRequests()[0].body as PromptRequest;
  await daemon.sendEvent({
    v: 1,
    id: 1,
    type: 'session_update',
    data: {
      sessionId: scenario.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
        _meta: { usage: { inputTokens: 16_384, outputTokens: 10 } },
      },
    },
  });
  await daemon.sendEvent(
    turnCompleteEvent(String(prompt._meta?.['promptId'] ?? 'prompt-e2e'), {
      id: 2,
      sessionId: scenario.sessionId,
    }),
  );
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Hello',
  );
  await expect(page.locator('[data-web-shell-context-usage]')).toBeVisible();
  await expect(page.locator('[data-web-shell-context-usage]')).toContainText(
    '25',
  );
  await page.screenshot({ path: testInfo.outputPath('context-usage.png') });
});

for (const width of [390, 1200]) {
  test(`large context details stay readable at ${width}px @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const scenario = createWebShellDaemonScenario();
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    const tools = Array.from({ length: 800 }, (_, i) => ({
      name: `server_${i}__查询资源_${'lookup_resource_description_'.repeat(2)}`,
      tokens: 100,
    }));
    const status: DaemonSessionContextUsageStatus = {
      v: 1,
      sessionId: scenario.sessionId,
      workspaceCwd: scenario.workspaceCwd,
      usage: {
        modelName: 'qwen-context-test',
        totalTokens: 100000,
        contextWindowSize: 128000,
        breakdown: {
          systemPrompt: 5000,
          builtinTools: 1000,
          mcpTools: 80000,
          memoryFiles: 1000,
          skills: 1000,
          messages: 12000,
          freeSpace: 28000,
          autocompactBuffer: 10000,
        },
        builtinTools: [],
        mcpTools: tools,
        memoryFiles: [],
        skills: [],
        showDetails: true,
      },
      formattedText: tools
        .map(({ name, tokens }) => `${name}: ${tokens} tokens`)
        .join('\n'),
    };
    expect(JSON.stringify(status).length).toBeGreaterThan(100000);
    await page.route('**/session/*/context-usage*', (route) =>
      route.fulfill({ json: status }),
    );
    await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
    const connection = await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: connection.sessionId,
        replayedCount: 0,
      }),
    );
    await expect(page.getByText('Loading...')).toHaveCount(0);
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.fill(width === 390 ? '/context -d' : '/context detail');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    const card = page.getByRole('group', {
      name: 'Context Usage',
      exact: true,
    });
    await expect(card).toBeVisible();
    await expect(card.getByText(tools[0].name, { exact: true })).toHaveCount(1);
    await expect(card.getByText(tools[799].name, { exact: true })).toHaveCount(
      1,
    );
    const messages = page.locator('[data-web-shell-message-list]');
    await expect(messages).not.toContainText('web-shell:context-usage:v1:');
    await expect(messages).not.toContainText('[truncated]');
    await expect(messages).not.toContainText('�');
    await card
      .getByText(tools[799].name, { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      card.getByText(tools[799].name, { exact: true }),
    ).toBeVisible();
  });
}
