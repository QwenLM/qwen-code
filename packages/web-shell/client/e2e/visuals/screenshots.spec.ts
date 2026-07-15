/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  permissionRequestEvent,
  turnCompleteEvent,
  userTextEvent,
} from '../utils/mockDaemon';
import {
  captureScreenshot,
  completeReplay,
  fillComposer,
  gotoSession,
  installScenario,
  resolveBaseURL,
  submitLocalCommand,
  VISUAL_VIEWPORT,
  type VisualTheme,
} from './harness';

const THEMES: readonly VisualTheme[] = ['dark', 'light'];

test.use({ viewport: { ...VISUAL_VIEWPORT } });

for (const theme of THEMES) {
  test.describe(`web-shell screenshots (${theme})`, () => {
    test(`session transcript`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        events: [
          userTextEvent('Render the web-shell so I can review the layout.', {
            id: 1,
          }),
          assistantTextEvent(
            'Here is a **streamed** reply with a code block:\n\n```ts\nexport const greeting = "hello from web-shell";\n```',
            { id: 2 },
          ),
          turnCompleteEvent('prompt-visual', { id: 3 }),
        ],
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await expect(page.locator('[data-web-shell-message-list]')).toContainText(
        'Here is a',
      );
      // Shiki swaps in `<pre class="shiki">` asynchronously; wait for it so the
      // code block is captured highlighted (not the plain fallback) every run.
      await expect(
        page.locator('[data-web-shell-message-list] pre.shiki').first(),
      ).toBeVisible();
      await captureScreenshot(page, `session-transcript-${theme}`);
    });

    test(`mermaid diagram`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        events: [
          userTextEvent('Diagram the tool-approval flow so I can review it.', {
            id: 1,
          }),
          assistantTextEvent(
            'Here is the tool-approval flow:\n\n' +
              '```mermaid\n' +
              'flowchart LR\n' +
              '  A[Tool call] --> B{Folder trusted?}\n' +
              '  B -->|Yes| C[Run immediately]\n' +
              '  B -->|No| D{Ask approval}\n' +
              '  D -->|Approve| C\n' +
              '  D -->|Reject| E[Cancel turn]\n' +
              '  C --> F[Return result]\n' +
              '```',
            { id: 2 },
          ),
          turnCompleteEvent('prompt-mermaid', { id: 3 }),
        ],
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      // MermaidBlock lazy-imports `mermaid` and renders asynchronously (behind a
      // ~150ms timer), swapping a "rendering…" placeholder for the injected
      // `<svg id="mermaid-N">`. Wait for that SVG so the diagram is captured
      // rendered — not the placeholder — on every run.
      await expect(
        page.locator('[data-web-shell-message-list] svg[id^="mermaid-"]'),
      ).toBeVisible();
      await captureScreenshot(page, `mermaid-diagram-${theme}`);
    });

    test(`split view`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        events: [
          userTextEvent('Review two sessions side by side.', { id: 1 }),
          assistantTextEvent('Here is the first pane of the split.', { id: 2 }),
          turnCompleteEvent('prompt-split', { id: 3 }),
        ],
      });
      // Derive the second pane's session from the scenario's OWN sessions list
      // rather than hardcoding an id: a rename/removal of the default entry
      // would otherwise surface here as a confusing SSE connection timeout
      // instead of a clear, self-explaining error.
      const secondSessionId = scenario.sessions.find(
        (s) => s.sessionId !== scenario.sessionId,
      )?.sessionId;
      if (!secondSessionId) {
        throw new Error(
          'split view scenario expects a second session in the list',
        );
      }
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      // Load the primary session (this also primes the theme), then enter the
      // split via the `?split=a,b` deep link so two panes render side by side.
      await gotoSession(page, scenario, daemon, theme);
      await page.goto(
        `/session/${encodeURIComponent(scenario.sessionId)}` +
          `?split=${encodeURIComponent(scenario.sessionId)},${encodeURIComponent(secondSessionId)}` +
          `&theme=${theme}`,
      );
      await expect(page.locator('[data-testid="split-view"]')).toBeVisible();
      // Both panes reconnect on the split navigation; settle each replay so
      // neither pane is stuck on the loading state.
      await completeReplay(
        page,
        daemon,
        scenario.sessionId,
        scenario.events.length,
      );
      await completeReplay(page, daemon, secondSessionId, 0);
      // The maximize control only appears with 2+ panes (#6951); waiting on it
      // confirms the split actually rendered both panes.
      await expect(
        page.getByRole('button', { name: 'Maximize pane' }).first(),
      ).toBeVisible();
      await captureScreenshot(page, `split-view-${theme}`);

      // Maximize the first pane (#6951): it fills the split and the other pane
      // hides; the button flips to "Restore pane".
      await page.getByRole('button', { name: 'Maximize pane' }).first().click();
      await expect(
        page.getByRole('button', { name: 'Restore pane' }),
      ).toBeVisible();
      await captureScreenshot(page, `split-view-maximized-${theme}`);
    });

    test(`sidebar attention`, async ({ page }, testInfo) => {
      const stamp = '2026-07-03T00:00:00.000Z';
      const base = {
        workspaceCwd: '/tmp/qwen-web-shell-e2e',
        createdAt: stamp,
        updatedAt: stamp,
        clientCount: 1,
      };
      const scenario = createWebShellDaemonScenario({
        sessionId: 'sess-running',
        displayName: 'Run test suite',
        sessions: [
          {
            ...base,
            sessionId: 'sess-approval',
            displayName: 'Deploy to staging',
            hasActivePrompt: true,
            isWaitingForPermission: true,
          },
          {
            ...base,
            sessionId: 'sess-question',
            displayName: 'Refactor auth module',
            hasActivePrompt: true,
            isWaitingForUserQuestion: true,
          },
          {
            ...base,
            sessionId: 'sess-running',
            displayName: 'Run test suite',
            hasActivePrompt: true,
          },
          {
            ...base,
            sessionId: 'sess-idle',
            displayName: 'Draft release notes',
            clientCount: 0,
            hasActivePrompt: false,
          },
        ],
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);
      // The sidebar lists every session; #6956 adds an attention pill to the
      // ones waiting on the user. Assert on session names (present on both
      // `main` and the PR) so the frame is the same shape either way — the pill
      // itself is the PR's diff that the before/after preview surfaces.
      await expect(page.getByText('Deploy to staging')).toBeVisible();
      await expect(page.getByText('Refactor auth module')).toBeVisible();
      await captureScreenshot(page, `sidebar-attention-${theme}`);
    });

    test(`slash menu`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario();
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await fillComposer(page, '/');
      await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();
      await captureScreenshot(page, `slash-menu-${theme}`);
    });

    test(`model dialog`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario();
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await submitLocalCommand(page, '/model');
      await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
      await captureScreenshot(page, `model-dialog-${theme}`);
    });

    test(`theme dialog`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario();
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await submitLocalCommand(page, '/theme');
      await expect(page.locator('[data-web-shell-theme-dialog]')).toBeVisible();
      await captureScreenshot(page, `theme-dialog-${theme}`);
    });

    test(`permission panel`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        events: [permissionRequestEvent('perm-visual', { id: 1 })],
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await expect(
        page.locator('[data-web-shell-permission-panel]'),
      ).toBeVisible();
      await captureScreenshot(page, `permission-panel-${theme}`);
    });
  });
}
