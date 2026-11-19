import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  toolCallEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

for (const language of ['en', 'zh-CN']) {
  test(`artifact text stays clear of its actions on narrow screens (${language})`, async ({
    page,
  }, testInfo) => {
    const scenario = createWebShellDaemonScenario({
      capabilities: { features: ['session_events', 'session_artifacts'] },
      events: [
        userTextEvent('Create Markdown artifacts.', { id: 1 }),
        toolCallEvent('make-artifacts', 'Artifact', {}, { id: 2 }),
        assistantTextEvent('Artifacts ready.', { id: 3 }),
        turnCompleteEvent('done', { id: 4 }),
      ],
      artifacts: [
        'fy27b14-ui-feature-testset.md',
        `${'long-filename-'.repeat(12)}.md`,
        'short.md',
      ].map((name, index) => ({
        id: `artifact-${index}`,
        title: name,
        kind: 'file',
        storage: 'workspace',
        source: 'tool',
        status: index === 2 ? 'available' : 'changed',
        workspacePath: name,
        mimeType: 'text/markdown',
        sizeBytes: 12083,
        retention: 'ephemeral',
        clientRetained: false,
        toolCallId: 'make-artifacts',
        toolName: 'Artifact',
        createdAt: '2026-10-22T00:00:00Z',
        updatedAt: '2026-10-22T00:00:00Z',
      })),
    });
    await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    await page.goto(`/session/${scenario.sessionId}?lang=${language}`);
    const infos = page.locator(
      '[data-web-shell-message-list] [class*="artifactInfo"]',
    );
    await expect(infos).toHaveCount(3);

    for (const width of [320, 375, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const info of await infos.all()) {
        const summary = info.locator('..');
        const actions = summary.locator('[class*="actions"]');
        await expect(actions.getByRole('button')).toHaveCount(2);
        const actionBounds = await actions.boundingBox();
        const cardBounds = await summary.boundingBox();
        expect(actionBounds).not.toBeNull();
        expect(cardBounds).not.toBeNull();
        expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(
          cardBounds!.x + cardBounds!.width,
        );
        for (const text of await info.locator(':scope > div').all()) {
          const bounds = await text.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.width).toBeGreaterThan(0);
          expect(
            bounds!.x + bounds!.width <= actionBounds!.x ||
              bounds!.y + bounds!.height <= actionBounds!.y,
          ).toBe(true);
          await expect(text).toHaveCSS('overflow-x', 'hidden');
          await expect(text).toHaveCSS('text-overflow', 'ellipsis');
        }
      }
    }
  });
}
