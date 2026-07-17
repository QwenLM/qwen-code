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

    test(`extensions manager`, async ({ page }, testInfo) => {
      // Seed a few extensions so the full-page manager renders real cards —
      // enabled + disabled, marketplace + local, with varied capability counts
      // — instead of its empty state. `capabilities` is required on every entry.
      const scenario = createWebShellDaemonScenario({
        extensions: {
          extensions: [
            {
              kind: 'extension',
              id: 'context7',
              name: 'context7',
              displayName: 'Context7',
              description:
                'Up-to-date library docs injected into your prompts.',
              version: '1.4.0',
              isActive: true,
              path: '/ext/context7',
              source: 'marketplace',
              capabilities: {
                mcpServerCount: 1,
                skillCount: 0,
                agentCount: 0,
                hookCount: 0,
                commandCount: 0,
                contextFileCount: 0,
                channelCount: 0,
                hasSettings: true,
              },
            },
            {
              kind: 'extension',
              id: 'playwright',
              name: 'playwright',
              displayName: 'Playwright',
              description: 'Drive a real browser for end-to-end checks.',
              version: '0.9.2',
              isActive: true,
              path: '/ext/playwright',
              source: 'marketplace',
              capabilities: {
                mcpServerCount: 1,
                skillCount: 1,
                agentCount: 0,
                hookCount: 0,
                commandCount: 2,
                contextFileCount: 0,
                channelCount: 0,
                hasSettings: false,
              },
            },
            {
              kind: 'extension',
              id: 'local-notes',
              name: 'local-notes',
              displayName: 'Local Notes',
              description: 'A scratchpad extension loaded from disk.',
              version: '0.1.0',
              isActive: false,
              path: '/ext/local-notes',
              source: 'local',
              capabilities: {
                mcpServerCount: 0,
                skillCount: 0,
                agentCount: 0,
                hookCount: 0,
                commandCount: 1,
                contextFileCount: 1,
                channelCount: 0,
                hasSettings: false,
              },
            },
          ],
        },
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);
      // Open the full-page Extensions manager via the `/extensions` command.
      // Gate on the page heading — a stable structural role, unlike card text a
      // refactor could reshape or that could also match a toast/sidebar — to
      // prove the manager PAGE (not a transcript/dialog) is reachable, then
      // confirm seeded cards rendered via their button role — both an enabled
      // marketplace one and the disabled, local-source one, so a regression
      // that hides `isActive: false` or local rows fails an assertion rather
      // than only differing in the (visually reviewed) screenshot.
      await submitLocalCommand(page, '/extensions');
      await expect(
        page.getByRole('heading', { name: 'Manage Extensions' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Context7' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Local Notes' }),
      ).toBeVisible();
      await captureScreenshot(page, `extensions-manager-${theme}`);
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
              '  A[Tool call] --> B{Trusted?}\n' +
              '  B -->|Yes| C[Run]\n' +
              '  B -->|No| D{Approve?}\n' +
              '  D -->|Yes| C\n' +
              '  D -->|No| E[Cancel]\n' +
              '  C --> F[Result]\n' +
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
          // Pane-neutral copy: the mock replays these same events into *both*
          // panes, so wording that names "the first pane" would read wrong in
          // the second one.
          assistantTextEvent('Here are the two sessions, side by side.', {
            id: 2,
          }),
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

      // Restore the tiled layout (#6951): the solo pane returns to the split and
      // the hidden pane reappears — so the maximize control is back on both
      // panes. Assert the restore path (behavioral coverage) but do NOT capture
      // a screenshot: the restored layout is visually identical to the tiled
      // `split view` shot above, and the reappearing pane re-renders its content
      // just after this click, so the capture is byte-nondeterministic between
      // identical runs — a flaky, redundant view that surfaces false-positive
      // "changed" previews unrelated to the PR under review.
      await page.getByRole('button', { name: 'Restore pane' }).click();
      await expect(
        page.getByRole('button', { name: 'Maximize pane' }).first(),
      ).toBeVisible();
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
      // Assert all four sessions render (not just the two waiting ones), so a
      // regression that truncates the running or idle session is caught. The
      // running session is also the loaded one, so its name shows in the main
      // view too — scope to the sidebar landmark to keep the match unambiguous.
      const sidebar = page.getByRole('complementary');
      await expect(sidebar.getByText('Run test suite')).toBeVisible();
      await expect(sidebar.getByText('Draft release notes')).toBeVisible();
      await captureScreenshot(page, `sidebar-attention-${theme}`);
    });

    test(`workspace sidebar`, async ({ page }, testInfo) => {
      // Two workspaces make the sidebar group sessions per workspace and tag the
      // primary one — the surface the "primary workspace" label/badge lives on.
      // Every other scenario here is single-workspace, where that tag never
      // renders (it is gated on more than one displayed workspace), so this is
      // the only scenario that can surface a change to the workspace labels.
      //
      // Pin the primary workspace cwd and its loaded session name explicitly,
      // rather than leaning on createWebShellDaemonScenario's defaults: the
      // basename ("qwen-web-shell-e2e") and the settle-wait below both depend on
      // them, so a rename of those defaults in mockDaemon.ts would otherwise
      // turn this into a cryptic "not visible" failure.
      const primaryCwd = '/tmp/qwen-web-shell-e2e';
      const primarySessionName = 'Run auth migration';
      const scenario = createWebShellDaemonScenario({
        workspaceCwd: primaryCwd,
        displayName: primarySessionName,
        capabilities: {
          workspaces: [
            {
              id: 'ws-primary',
              cwd: primaryCwd,
              primary: true,
              trusted: true,
            },
            {
              id: 'ws-api',
              cwd: '/tmp/qwen-api-service',
              primary: false,
              trusted: true,
            },
          ],
        },
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);
      // Each workspace renders a section headed by its basename.
      const sidebar = page.getByRole('complementary');
      await expect(
        sidebar.getByText('qwen-web-shell-e2e', { exact: true }),
      ).toBeVisible();
      await expect(
        sidebar.getByText('qwen-api-service', { exact: true }),
      ).toBeVisible();
      // The primary workspace auto-expands and streams its session rows in via a
      // per-workspace fetch. Wait for the loaded session's row before capturing
      // so the async load has settled — otherwise the row list races the
      // screenshot and the capture differs between runs.
      await expect(sidebar.getByText(primarySessionName)).toBeVisible();
      await captureScreenshot(page, `workspace-sidebar-${theme}`);
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
