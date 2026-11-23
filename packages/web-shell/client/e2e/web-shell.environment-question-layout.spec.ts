import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  permissionRequestEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test('floating environment panel and pending question stay reachable @smoke', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1080, height: 940 });
  const timestamp = '2026-10-22T00:00:00Z';
  const lastArtifactName = 'artifact-20.md';
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Create Markdown artifacts.', { id: 1 }),
      assistantTextEvent('Artifacts ready.', { id: 2 }),
      turnCompleteEvent('prepare-artifacts', { id: 3 }),
    ],
    artifacts: Array.from({ length: 20 }, (_, index) => {
      const name = `artifact-${String(index + 1).padStart(2, '0')}.md`;
      return {
        id: name,
        title: name,
        kind: 'file',
        storage: 'workspace',
        source: 'tool',
        status: 'available',
        workspacePath: name,
        mimeType: 'text/markdown',
        retention: 'ephemeral',
        clientRetained: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }),
  });
  scenario.capabilities.features.push('session_artifacts');
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${scenario.sessionId}?lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await expect(
    page.getByText('Artifacts ready.', { exact: true }),
  ).toBeVisible();

  const toggle = page.getByRole('button', {
    name: 'Toggle environment information',
  });
  const panel = page.getByTestId('environment-panel');
  const lastArtifact = panel.getByRole('button', {
    name: lastArtifactName,
    exact: true,
  });
  await toggle.click();
  await expect(panel).toHaveAttribute('data-floating', 'true');
  await expect(lastArtifact).toBeVisible();
  const restingPanel = (await panel.boundingBox())!;

  await daemon.sendEvent(
    permissionRequestEvent('environment-question', {
      id: 4,
      sessionId: scenario.sessionId,
      toolCall: {
        toolCallId: 'environment-question',
        title: 'Ask user 1 question',
        kind: 'think',
        _meta: { toolName: 'ask_user_question' },
        rawInput: {
          questions: [
            {
              header: 'Next step',
              question: 'Which artifacts should I keep?',
              options: [
                { label: 'All', description: 'Keep all artifacts' },
                { label: 'Latest', description: 'Keep only the last artifact' },
              ],
            },
          ],
        },
      },
    }),
  );
  const question = page.locator('[data-web-shell-ask-panel]');
  await expect(question).toContainText('Which artifacts should I keep?');
  const option = question.getByRole('radio', { name: /Keep all artifacts/ });
  const submit = question.getByRole('button', { name: /^Submit/ });

  for (const height of [940, 740]) {
    await page.setViewportSize({ width: 1080, height });
    // This checks geometry rather than paint order: changing only z-index
    // simply transfers the occlusion from one surface to the other.
    await expect
      .poll(async () => {
        const [panelBox, questionBox] = await Promise.all([
          panel.boundingBox(),
          question.boundingBox(),
        ]);
        return panelBox && questionBox
          ? panelBox.y + panelBox.height - questionBox.y
          : Infinity;
      })
      .toBeLessThanOrEqual(1);
    expect((await panel.boundingBox())!.height).toBeLessThan(
      restingPanel.height,
    );

    await expect
      .poll(() =>
        panel.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      )
      .toBeGreaterThan(0);
    await lastArtifact.click({ trial: true });
    await expect(lastArtifact).toBeInViewport();
    await option.click({ trial: true });
  }

  // Expand/collapse changes the card height without changing the viewport.
  // Keyboard activation keeps the floating panel open.
  const expandedPanelHeight = (await panel.boundingBox())!.height;
  await question.getByRole('button', { name: 'Collapse' }).press('Space');
  await expect
    .poll(async () => (await panel.boundingBox())!.height)
    .toBeGreaterThan(expandedPanelHeight);
  await question.getByRole('button', { name: 'Expand' }).press('Space');
  await expect
    .poll(async () =>
      Math.abs((await panel.boundingBox())!.height - expandedPanelHeight),
    )
    .toBeLessThanOrEqual(1);

  // Selecting an answer intentionally dismisses the floating panel, since
  // clicking outside it has always dismissed it; the request remains active.
  await option.click();
  await toggle.click();
  await expect(panel).toBeVisible();
  await submit.click({ trial: true });
  await submit.press('Space');
  await expect.poll(() => daemon.permissionRequests()).toHaveLength(1);
  expect(daemon.permissionRequests()[0].body).toMatchObject({
    answers: { '0': 'All' },
  });
  await daemon.sendEvent({
    id: 5,
    v: 1,
    type: 'permission_resolved',
    data: {
      requestId: 'environment-question',
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    },
  });
  await expect(question).toHaveCount(0);

  await page.setViewportSize({ width: 1080, height: 940 });
  await expect(panel).toBeVisible();
  await expect
    .poll(async () =>
      Math.abs((await panel.boundingBox())!.height - restingPanel.height),
    )
    .toBeLessThanOrEqual(1);
});
