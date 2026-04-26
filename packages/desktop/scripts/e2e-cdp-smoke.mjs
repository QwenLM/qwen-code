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
const defaultWindowBounds = { width: 1240, height: 820 };
const compactWindowBounds = { width: 960, height: 640 };
const longBranchName =
  'desktop-e2e/very-long-branch-name-for-topbar-overflow-check';
const createdBranchName = 'desktop-e2e/new-branch-from-menu';

const consoleErrors = [];
const failedRequests = [];

let appProcess;
let browserCdp;
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
  const browserTarget = await waitForBrowserCdp(cdpPort);
  browserCdp = await CdpClient.connect(browserTarget.webSocketDebuggerUrl);
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
  await assertInlineCommandApproval('inline-command-approval.json');
  await saveScreenshot('inline-command-approval.png');
  await clickButton('Approve Once');
  await waitForText('E2E fake ACP response received');
  await assertResolvedToolActivity('resolved-tool-activity.json');
  await saveScreenshot('resolved-tool-activity.png');
  await assertAssistantMessageActions('assistant-message-actions.json');
  await saveScreenshot('assistant-message-actions.png');
  await assertConversationSurfaceFidelity('conversation-surface-fidelity.json');
  await saveScreenshot('conversation-surface-fidelity.png');
  await setElectronWindowBounds(target.id, compactWindowBounds);
  await assertCompactDenseConversationLayout(
    'compact-dense-conversation.json',
  );
  await saveScreenshot('compact-dense-conversation.png');
  await setElectronWindowBounds(target.id, defaultWindowBounds);
  await clickButton('Copy Response');
  await waitForText('Copied response.');
  await clickButton('Retry Last Prompt');
  await assertRetryDrafted('assistant-retry-draft.json');
  await setFieldByAriaLabel('Message', '');
  await assertConversationChangesSummary('conversation-changes-summary.json');
  await waitForSelector('[data-testid="thread-list"]');
  await assertSidebarAppRail('sidebar-app-rail.json');
  await assertTopbarContextFidelity('topbar-context-fidelity.json');
  await saveScreenshot('topbar-context-fidelity.png');
  await clickButton('Branch');
  await waitForSelector('[data-testid="branch-menu"]');
  await waitForSelector('[data-testid="branch-menu-row"]');
  await assertBranchSwitchMenu('branch-create-menu.json', longBranchName);
  await assertBranchCreateValidation('branch-create-validation.json');
  await saveScreenshot('branch-create-menu.png');
  await setFieldByAriaLabel('New branch name', createdBranchName);
  await clickButton('Create Branch');
  await assertBranchCreateResult('branch-create-result.json');
  await clickButton('Branch');
  await waitForSelector('[data-testid="branch-menu"]');
  await waitForSelector('[data-testid="branch-menu-row"]');
  await assertBranchSwitchMenu('branch-switch-menu.json', createdBranchName);
  await saveScreenshot('branch-switch-menu.png');
  await clickButton('Switch to branch main');
  await waitForSelector('[data-testid="branch-switch-confirmation"]');
  await assertBranchSwitchConfirmation('branch-switch-confirmation.json');
  await clickButton('Confirm Branch Switch');
  await assertBranchSwitchResult('branch-switch-result.json');

  await clickButton('Review Changes');
  await waitForText('README.md');
  await assertReviewDrawerLayout('review-drawer-layout.json');
  await saveScreenshot('review-drawer.png');
  await setElectronWindowBounds(target.id, compactWindowBounds);
  await assertCompactReviewDrawerLayout('compact-review-drawer.json');
  await saveScreenshot('compact-review-drawer.png');
  await setElectronWindowBounds(target.id, defaultWindowBounds);
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
  await execFileP('git', ['checkout', '-B', 'main'], { cwd: dir });
  await execFileP('git', ['add', '.'], { cwd: dir });
  await execFileP('git', ['commit', '-m', 'initial commit'], { cwd: dir });
  await execFileP('git', ['checkout', '-b', longBranchName], { cwd: dir });
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

