#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { WebSocket } from 'ws';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '../..');
const artifactRoot = join(
  repoRoot,
  '.qwen',
  'e2e-tests',
  'electron-desktop',
  'artifacts',
);

const consoleErrors = [];
const failedRequests = [];

let appProcess;
let cdp;
let artifactDir;
let workspaceDir;

async function main() {
  await assertBuiltDesktop();
  artifactDir = await createArtifactDir();
  workspaceDir = await createGitWorkspace();
  const homeDir = await mkdtemp(join(tmpdir(), 'qwen-desktop-e2e-home-'));
  const runtimeDir = await mkdtemp(join(tmpdir(), 'qwen-desktop-e2e-runtime-'));
  const userDataDir = await mkdtemp(
    join(tmpdir(), 'qwen-desktop-e2e-user-data-'),
  );
  const cdpPort = await getFreePort();

  appProcess = launchDesktopApp({
    cdpPort,
    homeDir,
    runtimeDir,
    userDataDir,
    workspaceDir,
  });

  const target = await waitForCdpTarget(cdpPort);
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  cdp.onEvent((event) => collectBrowserEvent(event));

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.bringToFront');
  await waitForText('Qwen Code');
  await waitForText('Connected');
  await assertWorkbenchLandmarks();
  await assertRalphWorkspaceLayout('initial-layout.json');
  await saveScreenshot('initial-workspace.png');

  await clickButtonUntilText('Open Project', 'desktop-e2e-workspace');
  await assertProjectComposerReady('project-composer.json');
  await setFieldByAriaLabel('Message', 'Please exercise command approval.');
  await clickButton('Send');
  await waitForText('Approve Once');
  await clickButton('Approve Once');
  await waitForText('E2E fake ACP response received');
  await assertConversationChangesSummary('conversation-changes-summary.json');
  await waitForSelector('[data-testid="thread-list"]');

  await clickButton('Review Changes');
  await waitForText('README.md');
  await assertReviewDrawerLayout('review-drawer-layout.json');
  await saveScreenshot('review-drawer.png');
  await waitForText('Stage Hunk');
  await assertReviewSafetyTerminology('review-safety-initial.json');
  await clickButton('Discard All');
  await waitForText('Discard all local changes?');
  await assertDiscardConfirmation('discard-confirmation.json');
  await clickButton('Cancel Discard');
  await waitFor(
    'discard confirmation canceled with changes intact',
    async () =>
      evaluate(`(() => {
        return (
          !document.querySelector('[data-testid="discard-confirmation"]') &&
          document.body.innerText.includes('1 modified · 0 staged · 1 untracked')
        );
      })()`),
    10_000,
  );
  await assertWorkspaceStillDirtyAfterDiscardCancel(
    'discard-cancel-git-status.txt',
  );
  await setFieldByAriaLabel(
    'Review comment for README.md',
    'Review note from E2E',
  );
  await clickButton('Add Comment');
  await waitForText('Review note from E2E');
  await clickButton('Stage All');
  await waitForText('0 modified · 2 staged · 0 untracked');
  await waitForText('ADDED · 1 HUNK');
  await setFieldByAriaLabel('Commit message', 'desktop e2e commit');
  await clickButton('Commit');
  await waitForText('No changes');
  await assertWorkspaceCommit('desktop e2e commit');
  await waitForSelector('[data-testid="project-list"]');

  await clickButton('Conversation');
  await waitForSelector('[data-testid="thread-list"]');

  await clickButton('Settings');
  await waitForSelector('[data-testid="settings-page"]');
  await assertSettingsPageLayout('settings-layout.json');
  await saveScreenshot('settings-page.png');
  await setFieldByLabel('Model', 'qwen-e2e-cdp');
  await setFieldByLabel('Base URL', 'https://example.invalid/v1');
  await setFieldByLabel('API key', 'sk-desktop-e2e');
  await clickButton('Save');
  await waitForText('qwen-e2e-cdp');
  await assertSettingsProductState('settings-product-state.json');
  await clickButton('Advanced Diagnostics');
  await waitForSelector('[data-testid="runtime-diagnostics"]');
  await assertSettingsAdvancedDiagnostics('settings-advanced-diagnostics.json');

  await clickButton('Conversation');
  await waitForSelector('[data-testid="terminal-drawer"]');
  await clickButton('Expand Terminal');
  await waitForSelector('[data-testid="terminal-body"]');
  await assertTerminalExpandedLayout('terminal-expanded-layout.json');
  await saveScreenshot('terminal-expanded.png');
  await setFieldByAriaLabel('Terminal command', 'printf desktop-e2e-terminal');
  await clickButton('Run');
  await waitForText('desktop-e2e-terminal');
  await waitForText('[exited] exit 0');
  await clickButton('Copy Output');
  await waitForText('Copied terminal output.');

  await setFieldByAriaLabel(
    'Terminal command',
    "node -e \"process.stdin.once('data', d => process.stdout.write('stdin:' + d.toString(), () => process.exit(0)))\"",
  );
  await clickButton('Run');
  await waitForText('[running]');
  await setFieldByAriaLabel('Terminal input', 'desktop-e2e-stdin');
  await clickButton('Send Input');
  await waitForText('Input sent.');
  await waitForText('stdin:desktop-e2e-stdin');
  await clickButton('Attach Output');
  await waitForText('Attached terminal output to composer.');
  await assertTerminalOutputAttached('terminal-attachment.json');
  await clickButton('Send');
  await waitForText('Approve Once');
  await clickButton('Approve Once');
  await waitForText(
    'E2E fake ACP response received: Review this terminal output',
  );
  await clickButton('Collapse Terminal');
  await waitFor(
    'collapsed terminal strip',
    async () =>
      evaluate(`(() => {
        const toggle = document.querySelector('[data-testid="terminal-toggle"]');
        const terminal = document.querySelector('[data-testid="terminal-drawer"]');
        return Boolean(
          toggle &&
          terminal &&
          toggle.getAttribute('aria-expanded') === 'false' &&
          !document.querySelector('[data-testid="terminal-body"]')
        );
      })()`),
    10_000,
  );

  await saveScreenshot('completed-workspace.png');
  await assertRalphWorkspaceLayout('completed-layout.json');
  await assertNoBrowserErrors();
  await writeFile(
    join(artifactDir, 'summary.json'),
    `${JSON.stringify(
      {
        ok: true,
        workspaceDir,
        consoleErrors,
        failedRequests,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`Desktop CDP smoke passed. Artifacts: ${artifactDir}`);
}

async function assertBuiltDesktop() {
  try {
    await Promise.all([
      readFile(join(packageDir, 'dist', 'main', 'main.js')),
      readFile(join(packageDir, 'dist', 'preload', 'index.cjs')),
      readFile(join(packageDir, 'dist', 'renderer', 'index.html')),
    ]);
  } catch {
    throw new Error(
      'Desktop build output is missing. Run npm run build --workspace=packages/desktop before e2e:cdp.',
    );
  }
}

async function createArtifactDir() {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dir = join(artifactRoot, stamp);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createGitWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-e2e-workspace-'));
  await writeFile(join(dir, 'README.md'), '# Desktop E2E\n\ninitial\n', 'utf8');
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'desktop-e2e-workspace' }, null, 2)}\n`,
    'utf8',
  );
  await execFileP('git', ['init'], { cwd: dir });
  await execFileP('git', ['config', 'user.email', 'desktop-e2e@example.test'], {
    cwd: dir,
  });
  await execFileP('git', ['config', 'user.name', 'Desktop E2E'], { cwd: dir });
  await execFileP('git', ['add', '.'], { cwd: dir });
  await execFileP('git', ['commit', '-m', 'initial commit'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# Desktop E2E\n\nchanged\n', 'utf8');
  await writeFile(join(dir, 'notes.txt'), 'review me\n', 'utf8');
  return dir;
}

async function assertWorkspaceCommit(expectedMessage) {
  const { stdout: latestSubject } = await execFileP('git', [
    '-C',
    workspaceDir,
    'log',
    '--format=%s',
    '-1',
  ]);
  if (latestSubject.trim() !== expectedMessage) {
    throw new Error(
      `Unexpected latest commit subject: ${latestSubject.trim()}`,
    );
  }

  const { stdout: status } = await execFileP('git', [
    '-C',
    workspaceDir,
    'status',
    '--porcelain=v1',
  ]);
  if (status.trim() !== '') {
    throw new Error(`Workspace is not clean after commit:\n${status}`);
  }
}

async function assertWorkspaceStillDirtyAfterDiscardCancel(fileName) {
  const [{ stdout: status }, { stdout: stagedFiles }] = await Promise.all([
    execFileP('git', ['-C', workspaceDir, 'status', '--porcelain=v1']),
    execFileP('git', ['-C', workspaceDir, 'diff', '--cached', '--name-only']),
  ]);

  await writeFile(
    join(artifactDir, fileName),
    `status:\n${status}\nstaged:\n${stagedFiles}\n`,
    'utf8',
  );

  if (!status.includes(' M README.md') || !status.includes('?? notes.txt')) {
    throw new Error(
      `Canceling discard should leave tracked and untracked changes intact:\n${status}`,
    );
  }

  if (stagedFiles.trim() !== '') {
    throw new Error(
      `Canceling discard should not stage changes:\n${stagedFiles}`,
    );
  }
}

function launchDesktopApp({
  cdpPort,
  homeDir,
  runtimeDir,
  userDataDir,
  workspaceDir,
}) {
  const logStream = createWriteStream(join(artifactDir, 'electron.log'));
  const child = spawn(electronPath, ['.'], {
    cwd: packageDir,
    env: {
      ...process.env,
      HOME: homeDir,
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_DESKTOP_CDP_PORT: String(cdpPort),
      QWEN_DESKTOP_E2E: '1',
      QWEN_DESKTOP_E2E_FAKE_ACP: '1',
      QWEN_DESKTOP_E2E_USER_DATA_DIR: userDataDir,
      QWEN_DESKTOP_TEST_SELECT_DIRECTORY: workspaceDir,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.on('exit', (code, signal) => {
    logStream.write(`\n[desktop exited] code=${code} signal=${signal}\n`);
    logStream.end();
  });

  return child;
}

async function waitForCdpTarget(port) {
  const deadline = Date.now() + 20_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find(
        (entry) =>
          entry.type === 'page' &&
          typeof entry.webSocketDebuggerUrl === 'string' &&
          (entry.title === 'Qwen Code' ||
            entry.url.includes('/dist/renderer/index.html')),
      );
      if (target) {
        return target;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for Electron CDP target on port ${port}: ${
      lastError instanceof Error ? lastError.message : 'no response'
    }`,
  );
}

async function assertWorkbenchLandmarks() {
  const landmarks = await evaluate(`(() => {
    return [
      'desktop-workspace',
      'project-sidebar',
      'workspace-topbar',
      'workspace-grid',
      'chat-thread',
      'terminal-drawer'
    ].filter((id) => !document.querySelector('[data-testid="' + id + '"]'));
  })()`);

  if (landmarks.length > 0) {
    throw new Error(`Missing workbench landmarks: ${landmarks.join(', ')}`);
  }
}

async function assertProjectComposerReady(fileName) {
  await waitFor(
    'project-scoped composer',
    async () =>
      evaluate(`(() => {
        const textarea = document.querySelector('textarea[aria-label="Message"]');
        return Boolean(
          textarea &&
          !textarea.disabled &&
          textarea.placeholder.includes('desktop-e2e-workspace') &&
          document.body.innerText.includes('Start a task in desktop-e2e-workspace') &&
          document.body.innerText.includes('New thread')
        );
      })()`),
    15_000,
  );

  const snapshot = await evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    const permission = document.querySelector('select[aria-label="Permission mode"]');
    const model = document.querySelector('select[aria-label="Model"]');
    return {
      composerText: document.querySelector('[data-testid="message-composer"]')?.textContent.trim() ?? '',
      placeholder: textarea?.placeholder ?? null,
      textareaDisabled: textarea?.disabled ?? null,
      permissionDisabled: permission?.disabled ?? null,
      modelDisabled: model?.disabled ?? null,
      bodyHasStartTask: document.body.innerText.includes('Start a task in desktop-e2e-workspace'),
      bodyHasNewThread: document.body.innerText.includes('New thread')
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.textareaDisabled !== false) {
    throw new Error(
      'Project composer should be enabled before a thread exists.',
    );
  }

  if (snapshot.permissionDisabled !== true || snapshot.modelDisabled !== true) {
    throw new Error(
      'Project composer runtime selectors should stay disabled before a session exists.',
    );
  }
}

async function assertRalphWorkspaceLayout(fileName) {
  const metrics = await evaluate(`(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    };

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      shell: rectFor('[data-testid="desktop-workspace"]'),
      sidebar: rectFor('[data-testid="project-sidebar"]'),
      topbar: rectFor('[data-testid="workspace-topbar"]'),
      grid: rectFor('[data-testid="workspace-grid"]'),
      chat: rectFor('[data-testid="chat-thread"]'),
      review: rectFor('[data-testid="review-panel"]'),
      settings: rectFor('[data-testid="settings-page"]'),
      composer: rectFor('[data-testid="message-composer"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      terminalBody: rectFor('[data-testid="terminal-body"]'),
      terminalToggle: rectFor('[data-testid="terminal-toggle"]'),
      terminalExpanded:
        document
          .querySelector('[data-testid="terminal-toggle"]')
          ?.getAttribute('aria-expanded') ?? null,
      listRows: [...document.querySelectorAll('.project-row, .session-row')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent.trim(),
            width: rect.width,
            height: rect.height
          };
        })
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  const requiredRects = [
    'shell',
    'sidebar',
    'topbar',
    'grid',
    'chat',
    'composer',
    'terminal',
  ];
  const missing = requiredRects.filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing layout rects: ${missing.join(', ')}`);
  }

  const { viewport, document: doc } = metrics;
  if (doc.bodyScrollHeight > viewport.height + 4) {
    throw new Error(
      `Desktop document should fit one viewport; body scrollHeight=${doc.bodyScrollHeight}, viewport=${viewport.height}`,
    );
  }

  if (metrics.sidebar.width < 236 || metrics.sidebar.width > 320) {
    throw new Error(`Unexpected sidebar width: ${metrics.sidebar.width}`);
  }

  if (metrics.topbar.height < 50 || metrics.topbar.height > 70) {
    throw new Error(`Unexpected topbar height: ${metrics.topbar.height}`);
  }

  if (metrics.review !== null || metrics.settings !== null) {
    throw new Error('Initial layout should not render secondary pages.');
  }

  if (metrics.terminalBody !== null || metrics.terminalExpanded !== 'false') {
    throw new Error('Initial layout should render a collapsed terminal strip.');
  }

  if (metrics.terminal.height < 44 || metrics.terminal.height > 82) {
    throw new Error(
      `Unexpected collapsed terminal height: ${metrics.terminal.height}`,
    );
  }

  if (metrics.chat.height < metrics.terminal.height * 6) {
    throw new Error(
      `Conversation should dominate the collapsed terminal; chat=${metrics.chat.height}, terminal=${metrics.terminal.height}`,
    );
  }

  if (metrics.chat.width < metrics.grid.width - 2) {
    throw new Error(
      `Conversation canvas should span the workbench; chat=${metrics.chat.width}, grid=${metrics.grid.width}`,
    );
  }

  if (Math.abs(metrics.grid.bottom - metrics.terminal.top) > 1) {
    throw new Error('Terminal drawer is not docked below the workspace grid.');
  }

  if (metrics.terminal.bottom > viewport.height + 1) {
    throw new Error('Terminal drawer overflows below the viewport.');
  }

  if (metrics.composer.bottom > metrics.chat.bottom + 1) {
    throw new Error('Composer is not contained inside the conversation panel.');
  }

  const oversizedRows = metrics.listRows.filter((row) => row.height > 92);
  if (oversizedRows.length > 0) {
    throw new Error(
      `Sidebar list rows should not stretch vertically: ${JSON.stringify(
        oversizedRows,
      )}`,
    );
  }
}

async function assertConversationChangesSummary(fileName) {
  await waitForSelector('[data-testid="conversation-changes-summary"]');
  const snapshot = await evaluate(`(() => {
    const bodyText = document.body.innerText;
    const summary = document.querySelector(
      '[data-testid="conversation-changes-summary"]'
    );
    return {
      bodyHasSessionId: bodyText.includes('session-e2e-1'),
      bodyHasConnectedEvent: bodyText.includes('Connected to session-e2e'),
      bodyHasTurnComplete: bodyText.includes('Turn complete'),
      summaryText: summary?.innerText ?? '',
      summaryRect: (() => {
        if (!summary) {
          return null;
        }
        const rect = summary.getBoundingClientRect();
        return {
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
          width: rect.width,
          height: rect.height
        };
      })(),
      hasReviewAction: Boolean(
        [...(summary?.querySelectorAll('button') ?? [])].some((button) => {
          const label =
            button.getAttribute('aria-label') ||
            button.getAttribute('title') ||
            button.textContent.trim();
          return label === 'Review Changes';
        })
      ),
      reviewOpen: Boolean(document.querySelector('[data-testid="review-panel"]'))
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.bodyHasSessionId || snapshot.bodyHasConnectedEvent) {
    throw new Error(
      `Conversation leaked a protocol session id: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.bodyHasTurnComplete) {
    throw new Error(
      `Conversation leaked a protocol stop reason: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  for (const expectedText of [
    '2 files changed',
    'README.md',
    'notes.txt',
    '+2',
    '-1',
  ]) {
    if (!snapshot.summaryText.includes(expectedText)) {
      throw new Error(
        `Changed-files summary is missing ${expectedText}: ${snapshot.summaryText}`,
      );
    }
  }

  if (!snapshot.hasReviewAction) {
    throw new Error('Changed-files summary is missing its review action.');
  }

  if (snapshot.reviewOpen) {
    throw new Error('Changed-files summary should not open review by default.');
  }

  if (
    !snapshot.summaryRect ||
    snapshot.summaryRect.width < 360 ||
    snapshot.summaryRect.height > 220
  ) {
    throw new Error(
      `Changed-files summary geometry is unexpected: ${JSON.stringify(
        snapshot.summaryRect,
      )}`,
    );
  }
}

async function assertReviewDrawerLayout(fileName) {
  const metrics = await evaluate(`(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    };

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      grid: rectFor('[data-testid="workspace-grid"]'),
      chat: rectFor('[data-testid="chat-thread"]'),
      review: rectFor('[data-testid="review-panel"]'),
      settings: rectFor('[data-testid="settings-page"]'),
      composer: rectFor('[data-testid="message-composer"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      terminalBody: rectFor('[data-testid="terminal-body"]'),
      terminalExpanded:
        document
          .querySelector('[data-testid="terminal-toggle"]')
          ?.getAttribute('aria-expanded') ?? null,
      topbarActions: Array.from(
        document.querySelectorAll(
          '[data-testid="workspace-topbar"] .topbar-icon-button'
        )
      ).map((button) => ({
        label: button.getAttribute('aria-label') || '',
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height
      })),
      hasSegmentedTabs: document.querySelector('.topbar-nav') !== null
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  const missing = ['grid', 'chat', 'review', 'composer', 'terminal'].filter(
    (key) => metrics[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing review drawer layout rects: ${missing.join(', ')}`,
    );
  }

  if (metrics.settings !== null) {
    throw new Error('Review drawer should not render the settings page.');
  }

  if (metrics.hasSegmentedTabs) {
    throw new Error('Topbar should use compact actions, not segmented tabs.');
  }

  const labels = metrics.topbarActions.map((action) => action.label);
  for (const expectedLabel of [
    'Conversation',
    'Close Changes',
    'Refresh Git',
    'Settings',
  ]) {
    if (!labels.includes(expectedLabel)) {
      throw new Error(
        `Missing compact topbar action ${expectedLabel}; labels=${labels.join(
          ', ',
        )}`,
      );
    }
  }

  const oversizedActions = metrics.topbarActions.filter(
    (action) => action.width > 40 || action.height > 40,
  );
  if (oversizedActions.length > 0) {
    throw new Error(
      `Topbar actions should stay compact: ${JSON.stringify(oversizedActions)}`,
    );
  }

  if (metrics.review.width < 300 || metrics.review.width > 430) {
    throw new Error(`Unexpected review drawer width: ${metrics.review.width}`);
  }

  if (metrics.terminalBody !== null || metrics.terminalExpanded !== 'false') {
    throw new Error(
      'Review drawer should keep Terminal collapsed unless explicitly opened.',
    );
  }

  if (metrics.terminal.height < 44 || metrics.terminal.height > 82) {
    throw new Error(
      `Review layout has unexpected terminal strip height: ${metrics.terminal.height}`,
    );
  }

  if (metrics.chat.width <= metrics.review.width) {
    throw new Error(
      `Conversation should remain wider than review: chat=${metrics.chat.width}, review=${metrics.review.width}`,
    );
  }

  if (Math.abs(metrics.chat.top - metrics.review.top) > 1) {
    throw new Error('Review drawer should align with the conversation top.');
  }

  if (Math.abs(metrics.chat.bottom - metrics.review.bottom) > 1) {
    throw new Error('Review drawer should share the conversation height.');
  }

  if (metrics.composer.right > metrics.chat.right + 1) {
    throw new Error(
      'Composer should stay contained inside chat with review open.',
    );
  }

  if (metrics.document.bodyScrollHeight > metrics.viewport.height + 4) {
    throw new Error(
      `Review drawer document should fit one viewport; body scrollHeight=${metrics.document.bodyScrollHeight}, viewport=${metrics.viewport.height}`,
    );
  }
}

async function assertReviewSafetyTerminology(fileName) {
  const snapshot = await evaluate(`(() => {
    const review = document.querySelector('[data-testid="review-panel"]');
    const text = review?.innerText ?? '';
    const buttons = [...(review?.querySelectorAll('button') ?? [])].map(
      (button) =>
        button.getAttribute('aria-label') ||
        button.getAttribute('title') ||
        button.textContent.trim()
    );

    return {
      text,
      buttons,
      hasAcceptLabel: /\\bAccept\\b/u.test(text),
      hasRevertLabel: /\\bRevert\\b/u.test(text),
      hasDiscardConfirmation:
        document.querySelector('[data-testid="discard-confirmation"]') !== null
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.hasAcceptLabel || snapshot.hasRevertLabel) {
    throw new Error(
      `Review drawer should use Stage/Discard language: ${snapshot.text}`,
    );
  }

  for (const expectedLabel of [
    'Discard All',
    'Stage All',
    'Discard File',
    'Stage File',
    'Discard Hunk',
    'Stage Hunk',
  ]) {
    if (!snapshot.buttons.includes(expectedLabel)) {
      throw new Error(
        `Missing review action ${expectedLabel}; buttons=${snapshot.buttons.join(
          ', ',
        )}`,
      );
    }
  }

  if (snapshot.hasDiscardConfirmation) {
    throw new Error('Discard confirmation should not be open by default.');
  }
}

async function assertDiscardConfirmation(fileName) {
  const snapshot = await evaluate(`(() => {
    const confirmation = document.querySelector(
      '[data-testid="discard-confirmation"]'
    );
    const review = document.querySelector('[data-testid="review-panel"]');
    return {
      text: confirmation?.innerText ?? '',
      buttons: [...(confirmation?.querySelectorAll('button') ?? [])].map(
        (button) =>
          button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          button.textContent.trim()
      ),
      reviewText: review?.innerText ?? ''
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (!snapshot.text.includes('Discard all local changes?')) {
    throw new Error(
      `Discard confirmation did not name the destructive action: ${snapshot.text}`,
    );
  }

  if (!snapshot.text.includes('removes unstaged edits and untracked files')) {
    throw new Error(
      `Discard confirmation should explain the local-change risk: ${snapshot.text}`,
    );
  }

  for (const expectedLabel of ['Cancel Discard', 'Confirm Discard']) {
    if (!snapshot.buttons.includes(expectedLabel)) {
      throw new Error(
        `Missing discard confirmation action ${expectedLabel}; buttons=${snapshot.buttons.join(
          ', ',
        )}`,
      );
    }
  }

  if (
    !/MODIFIED\s+1\s+STAGED\s+0\s+UNTRACKED\s+1/u.test(
      snapshot.reviewText,
    )
  ) {
    throw new Error(
      'Discard confirmation opened after the review counts already changed.',
    );
  }
}

async function assertTerminalExpandedLayout(fileName) {
  const metrics = await evaluate(`(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    };

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      grid: rectFor('[data-testid="workspace-grid"]'),
      chat: rectFor('[data-testid="chat-thread"]'),
      composer: rectFor('[data-testid="message-composer"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      terminalBody: rectFor('[data-testid="terminal-body"]'),
      terminalExpanded:
        document
          .querySelector('[data-testid="terminal-toggle"]')
          ?.getAttribute('aria-expanded') ?? null
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  const missing = [
    'grid',
    'chat',
    'composer',
    'terminal',
    'terminalBody',
  ].filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing expanded terminal rects: ${missing.join(', ')}`);
  }

  if (metrics.terminalExpanded !== 'true') {
    throw new Error('Terminal should be expanded after clicking the strip.');
  }

  if (metrics.terminal.height < 210 || metrics.terminal.height > 300) {
    throw new Error(
      `Unexpected expanded terminal height: ${metrics.terminal.height}`,
    );
  }

  if (metrics.chat.height <= metrics.terminal.height) {
    throw new Error(
      `Expanded terminal should remain supporting: chat=${metrics.chat.height}, terminal=${metrics.terminal.height}`,
    );
  }

  if (Math.abs(metrics.grid.bottom - metrics.terminal.top) > 1) {
    throw new Error(
      'Expanded terminal is not docked below the workspace grid.',
    );
  }

  if (metrics.document.bodyScrollHeight > metrics.viewport.height + 4) {
    throw new Error(
      `Expanded terminal document should fit one viewport; body scrollHeight=${metrics.document.bodyScrollHeight}, viewport=${metrics.viewport.height}`,
    );
  }
}

async function assertTerminalOutputAttached(fileName) {
  const snapshot = await evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    const terminalActions = document.querySelector('.terminal-actions');
    const text = textarea?.value ?? '';
    return {
      composerValue: text,
      hasTerminalPrompt: text.includes('Review this terminal output'),
      hasCommand: text.includes('$ node -e'),
      hasStdinOutput: text.includes('stdin:desktop-e2e-stdin'),
      hasAttachAction: Boolean(
        document.querySelector('button[aria-label="Attach Output"]')
      ),
      hasLegacySendAction: Boolean(
        document.querySelector('button[aria-label="Send to AI"]')
      ) || (terminalActions?.textContent ?? '').includes('Send to AI'),
      hasPendingApproval: document.body.innerText.includes('Approve Once')
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (!snapshot.hasAttachAction) {
    throw new Error('Terminal attach action was not rendered.');
  }

  if (snapshot.hasLegacySendAction) {
    throw new Error('Terminal should attach output, not show Send to AI.');
  }

  if (
    !snapshot.hasTerminalPrompt ||
    !snapshot.hasCommand ||
    !snapshot.hasStdinOutput
  ) {
    throw new Error(
      `Terminal output was not attached to composer: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (snapshot.hasPendingApproval) {
    throw new Error(
      'Attaching terminal output should not create an agent approval request.',
    );
  }
}

async function assertSettingsPageLayout(fileName) {
  const metrics = await evaluate(`(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      };
    };

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      grid: rectFor('[data-testid="workspace-grid"]'),
      chat: rectFor('[data-testid="chat-thread"]'),
      review: rectFor('[data-testid="review-panel"]'),
      settings: rectFor('[data-testid="settings-page"]'),
      modelConfig: rectFor('[data-testid="model-config"]'),
      permissionsConfig: rectFor('[data-testid="permissions-config"]'),
      runtimeDiagnostics: rectFor('[data-testid="runtime-diagnostics"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      settingsText:
        document.querySelector('[data-testid="settings-page"]')?.innerText ?? '',
      buttons: [
        ...document.querySelectorAll(
          '[data-testid="settings-page"] button',
        ),
      ].map((button) =>
          button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          button.textContent.trim()
        )
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  const missing = [
    'grid',
    'settings',
    'modelConfig',
    'permissionsConfig',
  ].filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing settings layout rects: ${missing.join(', ')}`);
  }

  if (
    metrics.chat !== null ||
    metrics.review !== null ||
    metrics.terminal !== null
  ) {
    throw new Error('Settings page should replace chat, review, and terminal.');
  }

  if (metrics.document.bodyScrollHeight > metrics.viewport.height + 4) {
    throw new Error(
      `Settings document should fit one viewport; body scrollHeight=${metrics.document.bodyScrollHeight}, viewport=${metrics.viewport.height}`,
    );
  }

  if (
    Math.abs(metrics.settings.left - metrics.grid.left) > 1 ||
    Math.abs(metrics.settings.right - metrics.grid.right) > 1
  ) {
    throw new Error('Settings page does not span the workbench grid.');
  }

  if (metrics.modelConfig.width < 300) {
    throw new Error(
      `Settings form is too narrow: ${metrics.modelConfig.width}`,
    );
  }

  for (const expectedSection of [
    'Account',
    'Model Providers',
    'Permissions',
    'Tools & MCP',
    'Terminal',
    'Appearance',
    'Advanced',
  ]) {
    if (!metrics.settingsText.includes(expectedSection)) {
      throw new Error(
        `Settings page is missing section ${expectedSection}: ${metrics.settingsText}`,
      );
    }
  }

  for (const hiddenDiagnostic of [
    'Server',
    'Node',
    'ACP',
    'Health',
    'session-e2e-1',
    'Settings path',
  ]) {
    if (metrics.settingsText.includes(hiddenDiagnostic)) {
      throw new Error(
        `Settings default view exposed diagnostic ${hiddenDiagnostic}: ${metrics.settingsText}`,
      );
    }
  }

  if (/http:\/\/127\.0\.0\.1:/u.test(metrics.settingsText)) {
    throw new Error(
      `Settings default view exposed the local server URL: ${metrics.settingsText}`,
    );
  }

  if (metrics.runtimeDiagnostics !== null) {
    throw new Error(
      'Runtime diagnostics should render only after Advanced Diagnostics opens.',
    );
  }

  if (!metrics.buttons.includes('Advanced Diagnostics')) {
    throw new Error(
      `Settings page is missing Advanced Diagnostics action; buttons=${metrics.buttons.join(
        ', ',
      )}`,
    );
  }
}

async function assertSettingsProductState(fileName) {
  const snapshot = await evaluate(`(() => {
    const settings = document.querySelector('[data-testid="settings-page"]');
    const apiKey = [...document.querySelectorAll('label')]
      .find((candidate) =>
        candidate.innerText.trim().toLowerCase().startsWith('api key')
      )
      ?.querySelector('input');
    return {
      text: settings?.innerText ?? '',
      apiKeyValue: apiKey?.value ?? '',
      apiKeyType: apiKey?.getAttribute('type') ?? null,
      hasSecretText:
        (settings?.innerText ?? '').includes('sk-desktop-e2e') ||
        (apiKey?.value ?? '').includes('sk-desktop-e2e'),
      hasSavedModel: (settings?.innerText ?? '').includes('qwen-e2e-cdp'),
      hasAdvancedDiagnostics:
        document.querySelector('[data-testid="runtime-diagnostics"]') !== null
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (!snapshot.hasSavedModel) {
    throw new Error(
      `Saved model is not visible in settings state: ${snapshot.text}`,
    );
  }

  if (snapshot.apiKeyType !== 'password') {
    throw new Error('API key input should remain a password field.');
  }

  if (snapshot.apiKeyValue !== '' || snapshot.hasSecretText) {
    throw new Error('Settings page exposed a saved API key value.');
  }

  if (snapshot.hasAdvancedDiagnostics) {
    throw new Error('Advanced diagnostics opened before the user requested it.');
  }
}

async function assertSettingsAdvancedDiagnostics(fileName) {
  const snapshot = await evaluate(`(() => {
    const advanced = document.querySelector(
      '[data-testid="advanced-diagnostics"]'
    );
    const runtime = document.querySelector(
      '[data-testid="runtime-diagnostics"]'
    );
    const toggle = document.querySelector(
      '[data-testid="settings-advanced-toggle"]'
    );
    return {
      text: advanced?.innerText ?? '',
      runtimeText: runtime?.innerText ?? '',
      expanded: toggle?.getAttribute('aria-expanded') ?? null,
      hasSecret:
        (advanced?.innerText ?? '').includes('sk-desktop-e2e') ||
        [...document.querySelectorAll('input')].some((input) =>
          input.value.includes('sk-desktop-e2e')
        )
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.expanded !== 'true') {
    throw new Error('Advanced Diagnostics toggle should be expanded.');
  }

  const diagnosticText = snapshot.text.toLowerCase();
  for (const expectedDiagnostic of [
    'Runtime Diagnostics',
    'Server',
    'Node',
    'ACP',
    'Health',
    'session-e2e-1',
    'Settings path',
  ]) {
    if (!diagnosticText.includes(expectedDiagnostic.toLowerCase())) {
      throw new Error(
        `Advanced diagnostics missing ${expectedDiagnostic}: ${snapshot.text}`,
      );
    }
  }

  if (!/http:\/\/127\.0\.0\.1:/u.test(snapshot.runtimeText)) {
    throw new Error(
      `Advanced diagnostics did not show the local server URL: ${snapshot.runtimeText}`,
    );
  }

  if (snapshot.hasSecret) {
    throw new Error('Advanced diagnostics exposed the fake API key.');
  }
}

async function waitForText(text, timeoutMs = 15_000) {
  await waitFor(
    `text "${text}"`,
    async () =>
      evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`),
    timeoutMs,
  );
}

async function waitForSelector(selector, timeoutMs = 15_000) {
  await waitFor(
    `selector "${selector}"`,
    async () =>
      evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`),
    timeoutMs,
  );
}

async function clickButton(text) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => {
        if (candidate.disabled) {
          return false;
        }
        const label = candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '';
        const copy = candidate.textContent ? candidate.textContent.trim() : '';
        return (
          label === ${JSON.stringify(text)} ||
          label.includes(${JSON.stringify(text)}) ||
          copy.includes(${JSON.stringify(text)})
        );
      });
    if (!button) {
      return false;
    }
    button.click();
    return true;
  })()`);

  if (!clicked) {
    throw new Error(`Button not found or disabled: ${text}`);
  }
}

async function clickButtonUntilText(
  buttonText,
  expectedText,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (
      await evaluate(
        `document.body.innerText.includes(${JSON.stringify(expectedText)})`,
      )
    ) {
      return;
    }

    try {
      await clickButton(buttonText);
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw new Error(
    `Timed out waiting for text ${JSON.stringify(
      expectedText,
    )} after clicking ${JSON.stringify(buttonText)}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

async function setFieldByAriaLabel(label, value) {
  const changed = await evaluate(`(() => {
    const field = document.querySelector('[aria-label="${escapeSelector(
      label,
    )}"]');
    if (!field) {
      return false;
    }
    setNativeFieldValue(field, ${JSON.stringify(value)});
    return true;

    function setNativeFieldValue(element, nextValue) {
      const descriptor = Object.getOwnPropertyDescriptor(
        element.constructor.prototype,
        'value'
      );
      descriptor?.set?.call(element, nextValue);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);

  if (!changed) {
    throw new Error(`Field not found: ${label}`);
  }
}

async function setFieldByLabel(label, value) {
  const changed = await evaluate(`(() => {
    const targetLabel = ${JSON.stringify(label)}.toLowerCase();
    const labelElement = [...document.querySelectorAll('label')]
      .find((candidate) =>
        candidate.innerText.trim().toLowerCase().startsWith(targetLabel)
      );
    const field = labelElement?.querySelector('input, textarea, select');
    if (!field) {
      return false;
    }
    setNativeFieldValue(field, ${JSON.stringify(value)});
    return true;

    function setNativeFieldValue(element, nextValue) {
      const descriptor = Object.getOwnPropertyDescriptor(
        element.constructor.prototype,
        'value'
      );
      descriptor?.set?.call(element, nextValue);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);

  if (!changed) {
    throw new Error(`Labeled field not found: ${label}`);
  }
}

async function saveScreenshot(fileName) {
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  await writeFile(
    join(artifactDir, fileName),
    Buffer.from(screenshot.data, 'base64'),
  );
}

async function assertNoBrowserErrors() {
  if (consoleErrors.length > 0 || failedRequests.length > 0) {
    throw new Error(
      `Renderer reported ${consoleErrors.length} console errors and ${failedRequests.length} failed requests.`,
    );
  }
}

function collectBrowserEvent(event) {
  if (event.method === 'Runtime.consoleAPICalled') {
    const type = event.params?.type;
    if (type === 'error' || type === 'assert') {
      consoleErrors.push(event.params);
    }
    return;
  }

  if (event.method === 'Log.entryAdded') {
    const entry = event.params?.entry;
    if (entry?.level === 'error') {
      consoleErrors.push(entry);
    }
    return;
  }

  if (event.method === 'Network.loadingFailed') {
    const params = event.params;
    if (params?.errorText !== 'net::ERR_ABORTED') {
      failedRequests.push(params);
    }
    return;
  }

  if (event.method === 'Network.responseReceived') {
    const response = event.params?.response;
    if (
      response &&
      response.url.startsWith('http://127.0.0.1:') &&
      response.status >= 400
    ) {
      failedRequests.push({
        url: response.url,
        status: response.status,
        statusText: response.statusText,
      });
    }
  }
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.exception?.description ||
        'Renderer evaluation failed.',
    );
  }

  return result.result.value;
}

async function waitFor(description, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }

  throw new Error(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

async function writeDiagnostics(error) {
  if (!artifactDir) {
    artifactDir = await createArtifactDir();
  }

  if (cdp) {
    try {
      await saveScreenshot('failure.png');
      const domText = await evaluate('document.body.innerText');
      await writeFile(join(artifactDir, 'dom.txt'), `${domText}\n`, 'utf8');
    } catch (diagnosticError) {
      await writeFile(
        join(artifactDir, 'diagnostic-error.txt'),
        `${diagnosticError instanceof Error ? diagnosticError.stack : diagnosticError}\n`,
        'utf8',
      );
    }
  }

  if (workspaceDir) {
    await writeCommandOutput('git-status.txt', 'git', [
      '-C',
      workspaceDir,
      'status',
      '--porcelain=v1',
      '--branch',
    ]);
    await writeCommandOutput('git-diff.txt', 'git', [
      '-C',
      workspaceDir,
      'diff',
    ]);
  }

  await writeFile(
    join(artifactDir, 'console-errors.json'),
    `${JSON.stringify(consoleErrors, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(artifactDir, 'failed-requests.json'),
    `${JSON.stringify(failedRequests, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(artifactDir, 'failure.txt'),
    `${error instanceof Error ? error.stack : error}\n`,
    'utf8',
  );
  console.error(`Desktop CDP smoke failed. Diagnostics: ${artifactDir}`);
}

async function writeCommandOutput(fileName, command, args) {
  try {
    const { stdout, stderr } = await execFileP(command, args);
    await writeFile(join(artifactDir, fileName), `${stdout}${stderr}`, 'utf8');
  } catch (error) {
    await writeFile(
      join(artifactDir, fileName),
      `${error instanceof Error ? error.message : error}\n`,
      'utf8',
    );
  }
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));

  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate a TCP port.');
  }

  return address.port;
}

function execFileP(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function escapeSelector(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class CdpClient {
  static async connect(webSocketUrl) {
    const socket = new WebSocket(webSocketUrl);
    const client = new CdpClient(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return client;
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.socket.on('message', (message) => {
      this.handleMessage(message);
    });
    this.socket.on('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('CDP socket closed.'));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    this.socket.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
  }

  close() {
    this.socket.close();
  }

  handleMessage(rawMessage) {
    const message = JSON.parse(rawMessage.toString());
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    for (const handler of this.eventHandlers) {
      handler(message);
    }
  }
}

try {
  await main();
} catch (error) {
  await writeDiagnostics(error);
  throw error;
} finally {
  cdp?.close();
  if (appProcess && !appProcess.killed) {
    appProcess.kill();
  }
}
