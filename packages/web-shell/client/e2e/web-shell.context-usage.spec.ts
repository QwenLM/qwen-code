import { expect, test } from '@playwright/test';
import type { DaemonSessionContextUsageStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

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