async function waitForBrowserCdp(port) {
  const deadline = Date.now() + 20_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const target = await response.json();
      if (typeof target.webSocketDebuggerUrl === 'string') {
        return target;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for Electron browser CDP target on port ${port}: ${
      lastError instanceof Error ? lastError.message : 'no response'
    }`,
  );
}

async function assertWorkbenchLandmarks() {
  const landmarks = await evaluate(`(() => {
    return [
      'desktop-workspace',
      'project-sidebar',
      'sidebar-app-actions',
      'sidebar-footer-settings',
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

async function assertSidebarAppRail(fileName) {
  const metrics = await evaluate(`(() => {
    const rectFor = (element) => {
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
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const sidebar = document.querySelector('[data-testid="project-sidebar"]');
    const appActions = document.querySelector('[data-testid="sidebar-app-actions"]');
    const footerSettings = document.querySelector(
      '[data-testid="sidebar-footer-settings"]'
    );
    const projectList = document.querySelector('[data-testid="project-list"]');
    const threadList = document.querySelector('[data-testid="thread-list"]');
    const rowSelector =
      '.sidebar-action-row, .project-row, .session-row';
    const rows = [...document.querySelectorAll(rowSelector)].map((row) => {
      const label =
        row.getAttribute('aria-label') ||
        row.getAttribute('title') ||
        row.textContent.trim();
      return {
        label,
        text: row.textContent.trim(),
        rect: rectFor(row),
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        overflows: overflows(row)
      };
    });

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      sidebar: rectFor(sidebar),
      appActions: rectFor(appActions),
      footerSettings: rectFor(footerSettings),
      projectList: rectFor(projectList),
      threadList: rectFor(threadList),
      hasLegacyToolbar: document.querySelector('.sidebar-toolbar') !== null,
      appActionLabels: appActions
        ? [...appActions.querySelectorAll('button')].map(
            (button) => button.getAttribute('aria-label') || ''
          )
        : [],
      footerLabel:
        footerSettings?.getAttribute('aria-label') ||
        footerSettings?.textContent.trim() ||
        '',
      rows,
      sidebarText: sidebar?.innerText ?? '',
      overflows: {
        sidebar: overflows(sidebar),
        appActions: overflows(appActions),
        projectList: overflows(projectList),
        threadList: overflows(threadList),
        footerSettings: overflows(footerSettings)
      }
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  const missing = [
    'sidebar',
    'appActions',
    'footerSettings',
    'projectList',
    'threadList',
  ].filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing sidebar app rail rects: ${missing.join(', ')}`);
  }

  if (metrics.hasLegacyToolbar) {
    throw new Error('Sidebar should not render the old project toolbar.');
  }

  for (const expectedLabel of ['New Thread', 'Open Project', 'Models']) {
    if (!metrics.appActionLabels.includes(expectedLabel)) {
      throw new Error(
        `Sidebar app actions missing ${expectedLabel}: ${metrics.appActionLabels.join(
          ', ',
        )}`,
      );
    }
  }

  if (metrics.footerLabel !== 'Settings') {
    throw new Error(
      `Sidebar footer label should be Settings: ${metrics.footerLabel}`,
    );
  }

  if (metrics.sidebar.width < 236 || metrics.sidebar.width > 320) {
    throw new Error(
      `Sidebar width is no longer compact: ${metrics.sidebar.width}`,
    );
  }

  if (metrics.appActions.top > metrics.sidebar.top + 24) {
    throw new Error('Sidebar app actions are not pinned near the top.');
  }

  if (metrics.footerSettings.bottom > metrics.sidebar.bottom + 1) {
    throw new Error('Sidebar Settings footer overflows the sidebar.');
  }

  if (metrics.footerSettings.top < metrics.threadList.bottom - 1) {
    throw new Error(
      'Sidebar Settings should stay below the project/thread browser.',
    );
  }

  const tallRows = metrics.rows.filter((row) => row.rect.height > 44);
  if (tallRows.length > 0) {
    throw new Error(
      `Sidebar rows are too tall for the compact rail: ${JSON.stringify(
        tallRows,
      )}`,
    );
  }

  const overflowingRows = metrics.rows.filter((row) => row.overflows);
  if (overflowingRows.length > 0) {
    throw new Error(
      `Sidebar rows overflow horizontally: ${JSON.stringify(overflowingRows)}`,
    );
  }

  if (Object.values(metrics.overflows).some(Boolean)) {
    throw new Error(
      `Sidebar rail regions overflow horizontally: ${JSON.stringify(
        metrics.overflows,
      )}`,
    );
  }

  if (
    metrics.sidebarText.includes('session-e2e') ||
    metrics.sidebarText.includes('/tmp/') ||
    metrics.sidebarText.includes('Connected to')
  ) {
    throw new Error(
      `Sidebar leaked protocol or path noise: ${metrics.sidebarText}`,
    );
  }
}

async function assertTopbarContextFidelity(fileName) {
  const metrics = await evaluate(`(() => {
    const longBranchName = ${JSON.stringify(longBranchName)};
    const rectFor = (element) => {
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
    const alphaFromColor = (color) => {
      if (!color || color === 'transparent') {
        return 0;
      }
      const match = color.match(/rgba?\\(([^)]+)\\)/u);
      if (!match) {
        return 1;
      }
      const parts = match[1].split(',').map((part) => part.trim());
      if (parts.length < 4) {
        return 1;
      }
      return Number.parseFloat(parts[3]);
    };
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        backgroundAlpha: alphaFromColor(style.backgroundColor),
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
        borderRightWidth: Number.parseFloat(style.borderRightWidth),
        borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
        borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
        borderTopAlpha: alphaFromColor(style.borderTopColor)
      };
    };
    const escapes = (inner, outer) =>
      Boolean(
        inner &&
          outer &&
          (inner.left < outer.left - 1 ||
            inner.right > outer.right + 1 ||
            inner.top < outer.top - 1 ||
            inner.bottom > outer.bottom + 1)
      );
    const topbar = document.querySelector('[data-testid="workspace-topbar"]');
    const titleStack = document.querySelector('[data-testid="topbar-title-stack"]');
    const title = document.querySelector('[data-testid="topbar-title"]');
    const context = document.querySelector('[data-testid="topbar-context"]');
    const runtimeStatus = document.querySelector(
      '[data-testid="topbar-runtime-status"]'
    );
    const topbarRect = rectFor(topbar);
    const contextRect = rectFor(context);
    const actionRects = [
      ...document.querySelectorAll(
        '[data-testid="workspace-topbar"] .topbar-icon-button'
      )
    ].map((button) => ({
      label: button.getAttribute('aria-label') || '',
      rect: rectFor(button)
    }));
    const contextItems = [
      ...document.querySelectorAll('.topbar-context-item')
    ].map((item) => ({
      label: item.getAttribute('aria-label') || '',
      text: item.textContent.trim(),
      rect: rectFor(item),
      style: styleFor(item),
      escapesTopbar: escapes(rectFor(item), topbarRect),
      escapesContext: escapes(rectFor(item), contextRect)
    }));

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      topbar: topbarRect,
      titleStack: rectFor(titleStack),
      title: rectFor(title),
      context: contextRect,
      runtimeStatus: rectFor(runtimeStatus),
      runtimeStatusText: runtimeStatus?.textContent.trim() ?? '',
      runtimeStatusStyle: styleFor(runtimeStatus),
      topbarText: topbar?.textContent ?? '',
      contextText: context?.textContent ?? '',
      contextItems,
      actionRects,
      hasLegacyMeta: document.querySelector('.topbar-meta') !== null,
      hasSegmentedTabs: document.querySelector('.topbar-nav') !== null,
      hasLongBranch: topbar?.textContent.includes(longBranchName) ?? false,
      containment: {
        titleStackInTopbar: !escapes(rectFor(titleStack), topbarRect),
        contextInTopbar: !escapes(contextRect, topbarRect),
        runtimeInTopbar: !escapes(rectFor(runtimeStatus), topbarRect),
        actionsInTopbar: actionRects.every((action) =>
          !escapes(action.rect, topbarRect)
        )
      }
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  const missing = [
    'topbar',
    'titleStack',
    'title',
    'context',
    'runtimeStatus',
  ].filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing topbar fidelity rects: ${missing.join(', ')}`);
  }

  if (metrics.hasLegacyMeta || metrics.hasSegmentedTabs) {
    throw new Error('Topbar should not render legacy meta pills or tabs.');
  }

  if (metrics.topbar.height < 48 || metrics.topbar.height > 58) {
    throw new Error(`Topbar is no longer slim: ${metrics.topbar.height}`);
  }

  if (metrics.document.bodyScrollWidth > metrics.viewport.width + 4) {
    throw new Error(
      `Topbar fidelity caused horizontal body overflow: ${JSON.stringify(
        metrics.document,
      )}`,
    );
  }

  if (!metrics.hasLongBranch) {
    throw new Error(
      `Topbar did not expose the long branch in DOM text: ${metrics.topbarText}`,
    );
  }

  const labels = metrics.contextItems.map((item) => item.label);
  for (const expectedLabel of ['Connection', 'Branch', 'Git status']) {
    if (!labels.some((label) => label.startsWith(expectedLabel))) {
      throw new Error(
        `Topbar context is missing ${expectedLabel}; labels=${labels.join(
          ', ',
        )}`,
      );
    }
  }

  const heavyContextItems = metrics.contextItems.filter(
    (item) =>
      item.rect.height > 20 ||
      item.style.backgroundAlpha > 0.025 ||
      item.style.borderTopWidth > 0 ||
      item.style.borderRightWidth > 0 ||
      item.style.borderBottomWidth > 0 ||
      item.style.borderLeftWidth > 0,
  );
  if (heavyContextItems.length > 0) {
    throw new Error(
      `Topbar context should not use heavy bordered pills: ${JSON.stringify(
        heavyContextItems,
      )}`,
    );
  }

  if (metrics.runtimeStatus.height > 32 || metrics.runtimeStatus.width > 76) {
    throw new Error(
      `Runtime status should stay compact: ${JSON.stringify(
        metrics.runtimeStatus,
      )}`,
    );
  }

  const oversizedActions = metrics.actionRects.filter(
    (action) => action.rect.width > 34 || action.rect.height > 34,
  );
  if (oversizedActions.length > 0) {
    throw new Error(
      `Topbar actions should stay icon-sized: ${JSON.stringify(
        oversizedActions,
      )}`,
    );
  }

  if (Object.values(metrics.containment).some((contained) => !contained)) {
    throw new Error(
      `Topbar elements escaped the header: ${JSON.stringify(
        metrics.containment,
      )}`,
    );
  }

  const escapedContextItems = metrics.contextItems.filter(
    (item) => item.escapesTopbar,
  );
  if (escapedContextItems.length > 0) {
    throw new Error(
      `Topbar context item escaped the header: ${JSON.stringify(
        escapedContextItems,
      )}`,
    );
  }
}

async function assertBranchSwitchMenu(fileName, expectedCurrentBranch) {
  await waitFor(
    `branch menu current row ${expectedCurrentBranch}`,
    async () =>
      evaluate(`(() => {
        const currentRow = [...document.querySelectorAll(
          '[data-testid="branch-menu-row"]'
        )].find((row) => row.getAttribute('aria-checked') === 'true');
        return Boolean(
          currentRow &&
            currentRow.textContent.includes(${JSON.stringify(
              expectedCurrentBranch,
            )})
        );
      })()`),
    15_000,
  );

  const snapshot = await evaluate(`(() => {
    const rectFor = (element) => {
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
    const menu = document.querySelector('[data-testid="branch-menu"]');
    const createForm = document.querySelector('[data-testid="branch-create-form"]');
    const trigger = document.querySelector('[data-testid="topbar-branch-trigger"]');
    const topbar = document.querySelector('[data-testid="workspace-topbar"]');
    const rows = [...document.querySelectorAll('[data-testid="branch-menu-row"]')];
    const createButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim().includes('Create Branch'));
    const rowSnapshots = rows.map((row) => ({
      label: row.getAttribute('aria-label') || '',
      checked: row.getAttribute('aria-checked'),
      disabled: row.disabled,
      text: row.textContent.trim(),
      rect: rectFor(row)
    }));
    const menuRect = rectFor(menu);
    const rowEscapesMenu = (row) =>
      Boolean(
        row.rect &&
          menuRect &&
          (row.rect.left < menuRect.left - 1 ||
            row.rect.right > menuRect.right + 1)
      );
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        bodyScrollWidth: document.body.scrollWidth
      },
      triggerText: trigger?.textContent.trim() ?? '',
      triggerExpanded: trigger?.getAttribute('aria-expanded'),
      menu: menuRect,
      topbar: rectFor(topbar),
      rows: rowSnapshots,
      hasLongBranch: rowSnapshots.some((row) =>
        row.text.includes(${JSON.stringify(longBranchName)})
      ),
      hasCreatedBranch: rowSnapshots.some((row) =>
        row.text.includes(${JSON.stringify(createdBranchName)})
      ),
      hasMain: rowSnapshots.some((row) => row.text.includes('main')),
      currentRows: rowSnapshots.filter((row) => row.checked === 'true'),
      escapedRows: rowSnapshots.filter(rowEscapesMenu),
      createForm: rectFor(createForm),
      createButtonDisabled: createButton?.disabled ?? null,
      menuContained: Boolean(
        menuRect &&
          menuRect.left >= 0 &&
          menuRect.right <= window.innerWidth &&
          menuRect.top >= 0 &&
          menuRect.bottom <= window.innerHeight
      )
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.triggerExpanded !== 'true') {
    throw new Error('Branch trigger should be expanded while the menu is open.');
  }

  if (!snapshot.menu || snapshot.menu.width > 330) {
    throw new Error(
      `Branch menu should stay compact: ${JSON.stringify(snapshot.menu)}`,
    );
  }

  if (!snapshot.menuContained) {
    throw new Error(
      `Branch menu escaped the viewport: ${JSON.stringify(snapshot.menu)}`,
    );
  }

  if (!snapshot.hasLongBranch || !snapshot.hasMain) {
    throw new Error(
      `Branch menu did not list expected branches: ${JSON.stringify(
        snapshot.rows,
      )}`,
    );
  }

  if (snapshot.escapedRows.length > 0) {
    throw new Error(
      `Branch menu rows escaped the menu: ${JSON.stringify(
        snapshot.escapedRows,
      )}`,
    );
  }

  if (snapshot.currentRows.length !== 1) {
    throw new Error(
      `Branch menu should mark one branch current: ${JSON.stringify(
        snapshot.currentRows,
      )}`,
    );
  }

  if (!snapshot.currentRows[0].text.includes(expectedCurrentBranch)) {
    throw new Error(
      `Branch menu should mark ${expectedCurrentBranch} current: ${JSON.stringify(
        snapshot.currentRows,
      )}`,
    );
  }

  if (!snapshot.createForm) {
    throw new Error('Branch menu is missing the create-branch form.');
  }

  if (!snapshot.createButtonDisabled) {
    throw new Error('Empty branch creation should be disabled.');
  }

  if (
    snapshot.createForm &&
    snapshot.menu &&
    (snapshot.createForm.left < snapshot.menu.left - 1 ||
      snapshot.createForm.right > snapshot.menu.right + 1)
  ) {
    throw new Error(
      `Branch create form escaped the menu: ${JSON.stringify(
        snapshot.createForm,
      )}`,
    );
  }

  if (snapshot.document.bodyScrollWidth > snapshot.viewport.width + 4) {
    throw new Error(
      `Branch menu caused body overflow: ${JSON.stringify(snapshot.document)}`,
    );
  }
}

async function assertBranchCreateValidation(fileName) {
  const snapshot = await evaluate(`(() => {
    const form = document.querySelector('[data-testid="branch-create-form"]');
    const input = document.querySelector('[aria-label="New branch name"]');
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim().includes('Create Branch'));
    return {
      formText: form?.textContent.trim() ?? '',
      inputValue: input?.value ?? null,
      buttonDisabled: button?.disabled ?? null
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.inputValue !== '') {
    throw new Error(
      `New branch input should start empty: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.buttonDisabled !== true) {
    throw new Error(
      `Create Branch should be disabled while the branch name is empty: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function assertBranchCreateResult(fileName) {
  await waitFor(
    'branch creation from menu',
    async () => {
      const ui = await evaluate(`(() => {
        const trigger = document.querySelector(
          '[data-testid="topbar-branch-trigger"]'
        );
        return {
          branchText: trigger?.textContent.trim() ?? '',
          menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
          gitStatusText:
            document.querySelector('[aria-label^="Git status"]')?.textContent.trim() ??
            ''
        };
      })()`);
      const { stdout } = await execFileP('git', [
        '-C',
        workspaceDir,
        'branch',
        '--show-current',
      ]);
      return (
        ui.branchText.includes(createdBranchName) &&
        !ui.menuOpen &&
        stdout.trim() === createdBranchName
      );
    },
    15_000,
  );

  const [ui, branch, status] = await Promise.all([
    evaluate(`(() => {
      const trigger = document.querySelector('[data-testid="topbar-branch-trigger"]');
      return {
        branchText: trigger?.textContent.trim() ?? '',
        menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
        gitStatusText:
          document.querySelector('[aria-label^="Git status"]')?.textContent.trim() ??
          ''
      };
    })()`),
    execFileP('git', ['-C', workspaceDir, 'branch', '--show-current']),
    execFileP('git', ['-C', workspaceDir, 'status', '--porcelain=v1']),
  ]);
  const snapshot = {
    ui,
    branch: branch.stdout.trim(),
    status: status.stdout,
  };

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.branch !== createdBranchName) {
    throw new Error(
      `Expected Git branch ${createdBranchName}, got ${snapshot.branch}`,
    );
  }

  if (!snapshot.ui.gitStatusText.includes('1 modified')) {
    throw new Error(
      `Branch creation should preserve dirty status in the topbar: ${snapshot.ui.gitStatusText}`,
    );
  }
}

async function assertBranchSwitchConfirmation(fileName) {
  const snapshot = await evaluate(`(() => {
    const confirmation = document.querySelector(
      '[data-testid="branch-switch-confirmation"]'
    );
    const buttons = [...document.querySelectorAll(
      '[data-testid="branch-menu"] button'
    )].map((button) => ({
      label: button.getAttribute('aria-label') || button.textContent.trim(),
      disabled: button.disabled
    }));
    return {
      text: confirmation?.textContent.trim() ?? '',
      buttons,
      hasMenu: document.querySelector('[data-testid="branch-menu"]') !== null
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (!snapshot.hasMenu) {
    throw new Error('Branch confirmation should remain inside the branch menu.');
  }

  if (
    !snapshot.text.includes('Switch branch with local changes?') ||
    !snapshot.text.includes('Uncommitted changes')
  ) {
    throw new Error(
      `Branch dirty confirmation copy is missing: ${snapshot.text}`,
    );
  }

  const buttonLabels = snapshot.buttons.map((button) => button.label);
  for (const expected of ['Cancel Branch Switch', 'Confirm Branch Switch']) {
    if (!buttonLabels.some((label) => label.includes(expected))) {
      throw new Error(
        `Branch confirmation missing ${expected}: ${buttonLabels.join(', ')}`,
      );
    }
  }
}

async function assertBranchSwitchResult(fileName) {
  await waitFor(
    'branch switch to main',
    async () => {
      const ui = await evaluate(`(() => {
        const trigger = document.querySelector(
          '[data-testid="topbar-branch-trigger"]'
        );
        return {
          branchText: trigger?.textContent.trim() ?? '',
          menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
          gitStatusText:
            document.querySelector('[aria-label^="Git status"]')?.textContent.trim() ??
            ''
        };
      })()`);
      const { stdout } = await execFileP('git', [
        '-C',
        workspaceDir,
        'branch',
        '--show-current',
      ]);
      return (
        ui.branchText.includes('main') &&
        !ui.menuOpen &&
        stdout.trim() === 'main'
      );
    },
    15_000,
  );

  const [ui, branch, status] = await Promise.all([
    evaluate(`(() => {
      const trigger = document.querySelector('[data-testid="topbar-branch-trigger"]');
      return {
        branchText: trigger?.textContent.trim() ?? '',
        menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
        gitStatusText:
          document.querySelector('[aria-label^="Git status"]')?.textContent.trim() ??
          '',
        bodyHasLongBranch: document.body.innerText.includes(
          ${JSON.stringify(longBranchName)}
        )
      };
    })()`),
    execFileP('git', ['-C', workspaceDir, 'branch', '--show-current']),
    execFileP('git', ['-C', workspaceDir, 'status', '--porcelain=v1']),
  ]);
  const snapshot = {
    ui,
    branch: branch.stdout.trim(),
    status: status.stdout,
  };

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.branch !== 'main') {
    throw new Error(`Expected Git branch main, got ${snapshot.branch}`);
  }

  if (!snapshot.ui.gitStatusText.includes('1 modified')) {
    throw new Error(
      `Branch switch should preserve dirty status in the topbar: ${snapshot.ui.gitStatusText}`,
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
      hasPendingApprovalCard:
        document.querySelector('[data-testid="conversation-approval-card"]') !== null,
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

  if (snapshot.hasPendingApprovalCard) {
    throw new Error('Approval card should resolve after approval.');
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

async function assertInlineCommandApproval(fileName) {
  await waitForSelector('[data-testid="conversation-approval-card"]');
  const snapshot = await evaluate(`(() => {
    const card = document.querySelector(
      '[data-testid="conversation-approval-card"]'
    );
    const timeline = document.querySelector('.chat-timeline');
    const composer = document.querySelector('[data-testid="message-composer"]');
    const rectFor = (element) => {
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
    const buttons = [...(card?.querySelectorAll('button') ?? [])].map(
      (button) =>
        button.getAttribute('aria-label') ||
        button.getAttribute('title') ||
        button.textContent.trim()
    );
    return {
      bodyText: document.body.innerText,
      cardText: card?.innerText ?? '',
      buttons,
      cardRect: rectFor(card),
      timelineRect: rectFor(timeline),
      composerRect: rectFor(composer),
      hasPermissionStrip: document.querySelector('.permission-strip') !== null,
      hasRequestEvent: document.body.innerText.includes('Permission requested')
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  const cardText = snapshot.cardText.toLowerCase();
  for (const expectedText of [
    'run desktop e2e command',
    'printf desktop-e2e',
    'pending',
  ]) {
    if (!cardText.includes(expectedText)) {
      throw new Error(
        `Inline approval card is missing ${expectedText}: ${snapshot.cardText}`,
      );
    }
  }

  for (const expectedAction of ['Approve Once', 'Approve for Thread', 'Deny']) {
    if (!snapshot.buttons.includes(expectedAction)) {
      throw new Error(
        `Inline approval card missing action ${expectedAction}; buttons=${snapshot.buttons.join(
          ', ',
        )}`,
      );
    }
  }

  if (snapshot.hasPermissionStrip) {
    throw new Error(
      'Permission approval should render inline, not in a strip.',
    );
  }

  if (snapshot.hasRequestEvent) {
    throw new Error('Permission request protocol event leaked into the body.');
  }

  if (!snapshot.cardRect || !snapshot.timelineRect || !snapshot.composerRect) {
    throw new Error(
      `Inline approval geometry is missing: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.cardRect.width < 360 || snapshot.cardRect.height > 180) {
    throw new Error(
      `Inline approval card geometry is unexpected: ${JSON.stringify(
        snapshot.cardRect,
      )}`,
    );
  }

  if (
    snapshot.cardRect.left < snapshot.timelineRect.left ||
    snapshot.cardRect.right > snapshot.timelineRect.right + 1
  ) {
    throw new Error('Inline approval card should stay inside the timeline.');
  }

  if (snapshot.cardRect.bottom > snapshot.composerRect.top) {
    throw new Error('Inline approval card overlaps the composer.');
  }
}

async function assertResolvedToolActivity(fileName) {
  await waitForSelector('[data-testid="conversation-tool-card"]');
  const snapshot = await evaluate(`(() => {
    const card = document.querySelector(
      '[data-testid="conversation-tool-card"]'
    );
    const timeline = document.querySelector('.chat-timeline');
    const composer = document.querySelector('[data-testid="message-composer"]');
    const firstPreview = card?.querySelector('.conversation-tool-section pre');
    const fileChip = card?.querySelector('.conversation-tool-files li');
    const rectFor = (element) => {
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
    const alphaFromColor = (color) => {
      if (!color || color === 'transparent') {
        return 0;
      }

      const match = color.match(/rgba?\\(([^)]+)\\)/u);
      if (!match) {
        return 1;
      }

      const parts = match[1].split(',').map((part) => part.trim());
      if (parts.length < 4) {
        return 1;
      }

      const alpha = Number(parts[3]);
      return Number.isFinite(alpha) ? alpha : 1;
    };
    const numberFromPixel = (value) => {
      const number = Number.parseFloat(value);
      return Number.isFinite(number) ? number : 0;
    };
    const styleFor = (element) => {
      if (!element) {
        return null;
      }

      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        backgroundAlpha: alphaFromColor(style.backgroundColor),
        borderTopColor: style.borderTopColor,
        borderTopAlpha: alphaFromColor(style.borderTopColor),
        borderLeftColor: style.borderLeftColor,
        borderLeftAlpha: alphaFromColor(style.borderLeftColor),
        borderTopWidth: numberFromPixel(style.borderTopWidth),
        borderRightWidth: numberFromPixel(style.borderRightWidth),
        borderBottomWidth: numberFromPixel(style.borderBottomWidth),
        borderLeftWidth: numberFromPixel(style.borderLeftWidth),
        borderRadius: style.borderTopLeftRadius
      };
    };
    return {
      bodyText: document.body.innerText,
      cardText: card?.innerText ?? '',
      cardRect: rectFor(card),
      cardStyle: styleFor(card),
      timelineRect: rectFor(timeline),
      composerRect: rectFor(composer),
      legacyToolRows: document.querySelectorAll('.chat-tool').length,
      previewStyle: styleFor(firstPreview),
      fileChipStyle: styleFor(fileChip),
      fileChipText:
        document.querySelector('.conversation-tool-files')?.innerText ?? ''
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  const cardText = snapshot.cardText.toLowerCase();
  for (const expectedText of [
    'run desktop e2e command',
    'completed',
    'printf desktop-e2e',
    'desktop-e2e command completed',
  ]) {
    if (!cardText.includes(expectedText)) {
      throw new Error(
        `Resolved tool activity is missing ${expectedText}: ${snapshot.cardText}`,
      );
    }
  }

  if (!snapshot.fileChipText.includes('README.md:1')) {
    throw new Error(
      `Resolved tool activity is missing the file chip: ${snapshot.fileChipText}`,
    );
  }

  for (const internalText of ['e2e-terminal-check', 'session-e2e']) {
    if (snapshot.cardText.includes(internalText)) {
      throw new Error(
        `Resolved tool activity leaked internal text ${internalText}: ${snapshot.cardText}`,
      );
    }
  }

  if (snapshot.legacyToolRows !== 0) {
    throw new Error(
      `Resolved tool activity should not render legacy rows: ${snapshot.legacyToolRows}`,
    );
  }

  if (!snapshot.cardRect || !snapshot.timelineRect || !snapshot.composerRect) {
    throw new Error(
      `Resolved tool activity geometry is missing: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.cardRect.width < 360 || snapshot.cardRect.height > 240) {
    throw new Error(
      `Resolved tool activity geometry is unexpected: ${JSON.stringify(
        snapshot.cardRect,
      )}`,
    );
  }

  if (snapshot.cardRect.height > 175) {
    throw new Error(
      `Resolved tool activity should be compact, not card-like: ${JSON.stringify(
        snapshot.cardRect,
      )}`,
    );
  }

  if (!snapshot.cardStyle || !snapshot.previewStyle || !snapshot.fileChipStyle) {
    throw new Error(
      `Resolved tool activity styles are missing: ${JSON.stringify(snapshot)}`,
    );
  }

  if (
    snapshot.cardStyle.borderTopWidth !== 0 ||
    snapshot.cardStyle.borderRightWidth !== 0 ||
    snapshot.cardStyle.borderBottomWidth !== 0
  ) {
    throw new Error(
      `Resolved tool activity should not have a full card border: ${JSON.stringify(
        snapshot.cardStyle,
      )}`,
    );
  }

  if (
    snapshot.cardStyle.borderLeftWidth < 1 ||
    snapshot.cardStyle.borderLeftWidth > 2 ||
    snapshot.cardStyle.borderLeftAlpha > 0.5
  ) {
    throw new Error(
      `Resolved tool activity accent should stay subtle: ${JSON.stringify(
        snapshot.cardStyle,
      )}`,
    );
  }

  if (snapshot.cardStyle.backgroundAlpha > 0.04) {
    throw new Error(
      `Resolved tool activity background is too heavy: ${JSON.stringify(
        snapshot.cardStyle,
      )}`,
    );
  }

  if (snapshot.previewStyle.backgroundAlpha > 0.08) {
    throw new Error(
      `Resolved tool activity preview background is too heavy: ${JSON.stringify(
        snapshot.previewStyle,
      )}`,
    );
  }

  if (
    snapshot.fileChipStyle.backgroundAlpha > 0.07 ||
    snapshot.fileChipStyle.borderTopAlpha > 0.2
  ) {
    throw new Error(
      `Resolved tool activity file chip is too heavy: ${JSON.stringify(
        snapshot.fileChipStyle,
      )}`,
    );
  }

  if (
    snapshot.cardRect.left < snapshot.timelineRect.left ||
    snapshot.cardRect.right > snapshot.timelineRect.right + 1
  ) {
    throw new Error('Resolved tool activity should stay inside the timeline.');
  }

  if (snapshot.cardRect.bottom > snapshot.composerRect.top) {
    throw new Error('Resolved tool activity overlaps the composer.');
  }
}

async function assertAssistantMessageActions(fileName) {
  await waitForSelector('[data-testid="assistant-message-actions"]');
  const snapshot = await evaluate(`(() => {
    const message = [...document.querySelectorAll('[data-testid="assistant-message"]')]
      .find((candidate) =>
        candidate.innerText.includes('E2E fake ACP response received')
      );
    const actions = message?.querySelector(
      '[data-testid="assistant-message-actions"]'
    );
    const fileReferences = message?.querySelector(
      '[data-testid="assistant-file-references"]'
    );
    const timeline = document.querySelector('.chat-timeline');
    const composer = document.querySelector('[data-testid="message-composer"]');
    const rectFor = (element) => {
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
      bodyText: document.body.innerText,
      messageText: message?.innerText ?? '',
      actionLabels: actions
        ? [...actions.querySelectorAll('button')].map(
            (button) => button.getAttribute('aria-label') || ''
          )
        : [],
      fileReferenceText: fileReferences?.innerText ?? '',
      fileReferenceLabels: fileReferences
        ? [...fileReferences.querySelectorAll('button')].map(
            (button) => button.getAttribute('aria-label') || ''
          )
        : [],
      overflowText:
        fileReferences?.querySelector('.message-file-reference-overflow')
          ?.innerText ?? '',
      overflowLabel:
        fileReferences?.querySelector('.message-file-reference-overflow')
          ?.getAttribute('aria-label') ?? '',
      chipRects: fileReferences
        ? [
            ...fileReferences.querySelectorAll(
              'button, .message-file-reference-overflow'
            )
          ].map((chip) => rectFor(chip))
        : [],
      messageRect: rectFor(message),
      actionsRect: rectFor(actions),
      timelineRect: rectFor(timeline),
      composerRect: rectFor(composer),
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  for (const expectedLabel of [
    'Copy Response',
    'Retry Last Prompt',
    'Open Changes',
  ]) {
    if (!snapshot.actionLabels.includes(expectedLabel)) {
      throw new Error(
        `Assistant action row missing ${expectedLabel}: ${snapshot.actionLabels.join(
          ', ',
        )}`,
      );
    }
  }

  if (!snapshot.fileReferenceText.includes('README.md:1')) {
    throw new Error(
      `Assistant file chips missing README.md:1: ${snapshot.fileReferenceText}`,
    );
  }

  if (!snapshot.fileReferenceLabels.includes('Open README.md:1')) {
    throw new Error(
      `Assistant file chip is not accessible: ${snapshot.fileReferenceLabels.join(
        ', ',
      )}`,
    );
  }

  for (const expectedLabel of [
    'Open packages/desktop/src/renderer/App.tsx:12:5',
    'Open .env.example',
    'Open Dockerfile',
    'Open docs/guide.mdx',
    'Open src/App.vue',
  ]) {
    if (!snapshot.fileReferenceLabels.includes(expectedLabel)) {
      throw new Error(
        `Dense assistant file chips missing ${expectedLabel}: ${snapshot.fileReferenceLabels.join(
          ', ',
        )}`,
      );
    }
  }

  const readmeChipCount = snapshot.fileReferenceLabels.filter(
    (label) => label === 'Open README.md:1',
  ).length;
  if (readmeChipCount !== 1) {
    throw new Error(
      `Repeated README.md:1 references should dedupe to one chip: ${snapshot.fileReferenceLabels.join(
        ', ',
      )}`,
    );
  }

  if (
    snapshot.overflowText !== '+2 more' ||
    snapshot.overflowLabel !== '2 more file references'
  ) {
    throw new Error(
      `Dense assistant file overflow is missing: ${JSON.stringify({
        overflowText: snapshot.overflowText,
        overflowLabel: snapshot.overflowLabel,
      })}`,
    );
  }

  for (const internalText of ['e2e-terminal-check', 'session-e2e']) {
    if (snapshot.messageText.includes(internalText)) {
      throw new Error(
        `Assistant message leaked internal text ${internalText}: ${snapshot.messageText}`,
      );
    }
  }

  if (
    !snapshot.messageRect ||
    !snapshot.actionsRect ||
    !snapshot.timelineRect ||
    !snapshot.composerRect
  ) {
    throw new Error(
      `Assistant action geometry is missing: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.actionsRect.height > 40) {
    throw new Error(
      `Assistant action row is too tall: ${JSON.stringify(
        snapshot.actionsRect,
      )}`,
    );
  }

  if (
    snapshot.messageRect.left < snapshot.timelineRect.left ||
    snapshot.messageRect.right > snapshot.timelineRect.right + 1
  ) {
    throw new Error('Assistant message should stay inside the timeline.');
  }

  if (snapshot.messageRect.bottom > snapshot.composerRect.top) {
    throw new Error('Assistant message overlaps the composer.');
  }

  if (snapshot.documentScrollWidth > snapshot.viewportWidth + 4) {
    throw new Error(
      `Assistant file chips caused horizontal page overflow: ${JSON.stringify({
        documentScrollWidth: snapshot.documentScrollWidth,
        viewportWidth: snapshot.viewportWidth,
      })}`,
    );
  }

  for (const chipRect of snapshot.chipRects) {
    if (!chipRect) {
      throw new Error('Assistant file chip geometry is missing.');
    }

    if (chipRect.width > 282) {
      throw new Error(
        `Assistant file chip is too wide: ${JSON.stringify(chipRect)}`,
      );
    }

    if (
      chipRect.left < snapshot.messageRect.left ||
      chipRect.right > snapshot.messageRect.right + 1 ||
      chipRect.left < snapshot.timelineRect.left ||
      chipRect.right > snapshot.timelineRect.right + 1
    ) {
      throw new Error(
        `Assistant file chip escaped the message: ${JSON.stringify(chipRect)}`,
      );
    }
  }
}

async function assertConversationSurfaceFidelity(fileName) {
  await waitForSelector('[data-testid="conversation-changes-summary"]');
  const snapshot = await evaluate(`(() => {
    const rectFor = (element) => {
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
    const alphaFromColor = (color) => {
      if (!color || color === 'transparent') {
        return 0;
      }

      const match = color.match(/rgba?\\(([^)]+)\\)/u);
      if (!match) {
        return 1;
      }

      const parts = match[1].split(',').map((part) => part.trim());
      if (parts.length < 4) {
        return 1;
      }

      const alpha = Number(parts[3]);
      return Number.isFinite(alpha) ? alpha : 1;
    };
    const numberFromPixel = (value) => {
      const number = Number.parseFloat(value);
      return Number.isFinite(number) ? number : 0;
    };
    const styleFor = (element) => {
      if (!element) {
        return null;
      }

      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        backgroundAlpha: alphaFromColor(style.backgroundColor),
        borderColor: style.borderTopColor,
        borderAlpha: alphaFromColor(style.borderTopColor),
        borderTopWidth: numberFromPixel(style.borderTopWidth),
        borderRightWidth: numberFromPixel(style.borderRightWidth),
        borderBottomWidth: numberFromPixel(style.borderBottomWidth),
        borderLeftWidth: numberFromPixel(style.borderLeftWidth),
        borderRadius: style.borderTopLeftRadius
      };
    };
    const assistantMessage = [
      ...document.querySelectorAll('[data-testid="assistant-message"]')
    ].find((candidate) =>
      candidate.innerText.includes('E2E fake ACP response received')
    );
    const userMessage = document.querySelector('.chat-message-user');
    const summary = document.querySelector(
      '[data-testid="conversation-changes-summary"]'
    );
    const summaryAction = summary?.querySelector(
      'button[aria-label="Review Changes"]'
    );
    const firstSummaryRow = summary?.querySelector(
      '.conversation-changes-list li'
    );
    const timeline = document.querySelector('.chat-timeline');
    const actionButtons = assistantMessage
      ? [
          ...assistantMessage.querySelectorAll(
            '[data-testid="assistant-message-actions"] button'
          )
        ]
      : [];

    return {
      assistant: {
        rect: rectFor(assistantMessage),
        style: styleFor(assistantMessage)
      },
      user: {
        rect: rectFor(userMessage),
        style: styleFor(userMessage)
      },
      summary: {
        rect: rectFor(summary),
        style: styleFor(summary),
        actionRect: rectFor(summaryAction),
        rowStyle: styleFor(firstSummaryRow)
      },
      timeline: rectFor(timeline),
      actionButtons: actionButtons.map((button) => ({
        label: button.getAttribute('aria-label') || '',
        rect: rectFor(button),
        style: styleFor(button)
      })),
      document: {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth
      }
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    !snapshot.assistant.rect ||
    !snapshot.assistant.style ||
    !snapshot.user.rect ||
    !snapshot.user.style ||
    !snapshot.summary.rect ||
    !snapshot.summary.style ||
    !snapshot.summary.actionRect ||
    !snapshot.summary.rowStyle ||
    !snapshot.timeline
  ) {
    throw new Error(
      `Conversation surface fidelity metrics are missing: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  const assistantBorders = [
    snapshot.assistant.style.borderTopWidth,
    snapshot.assistant.style.borderRightWidth,
    snapshot.assistant.style.borderBottomWidth,
    snapshot.assistant.style.borderLeftWidth,
  ];
  if (assistantBorders.some((width) => width > 0)) {
    throw new Error(
      `Assistant message should render as unframed timeline prose: ${JSON.stringify(
        snapshot.assistant.style,
      )}`,
    );
  }

  if (snapshot.assistant.style.backgroundAlpha > 0.02) {
    throw new Error(
      `Assistant message background is too card-like: ${JSON.stringify(
        snapshot.assistant.style,
      )}`,
    );
  }

  if (
    snapshot.assistant.rect.left < snapshot.timeline.left ||
    snapshot.assistant.rect.right > snapshot.timeline.right + 1
  ) {
    throw new Error('Assistant message escaped the conversation timeline.');
  }

  if (
    snapshot.user.rect.width > 620 ||
    snapshot.user.style.backgroundAlpha < 0.05 ||
    snapshot.user.style.borderTopWidth < 1
  ) {
    throw new Error(
      `User prompt bubble lost compact bubble treatment: ${JSON.stringify(
        snapshot.user,
      )}`,
    );
  }

  if (
    snapshot.summary.style.borderAlpha > 0.14 ||
    snapshot.summary.style.backgroundAlpha > 0.045
  ) {
    throw new Error(
      `Changed-files summary surface is too visually heavy: ${JSON.stringify(
        snapshot.summary.style,
      )}`,
    );
  }

  if (snapshot.summary.rect.height > 158) {
    throw new Error(
      `Changed-files summary should stay compact: ${JSON.stringify(
        snapshot.summary.rect,
      )}`,
    );
  }

  if (snapshot.summary.rowStyle.backgroundAlpha > 0.04) {
    throw new Error(
      `Changed-files rows should not look like nested cards: ${JSON.stringify(
        snapshot.summary.rowStyle,
      )}`,
    );
  }

  if (snapshot.summary.actionRect.height > 34) {
    throw new Error(
      `Changed-files action is too tall: ${JSON.stringify(
        snapshot.summary.actionRect,
      )}`,
    );
  }

  for (const button of snapshot.actionButtons) {
    if (!button.rect || !button.style) {
      throw new Error(
        `Assistant action button metrics are missing: ${JSON.stringify(
          button,
        )}`,
      );
    }

    if (button.rect.width > 32 || button.rect.height > 32) {
      throw new Error(
        `Assistant action button should remain compact: ${JSON.stringify(
          button,
        )}`,
      );
    }
  }

  if (snapshot.document.scrollWidth > snapshot.document.viewportWidth + 4) {
    throw new Error(
      `Conversation surface introduced horizontal document overflow: ${JSON.stringify(
        snapshot.document,
      )}`,
    );
  }
}

async function assertCompactDenseConversationLayout(fileName) {
  await waitFor(
    'compact dense conversation viewport',
    async () => {
      const viewport = await evaluate(`({
        width: window.innerWidth,
        height: window.innerHeight
      })`);
      return (
        viewport.width >= 940 &&
        viewport.width <= 1000 &&
        viewport.height >= 600 &&
        viewport.height <= 680
      );
    },
    10_000,
  );

  await waitForSelector('[data-testid="assistant-file-references"]');
  const snapshot = await evaluate(`(() => {
    const rectFor = (element) => {
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
    const isContained = (child, parent, tolerance = 1) =>
      Boolean(
        child &&
        parent &&
        child.left >= parent.left - tolerance &&
        child.right <= parent.right + tolerance
      );
    const overflows = (element) =>
      element ? element.scrollWidth > element.clientWidth + 4 : false;
    const message = [...document.querySelectorAll('[data-testid="assistant-message"]')]
      .find((candidate) =>
        candidate.innerText.includes('E2E fake ACP response received')
      );
    const timeline = document.querySelector('.chat-timeline');
    const summary = document.querySelector(
      '[data-testid="conversation-changes-summary"]'
    );
    const composer = document.querySelector('[data-testid="message-composer"]');
    const terminal = document.querySelector('[data-testid="terminal-drawer"]');
    const terminalBody = document.querySelector('[data-testid="terminal-body"]');
    const terminalToggle = document.querySelector(
      '[data-testid="terminal-toggle"]'
    );

    const preScroll = {
      summaryRect: rectFor(summary),
      timelineRect: rectFor(timeline),
      composerRect: rectFor(composer),
      terminalRect: rectFor(terminal)
    };

    message?.scrollIntoView({ block: 'center', inline: 'nearest' });

    const fileReferences = message?.querySelector(
      '[data-testid="assistant-file-references"]'
    );
    const actions = message?.querySelector(
      '[data-testid="assistant-message-actions"]'
    );
    const messageRect = rectFor(message);
    const timelineRect = rectFor(timeline);
    const composerRect = rectFor(composer);
    const chipRects = fileReferences
      ? [
          ...fileReferences.querySelectorAll(
            'button, .message-file-reference-overflow'
          )
        ].map((chip) => rectFor(chip))
      : [];
    const actionRects = actions
      ? [...actions.querySelectorAll('button')].map((button) =>
          rectFor(button)
        )
      : [];

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      shell: rectFor(document.querySelector('[data-testid="desktop-workspace"]')),
      sidebar: rectFor(document.querySelector('[data-testid="project-sidebar"]')),
      topbar: rectFor(document.querySelector('[data-testid="workspace-topbar"]')),
      grid: rectFor(document.querySelector('[data-testid="workspace-grid"]')),
      chat: rectFor(document.querySelector('[data-testid="chat-thread"]')),
      timeline: timelineRect,
      message: messageRect,
      fileReferences: rectFor(fileReferences),
      actions: rectFor(actions),
      summary: rectFor(summary),
      composer: composerRect,
      terminal: rectFor(terminal),
      terminalExpanded: terminalToggle?.getAttribute('aria-expanded') ?? null,
      terminalBodyPresent: terminalBody !== null,
      preScroll,
      fileReferenceLabels: fileReferences
        ? [...fileReferences.querySelectorAll('button')].map(
            (button) => button.getAttribute('aria-label') || ''
          )
        : [],
      actionLabels: actions
        ? [...actions.querySelectorAll('button')].map(
            (button) => button.getAttribute('aria-label') || ''
          )
        : [],
      chipRects,
      actionRects,
      summaryVisibleBeforeAssistantScroll: Boolean(
        preScroll.summaryRect &&
        preScroll.timelineRect &&
        preScroll.composerRect &&
        preScroll.summaryRect.top >= preScroll.timelineRect.top - 1 &&
        preScroll.summaryRect.bottom <= preScroll.composerRect.top + 1
      ),
      summaryContainedBeforeAssistantScroll: isContained(
        preScroll.summaryRect,
        preScroll.timelineRect
      ),
      messageContained: isContained(messageRect, timelineRect),
      actionsContained: isContained(rectFor(actions), messageRect),
      composerContained: isContained(composerRect, timelineRect),
      terminalDocked: Boolean(
        rectFor(terminal) &&
        preScroll.composerRect &&
        rectFor(terminal).top >= preScroll.composerRect.bottom - 1
      ),
      overflow: {
        shell: overflows(document.querySelector('[data-testid="desktop-workspace"]')),
        topbar: overflows(document.querySelector('[data-testid="workspace-topbar"]')),
        timeline: overflows(timeline),
        message: overflows(message),
        fileReferences: overflows(fileReferences),
        composer: overflows(composer),
        composerContext: overflows(document.querySelector('.composer-context')),
        composerActions: overflows(document.querySelector('.composer-actions'))
      }
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.viewport.width < 940 || snapshot.viewport.width > 1000) {
    throw new Error(
      `Compact viewport width is unexpected: ${snapshot.viewport.width}`,
    );
  }

  if (snapshot.viewport.height < 600 || snapshot.viewport.height > 680) {
    throw new Error(
      `Compact viewport height is unexpected: ${snapshot.viewport.height}`,
    );
  }

  const missing = [
    'shell',
    'sidebar',
    'topbar',
    'grid',
    'chat',
    'timeline',
    'message',
    'fileReferences',
    'actions',
    'composer',
    'terminal',
  ].filter((key) => snapshot[key] === null);
  if (missing.length > 0) {
    throw new Error(
      `Missing compact dense conversation rects: ${missing.join(', ')}`,
    );
  }

  if (snapshot.document.bodyScrollWidth > snapshot.viewport.width + 4) {
    throw new Error(
      `Compact layout caused horizontal body overflow: ${JSON.stringify(
        snapshot.document,
      )}`,
    );
  }

  if (snapshot.sidebar.width < 232 || snapshot.sidebar.width > 264) {
    throw new Error(
      `Compact sidebar width should stay narrow: ${snapshot.sidebar.width}`,
    );
  }

  if (snapshot.topbar.height < 50 || snapshot.topbar.height > 76) {
    throw new Error(
      `Compact topbar height should stay slim: ${snapshot.topbar.height}`,
    );
  }

  if (snapshot.terminalExpanded !== 'false' || snapshot.terminalBodyPresent) {
    throw new Error(
      'Compact dense conversation should keep Terminal collapsed.',
    );
  }

  if (snapshot.terminal.height < 44 || snapshot.terminal.height > 82) {
    throw new Error(
      `Compact terminal strip height is unexpected: ${snapshot.terminal.height}`,
    );
  }

  if (!snapshot.summaryVisibleBeforeAssistantScroll) {
    await writeFile(
      join(artifactDir, 'compact-summary-visibility-note.json'),
      `${JSON.stringify(
        {
          note: 'Compact height can require timeline scrolling; summary must remain bounded and scrollable.',
          preScroll: snapshot.preScroll,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  if (!snapshot.summaryContainedBeforeAssistantScroll) {
    throw new Error('Changed-files summary escaped the compact timeline.');
  }

  if (snapshot.composer.height > 154) {
    throw new Error(
      `Compact composer should not crowd the conversation: ${snapshot.composer.height}`,
    );
  }

  if (!snapshot.messageContained) {
    throw new Error('Dense assistant message escaped the compact timeline.');
  }

  if (!snapshot.actionsContained) {
    throw new Error('Assistant action row escaped the compact message.');
  }

  if (!snapshot.composerContained) {
    throw new Error('Composer escaped the compact timeline width.');
  }

  if (!snapshot.terminalDocked) {
    throw new Error('Collapsed terminal strip is not docked below composer.');
  }

  for (const expectedLabel of [
    'Open README.md:1',
    'Open packages/desktop/src/renderer/App.tsx:12:5',
    'Open .env.example',
    'Open Dockerfile',
    'Open docs/guide.mdx',
    'Open src/App.vue',
  ]) {
    if (!snapshot.fileReferenceLabels.includes(expectedLabel)) {
      throw new Error(
        `Compact dense assistant chips missing ${expectedLabel}: ${snapshot.fileReferenceLabels.join(
          ', ',
        )}`,
      );
    }
  }

  for (const expectedAction of [
    'Copy Response',
    'Retry Last Prompt',
    'Open Changes',
  ]) {
    if (!snapshot.actionLabels.includes(expectedAction)) {
      throw new Error(
        `Compact assistant actions missing ${expectedAction}: ${snapshot.actionLabels.join(
          ', ',
        )}`,
      );
    }
  }

  for (const [key, hasOverflow] of Object.entries(snapshot.overflow)) {
    if (hasOverflow) {
      throw new Error(`Compact layout element overflowed: ${key}`);
    }
  }

  for (const chipRect of snapshot.chipRects) {
    if (!chipRect) {
      throw new Error('Compact assistant chip geometry is missing.');
    }

    if (chipRect.width > 282) {
      throw new Error(
        `Compact assistant chip is too wide: ${JSON.stringify(chipRect)}`,
      );
    }

    if (
      chipRect.left < snapshot.message.left ||
      chipRect.right > snapshot.message.right + 1 ||
      chipRect.left < snapshot.timeline.left ||
      chipRect.right > snapshot.timeline.right + 1
    ) {
      throw new Error(
        `Compact assistant chip escaped the message: ${JSON.stringify(
          chipRect,
        )}`,
      );
    }
  }

  for (const actionRect of snapshot.actionRects) {
    if (!actionRect) {
      throw new Error('Compact assistant action geometry is missing.');
    }

    if (actionRect.width > 40 || actionRect.height > 40) {
      throw new Error(
        `Compact assistant action is too large: ${JSON.stringify(actionRect)}`,
      );
    }
  }
}

async function assertRetryDrafted(fileName) {
  const snapshot = await evaluate(`(() => {
    const messageField = document.querySelector('[aria-label="Message"]');
    return {
      composerValue: messageField?.value ?? '',
      bodyText: document.body.innerText,
      approvalCards: document.querySelectorAll(
        '[data-testid="conversation-approval-card"]'
      ).length,
      assistantMessages: document.querySelectorAll(
        '[data-testid="assistant-message"]'
      ).length
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.composerValue !== 'Please exercise command approval.') {
    throw new Error(
      `Retry should restore the last prompt into the composer: ${snapshot.composerValue}`,
    );
  }

  if (!snapshot.bodyText.includes('Restored last prompt to composer.')) {
    throw new Error('Retry should provide visible composer feedback.');
  }

  if (snapshot.approvalCards !== 0) {
    throw new Error('Retry should not auto-send a new approval request.');
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

async function assertCompactReviewDrawerLayout(fileName) {
  await waitFor(
    'compact review drawer viewport',
    async () => {
      const viewport = await evaluate(`({
        width: window.innerWidth,
        height: window.innerHeight
      })`);
      return (
        viewport.width >= 940 &&
        viewport.width <= 1000 &&
        viewport.height >= 600 &&
        viewport.height <= 680
      );
    },
    10_000,
  );

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
    const overflows = (selector) => {
      const element = document.querySelector(selector);
      return element ? element.scrollWidth > element.clientWidth + 4 : false;
    };
    const isHorizontallyContained = (child, parent, tolerance = 1) =>
      Boolean(
        child &&
        parent &&
        child.left >= parent.left - tolerance &&
        child.right <= parent.right + tolerance
      );
    const review = document.querySelector('[data-testid="review-panel"]');
    const changedFileRows = [
      ...document.querySelectorAll('.changed-files details')
    ].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        text: element.querySelector('summary')?.textContent.trim() ?? '',
        left: rect.left,
        right: rect.right,
        width: rect.width,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth
      };
    });
    const reviewButtons = [
      ...document.querySelectorAll(
        '[data-testid="review-panel"] button'
      )
    ].map((button) => ({
      label:
        button.getAttribute('aria-label') ||
        button.getAttribute('title') ||
        button.textContent.trim(),
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height
    }));

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      shell: rectFor('[data-testid="desktop-workspace"]'),
      sidebar: rectFor('[data-testid="project-sidebar"]'),
      topbar: rectFor('[data-testid="workspace-topbar"]'),
      grid: rectFor('[data-testid="workspace-grid"]'),
      chat: rectFor('[data-testid="chat-thread"]'),
      timeline: rectFor('.chat-timeline'),
      review: rectFor('[data-testid="review-panel"]'),
      reviewSummary: rectFor('.panel-review .review-summary'),
      reviewActions: rectFor('.review-actions'),
      changedFiles: rectFor('.changed-files'),
      firstChangedFile: rectFor('.changed-files details'),
      firstDiffHunk: rectFor('.diff-hunk'),
      firstDiffPre: rectFor('.diff-hunk pre'),
      commitBox: rectFor('.commit-box'),
      settings: rectFor('[data-testid="settings-page"]'),
      composer: rectFor('[data-testid="message-composer"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      terminalBody: rectFor('[data-testid="terminal-body"]'),
      terminalExpanded:
        document
          .querySelector('[data-testid="terminal-toggle"]')
          ?.getAttribute('aria-expanded') ?? null,
      reviewScroll: review
        ? {
            clientHeight: review.clientHeight,
            scrollHeight: review.scrollHeight,
            scrollTop: review.scrollTop
          }
        : null,
      topbarActions: Array.from(
        document.querySelectorAll(
          '[data-testid="workspace-topbar"] .topbar-icon-button'
        )
      ).map((button) => ({
        label: button.getAttribute('aria-label') || '',
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height
      })),
      reviewButtons,
      changedFileRows,
      composerTextareaHeight:
        document
          .querySelector('[aria-label="Message"]')
          ?.getBoundingClientRect().height ?? null,
      overflow: {
        shell: overflows('[data-testid="desktop-workspace"]'),
        topbar: overflows('[data-testid="workspace-topbar"]'),
        grid: overflows('[data-testid="workspace-grid"]'),
        chat: overflows('[data-testid="chat-thread"]'),
        timeline: overflows('.chat-timeline'),
        review: overflows('[data-testid="review-panel"]'),
        reviewSummary: overflows('.panel-review .review-summary'),
        reviewActions: overflows('.review-actions'),
        changedFiles: overflows('.changed-files'),
        firstChangedFile: overflows('.changed-files details'),
        firstDiffHunk: overflows('.diff-hunk'),
        firstDiffPre: overflows('.diff-hunk pre'),
        commitBox: overflows('.commit-box'),
        composer: overflows('[data-testid="message-composer"]'),
        composerContext: overflows('.composer-context'),
        composerActions: overflows('.composer-actions')
      },
      containment: {
        reviewWidthInGrid: isHorizontallyContained(
          rectFor('[data-testid="review-panel"]'),
          rectFor('[data-testid="workspace-grid"]')
        ),
        chatWidthInGrid: isHorizontallyContained(
          rectFor('[data-testid="chat-thread"]'),
          rectFor('[data-testid="workspace-grid"]')
        ),
        composerWidthInChat: isHorizontallyContained(
          rectFor('[data-testid="message-composer"]'),
          rectFor('[data-testid="chat-thread"]')
        ),
        summaryWidthInReview: isHorizontallyContained(
          rectFor('.panel-review .review-summary'),
          rectFor('[data-testid="review-panel"]')
        ),
        commitBoxWidthInReview: isHorizontallyContained(
          rectFor('.commit-box'),
          rectFor('[data-testid="review-panel"]')
        )
      },
      hasSegmentedTabs: document.querySelector('.topbar-nav') !== null,
      bodyText: document.body.innerText
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
    'timeline',
    'review',
    'reviewSummary',
    'reviewActions',
    'changedFiles',
    'firstChangedFile',
    'firstDiffHunk',
    'firstDiffPre',
    'commitBox',
    'composer',
    'terminal',
  ];
  const missing = requiredRects.filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(
      `Missing compact review drawer rects: ${missing.join(', ')}`,
    );
  }

  if (metrics.viewport.width < 940 || metrics.viewport.width > 1000) {
    throw new Error(
      `Compact review viewport width is unexpected: ${metrics.viewport.width}`,
    );
  }

  if (metrics.viewport.height < 600 || metrics.viewport.height > 680) {
    throw new Error(
      `Compact review viewport height is unexpected: ${metrics.viewport.height}`,
    );
  }

  if (metrics.document.bodyScrollWidth > metrics.viewport.width + 4) {
    throw new Error(
      `Compact review caused horizontal body overflow: ${JSON.stringify(
        metrics.document,
      )}`,
    );
  }

  if (metrics.document.bodyScrollHeight > metrics.viewport.height + 4) {
    throw new Error(
      `Compact review document should fit one viewport: ${JSON.stringify(
        metrics.document,
      )}`,
    );
  }

  if (metrics.settings !== null || metrics.hasSegmentedTabs) {
    throw new Error('Compact review should not render settings or tab chrome.');
  }

  if (metrics.sidebar.width < 232 || metrics.sidebar.width > 264) {
    throw new Error(
      `Compact review sidebar width should stay narrow: ${metrics.sidebar.width}`,
    );
  }

  if (metrics.topbar.height < 50 || metrics.topbar.height > 76) {
    throw new Error(
      `Compact review topbar height should stay slim: ${metrics.topbar.height}`,
    );
  }

  const topbarLabels = metrics.topbarActions.map((action) => action.label);
  for (const expectedLabel of [
    'Conversation',
    'Close Changes',
    'Refresh Git',
    'Settings',
  ]) {
    if (!topbarLabels.includes(expectedLabel)) {
      throw new Error(
        `Compact review missing topbar action ${expectedLabel}: ${topbarLabels.join(
          ', ',
        )}`,
      );
    }
  }

  const oversizedTopbarActions = metrics.topbarActions.filter(
    (action) => action.width > 40 || action.height > 40,
  );
  if (oversizedTopbarActions.length > 0) {
    throw new Error(
      `Compact review topbar actions are too large: ${JSON.stringify(
        oversizedTopbarActions,
      )}`,
    );
  }

  if (metrics.review.width < 292 || metrics.review.width > 332) {
    throw new Error(
      `Compact review drawer width is unexpected: ${metrics.review.width}`,
    );
  }

  if (metrics.chat.width <= metrics.review.width) {
    throw new Error(
      `Compact conversation should remain wider than review: chat=${metrics.chat.width}, review=${metrics.review.width}`,
    );
  }

  if (Math.abs(metrics.chat.top - metrics.review.top) > 1) {
    throw new Error('Compact review should align with conversation top.');
  }

  if (Math.abs(metrics.chat.bottom - metrics.review.bottom) > 1) {
    throw new Error('Compact review should share conversation height.');
  }

  if (metrics.terminalExpanded !== 'false' || metrics.terminalBody !== null) {
    throw new Error('Compact review should keep Terminal collapsed.');
  }

  if (metrics.terminal.height < 44 || metrics.terminal.height > 82) {
    throw new Error(
      `Compact review terminal strip height is unexpected: ${metrics.terminal.height}`,
    );
  }

  if (metrics.composer.height > 176) {
    throw new Error(
      `Compact review composer should stay bounded: ${metrics.composer.height}`,
    );
  }

  if (
    metrics.composerTextareaHeight === null ||
    metrics.composerTextareaHeight > 62
  ) {
    throw new Error(
      `Compact review textarea should stay short: ${metrics.composerTextareaHeight}`,
    );
  }

  for (const [key, contained] of Object.entries(metrics.containment)) {
    if (!contained) {
      throw new Error(`Compact review containment failed: ${key}`);
    }
  }

  for (const [key, hasOverflow] of Object.entries(metrics.overflow)) {
    if (hasOverflow) {
      throw new Error(`Compact review element overflowed: ${key}`);
    }
  }

  for (const row of metrics.changedFileRows) {
    if (row.scrollWidth > row.clientWidth + 4) {
      throw new Error(
        `Compact review changed-file row overflowed: ${JSON.stringify(row)}`,
      );
    }
    if (
      row.left < metrics.review.left - 1 ||
      row.right > metrics.review.right + 1
    ) {
      throw new Error(
        `Compact review changed-file row escaped drawer: ${JSON.stringify(
          row,
        )}`,
      );
    }
  }

  const labels = metrics.reviewButtons.map((button) => button.label);
  for (const expectedLabel of [
    'Discard All',
    'Stage All',
    'Open',
    'Discard File',
    'Stage File',
    'Discard Hunk',
    'Stage Hunk',
    'Add Comment',
    'Commit',
  ]) {
    if (!labels.includes(expectedLabel)) {
      throw new Error(
        `Compact review missing action ${expectedLabel}: ${labels.join(
          ', ',
        )}`,
      );
    }
  }

  if (!metrics.bodyText.includes('README.md')) {
    throw new Error('Compact review should show the changed README.md row.');
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

async function setElectronWindowBounds(targetId, bounds) {
  const windowCdp = browserCdp ?? cdp;
  let fallbackError = null;
  try {
    const { windowId } = await windowCdp.send('Browser.getWindowForTarget', {
      targetId,
    });
    await windowCdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' },
    });
    await windowCdp.send('Browser.setWindowBounds', {
      windowId,
      bounds,
    });
  } catch (error) {
    fallbackError = error instanceof Error ? error.message : String(error);
    await evaluate(`(() => {
      window.resizeTo(${bounds.width}, ${bounds.height});
      return true;
    })()`);
  }
  await waitFor(
    `Electron window bounds ${bounds.width}x${bounds.height}`,
    async () => {
      const viewport = await evaluate(`({
        width: window.innerWidth,
        height: window.innerHeight
      })`);
      return (
        viewport.width >= bounds.width - 24 &&
        viewport.width <= bounds.width + 24 &&
        viewport.height >= bounds.height - 40 &&
        viewport.height <= bounds.height + 40
      );
    },
    10_000,
  );
  if (fallbackError) {
    const viewport = await evaluate(`({
      width: window.innerWidth,
      height: window.innerHeight
    })`);
    await writeFile(
      join(
        artifactDir,
        `window-resize-fallback-${bounds.width}x${bounds.height}.json`,
      ),
      `${JSON.stringify(
        {
          requested: bounds,
          viewport,
          error: fallbackError,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
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
  browserCdp?.close();
  if (appProcess && !appProcess.killed) {
    appProcess.kill();
  }
}
