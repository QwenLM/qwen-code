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
  gotoNewSession,
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

    test(`Channel manager`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        capabilities: {
          features: [
            'session_events',
            'permission_vote',
            'session_permission_vote',
            'session_scope_override',
            'session_source_metadata',
            'workspace_settings',
            'workspace_voice',
            'channel_management',
          ],
        },
        channelTypes: [
          {
            type: 'dingtalk',
            displayName: 'DingTalk',
            manageable: true,
            fields: [
              {
                key: 'clientId',
                label: 'Client ID',
                kind: 'string',
                required: true,
                envResolvable: true,
              },
              {
                key: 'clientSecret',
                label: 'Client Secret',
                kind: 'secret',
                required: true,
                envResolvable: true,
              },
            ],
          },
          {
            type: 'wecom',
            displayName: 'WeCom',
            manageable: true,
            fields: [
              {
                key: 'botId',
                label: 'Bot ID',
                kind: 'string',
                required: true,
              },
              {
                key: 'secret',
                label: 'Bot Secret',
                kind: 'secret',
                required: true,
              },
              {
                key: 'wsUrl',
                label: 'WebSocket URL',
                kind: 'string',
                required: false,
                envResolvable: true,
              },
            ],
          },
          {
            type: 'feishu',
            displayName: 'Feishu',
            manageable: true,
            fields: [
              {
                key: 'clientId',
                label: 'App ID',
                kind: 'string',
                required: true,
              },
              {
                key: 'clientSecret',
                label: 'App Secret',
                kind: 'secret',
                required: true,
              },
            ],
          },
          {
            type: 'telegram',
            displayName: 'Telegram',
            manageable: true,
            fields: [],
          },
        ],
        channels: {
          revision: '1',
          instances: {
            dingtalk: {
              name: 'dingtalk',
              config: {
                type: 'dingtalk',
                clientId: 'ding-visual-app',
                senderPolicy: 'pairing',
              },
              secrets: {
                clientSecret: { present: true, source: 'literal' },
              },
              startsWithServe: true,
              runtime: { state: 'connected' },
            },
            feishu: {
              name: 'release-notifier',
              config: { type: 'feishu' },
              secrets: {
                clientSecret: { present: true, source: 'environment' },
              },
              startsWithServe: false,
              runtime: {
                state: 'error',
                lastError: 'The app credentials were rejected.',
              },
            },
            hidden: {
              name: 'hidden-telegram',
              config: { type: 'telegram' },
              secrets: {},
              startsWithServe: false,
              runtime: { state: 'stopped' },
            },
          },
        },
        pairingRequests: {
          dingtalk: [
            {
              senderId: 'user-42',
              senderName: 'Ada',
              code: 'ABCD1234',
              createdAt: Date.parse('2026-07-28T00:00:00.000Z'),
            },
            {
              senderId: 'user-91',
              senderName: 'Lin',
              code: 'WXYZ5678',
              createdAt: Date.parse('2026-07-28T00:04:00.000Z'),
            },
          ],
        },
        pairingApprovals: {
          dingtalk: ['user-18', 'release-manager'],
        },
      });
      await page.addInitScript(() => {
        window.sessionStorage.setItem('qwen-daemon-token', 'visual-token');
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await page.getByRole('button', { name: 'Channels' }).click();
      await expect(
        page.getByRole('heading', { name: 'Channels', level: 1 }),
      ).toBeVisible();
      const configuredChannels = page.getByLabel('Configured channels');
      await expect(
        configuredChannels.getByText('dingtalk', { exact: true }),
      ).toBeVisible();
      await expect(
        configuredChannels.getByText('release-notifier', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('hidden-telegram')).toHaveCount(0);
      await captureScreenshot(page, `channel-manager-${theme}`);
      await page.getByRole('button', { name: 'Configure DingTalk' }).click();
      await expect(
        page.getByRole('heading', { name: 'Configure DingTalk' }),
      ).toBeVisible();
      await captureScreenshot(page, `channel-editor-${theme}`);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Edit dingtalk' }).click();
      const editHeading = page.getByRole('heading', {
        name: 'Edit DingTalk',
      });
      await expect(editHeading).toBeVisible();
      await expect(page.getByText('ABCD1234', { exact: true })).toBeVisible();
      await expect(page.getByText('user-18', { exact: true })).toBeVisible();
      await expect(
        page.getByText('release-manager', { exact: true }),
      ).toBeVisible();
      await editHeading.click();
      await page
        .getByRole('heading', { name: 'Pairing approvals' })
        .scrollIntoViewIfNeeded();
      await captureScreenshot(page, `channel-editor-existing-${theme}`);
    });

    test(`GitHub channel editor`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        capabilities: {
          features: [
            'session_events',
            'permission_vote',
            'session_permission_vote',
            'session_scope_override',
            'session_source_metadata',
            'workspace_settings',
            'workspace_voice',
            'channel_management',
          ],
        },
        channelTypes: [
          {
            type: 'github',
            displayName: 'GitHub',
            manageable: true,
            fields: [
              {
                key: 'token',
                label: 'Personal Access Token',
                kind: 'secret',
                envResolvable: true,
              },
              {
                key: 'useLocalGh',
                label: 'Use Local GitHub CLI Authentication',
                kind: 'boolean',
              },
              {
                key: 'baseUrl',
                label: 'Base URL',
                kind: 'string',
                envResolvable: true,
              },
              {
                key: 'groupPolicy',
                label: 'Group Policy',
                kind: 'enum',
                required: true,
                default: 'open',
                options: [
                  { value: 'open', label: 'Open' },
                  { value: 'allowlist', label: 'Allowlist' },
                  { value: 'disabled', label: 'Disabled' },
                ],
              },
              {
                key: 'senderPolicy',
                label: 'Sender Policy',
                kind: 'enum',
                required: true,
                options: [
                  { value: 'allowlist', label: 'Allowlist' },
                  { value: 'pairing', label: 'Pairing' },
                  { value: 'open', label: 'Open' },
                ],
              },
              {
                key: 'allowedUsers',
                label: 'Allowed Users',
                kind: 'string-list',
              },
            ],
          },
        ],
        channels: { revision: '1', instances: {} },
      });
      await page.addInitScript(() => {
        window.sessionStorage.setItem('qwen-daemon-token', 'visual-token');
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await page.getByRole('button', { name: 'Channels' }).click();
      await expect(
        page.getByRole('heading', { name: 'Channels', level: 1 }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Configure GitHub' }).click();
      await expect(
        page.getByRole('heading', { name: 'Configure GitHub' }),
      ).toBeVisible();
      await expect(
        page.getByRole('switch', {
          name: 'Use local GitHub CLI authentication',
        }),
      ).toBeVisible();
      await captureScreenshot(page, `github-channel-editor-${theme}`);
      await page.getByLabel('Instance name').fill('github-bot');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(
        page.getByText(
          'Enter a token or enable local GitHub CLI authentication.',
        ),
      ).toBeVisible();
      await captureScreenshot(
        page,
        `github-channel-editor-credential-${theme}`,
      );
      await page
        .getByRole('switch', {
          name: 'Use local GitHub CLI authentication',
        })
        .click();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(
        page.getByText(
          'Enter a token or enable local GitHub CLI authentication.',
        ),
      ).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: 'Configure GitHub' }),
      ).toHaveCount(0);
      await expect
        .poll(() =>
          daemon.requests.filter(
            (request) =>
              request.method === 'PUT' &&
              request.path.endsWith('/channels/github-bot'),
          ),
        )
        .toEqual([
          expect.objectContaining({
            body: expect.objectContaining({
              config: expect.objectContaining({
                type: 'github',
                useLocalGh: true,
              }),
            }),
          }),
        ]);
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
      // Two workspaces make the sidebar group sessions per workspace.
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

    test(`git mode selector`, async ({ page }, testInfo) => {
      // The new-session composer offers a git-mode selector (current branch /
      // new branch / worktree) only when the workspace the next session would
      // use is trusted AND a git repo, and App.tsx wires the intent props only
      // while no session is loaded. So this empty state is the suite's only
      // view of the popover — without a scenario the whole selector (and the
      // empty-state composer around it) is invisible to the before/after
      // preview.
      const workspaceCwd = '/tmp/qwen-web-shell-e2e';
      const scenario = createWebShellDaemonScenario({
        workspaceCwd,
        capabilities: {
          workspaces: [
            { id: 'primary', cwd: workspaceCwd, primary: true, trusted: true },
          ],
        },
        gitStatus: { v: 2, workspaceCwd, branch: 'main' },
      });
      await installScenario(page, scenario, resolveBaseURL(testInfo));
      await gotoNewSession(page, theme);

      // Closed: the composer chip advertising the current git mode.
      const chip = page.locator('[data-testid="git-mode-chip"]');
      await expect(chip).toBeVisible();
      await captureScreenshot(page, `git-mode-chip-${theme}`);

      // Open: the three-mode popover (current / new branch / worktree). Assert
      // an option is visible (not just the chip's aria-label) so a regression
      // that fails to open the popover fails here, not only in the visually
      // reviewed screenshot.
      await chip.click();
      await expect(
        page.getByText('Current branch', { exact: true }),
      ).toBeVisible();
      await captureScreenshot(page, `git-mode-popover-${theme}`);

      // #7668 keeps this sub-state open. Match the option by role — its label
      // spans a name + description span, so getByText is ambiguous.
      const popover = page.locator('[data-slot="popover-content"]');
      await popover.getByRole('radio', { name: /New branch/ }).click();
      const branchInput = page.locator('[data-testid="git-mode-branch-input"]');
      await expect(branchInput).toBeVisible();
      await branchInput.fill('feat/my-feature');
      // Regression guard for #7668: the input flashes visible on click, but the
      // pre-fix dismissal landed ~100ms later, so an immediate assertion still
      // passed. Settle past that window and re-assert, so a re-dismissal hard-fails
      // here — mirroring the functional web-shell.git-mode.spec.ts.
      await page.waitForTimeout(300);
      await expect(popover).toBeVisible();
      await expect(branchInput).toBeVisible();
      await expect(
        page.locator('[data-testid="git-mode-confirm-branch"]'),
      ).toBeEnabled();
      await captureScreenshot(page, `git-mode-branch-${theme}`);
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

    test(`code review artifact`, async ({ page }, testInfo) => {
      // The dedicated code-review renderer is gated three ways: the
      // `session_artifacts` capability, an artifact whose metadata marks it
      // `code_review`, and a readable workspace file behind it. Without a
      // scenario seeding all three, the whole detail view stays invisible to
      // the before/after preview.
      const reviewPath = '.qwen/reviews/pr-1234.json';
      const reviewDocument = {
        schemaVersion: 1,
        target: 'local',
        effort: 'high',
        verdict: {
          event: 'REQUEST_CHANGES',
          verdictLine: 'Verdict: Request changes (1 Critical, 1 Suggestion)',
          baseEvent: 'REQUEST_CHANGES',
          cappedBy: ['Critical finding f-critical is unresolved'],
          downgraded: false,
          downgradedFrom: null,
        },
        findings: [
          {
            id: 'f-critical',
            severity: 'Critical',
            confidence: 'high',
            source: 'review',
            summary:
              'Review verdict is reported even when the child process times out',
            shortSummary: 'timeout treated as success',
            failureScenario:
              'When `review run` times out, the CLI still prints a verdict as if the review completed.',
            suggestedFix:
              'Fail closed when timedOut is true instead of reporting the verdict.',
            category: 'correctness',
            locations: [
              { file: 'packages/cli/src/commands/review.ts', line: 412 },
            ],
            outcome: 'fixed',
            outcomeNote: 'Timeouts now surface as incomplete.',
          },
          {
            id: 'f-suggestion',
            severity: 'Suggestion',
            confidence: 'low',
            source: 'lint',
            summary:
              'Artifact evidence links should render their file name only',
            shortSummary: 'verbose evidence labels',
            failureScenario:
              'Long asset URLs overflow the finding card in narrow panels.',
            locations: [
              {
                file: 'packages/web-shell/client/components/artifacts/CodeReviewArtifactDetail.tsx',
                line: 540,
              },
            ],
            assets: [
              'https://assets.example.com/reviews/pr-1234/f-suggestion.png',
            ],
          },
        ],
        counts: {
          total: 2,
          bySeverity: { Critical: 1, Suggestion: 1, 'Nice to have': 0 },
          byConfidence: { high: 1, low: 1 },
          byOutcome: { fixed: 1, skipped: 0, no_change_needed: 0 },
          held: 0,
        },
        outcomesRecorded: true,
        markdownReportPath: '.qwen/reviews/pr-1234.md',
      };
      const reviewDocumentJson = JSON.stringify(reviewDocument);
      const scenario = createWebShellDaemonScenario({
        capabilities: {
          features: [
            'session_events',
            'permission_vote',
            'session_permission_vote',
            'session_scope_override',
            'session_source_metadata',
            'workspace_settings',
            'workspace_voice',
            'session_artifacts',
          ],
        },
        events: [
          userTextEvent('Review my changes and save the report.', { id: 1 }),
          {
            id: 2,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'call-record-review',
                toolName: 'record_artifact',
                title: 'record_artifact',
                kind: 'other',
                status: 'completed',
                rawInput: {
                  title: 'Code review result',
                  workspacePath: reviewPath,
                },
                rawOutput: { recorded: true },
              },
            },
          },
          assistantTextEvent('Review saved to the workspace.', { id: 3 }),
          turnCompleteEvent('prompt-review', { id: 4 }),
        ],
        artifacts: [
          {
            id: 'artifact-code-review',
            kind: 'other',
            storage: 'workspace',
            source: 'tool',
            status: 'available',
            title: 'Code review result',
            workspacePath: reviewPath,
            mimeType: 'application/json',
            sizeBytes: reviewDocumentJson.length,
            metadata: { artifactType: 'code_review', schemaVersion: 1 },
            retention: 'restorable',
            clientRetained: false,
            createdAt: '2026-07-03T00:00:00.000Z',
            updatedAt: '2026-07-03T00:00:00.000Z',
            toolCallId: 'call-record-review',
            toolName: 'record_artifact',
          },
        ],
        workspaceFiles: { [reviewPath]: reviewDocumentJson },
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      // Open the artifact card the turn outputs render for the recorded
      // artifact; the right panel then loads the workspace file and renders
      // the dedicated detail view instead of the generic file preview.
      await page
        .locator('[data-web-shell-message-list]')
        .getByRole('button', { name: 'Open', exact: true })
        .click();
      await expect(page.getByText('Authoritative verdict')).toBeVisible();
      await expect(
        page.getByText('Verdict: Request changes (1 Critical, 1 Suggestion)'),
      ).toBeVisible();
      await expect(
        page.getByText(
          'Review verdict is reported even when the child process times out',
        ),
      ).toBeVisible();
      await captureScreenshot(page, `code-review-artifact-${theme}`);
    });
  });
}
