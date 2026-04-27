#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
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
const longPromptToken =
  'desktopE2ELongPromptSegment_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' +
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const commandApprovalPrompt = 'Please exercise command approval.';
const questionPrompt = `Please ask a user question. ${longPromptToken}`;
const compactThreadTitle = 'Review README.md after the failing test';
const noisyThreadTitleLeaks = [
  '/tmp/',
  '127.0.0.1',
  'local server',
  'local...',
  'session-e2e-deadbeef',
  'desktopE2EThreadTitleNoiseToken',
];

const consoleErrors = [];
const failedRequests = [];

let appProcess;
let browserCdp;
let cdp;
let artifactDir;
let workspaceDir;
let cleanWorkspaceDir;

async function main() {
  await assertBuiltDesktop();
  artifactDir = await createArtifactDir();
  workspaceDir = await createGitWorkspace();
  cleanWorkspaceDir = await createCleanGitWorkspace();
  const homeDir = await mkdtemp(join(tmpdir(), 'qwen-desktop-e2e-home-'));
  const runtimeDir = await mkdtemp(join(tmpdir(), 'qwen-desktop-e2e-runtime-'));
  const userDataDir = await mkdtemp(
    join(tmpdir(), 'qwen-desktop-e2e-user-data-'),
  );
  await seedMissingProviderSettings(homeDir);
  const cdpPort = await getFreePort();

  appProcess = launchDesktopApp({
    cdpPort,
    homeDir,
    runtimeDir,
    userDataDir,
    workspaceDirs: [workspaceDir, cleanWorkspaceDir],
  });

  let target = await connectDesktopCdp(cdpPort);
  await waitForText('Qwen Code');
  await waitForText('Connected');
  await assertWorkbenchLandmarks();
  await assertRalphWorkspaceLayout('initial-layout.json');
  await saveScreenshot('initial-workspace.png');

  await clickButtonUntilText('Open Project', 'desktop-e2e-workspace');
  await assertProjectComposerReady('project-composer.json');
  await assertComposerMissingProviderKeyShortcut(
    'composer-missing-provider-key-shortcut.json',
    'qwen-e2e-cdp',
  );
  await saveScreenshot('composer-missing-provider-key-shortcut.png');
  await clickButton('Configure models');
  await assertComposerModelSettingsShortcut(
    'composer-model-settings-shortcut.json',
  );
  await saveScreenshot('composer-model-settings-shortcut.png');
  await clickButton('Close Settings');
  await waitFor(
    'composer model settings drawer closed',
    async () =>
      evaluate(`(() => {
        return (
          !document.querySelector('[data-testid="settings-page"]') &&
          document.querySelector('[data-testid="chat-thread"]') !== null
        );
      })()`),
    5_000,
  );
  await waitForDirtyTopbarDiffStat();
  await clickButtonUntilText('Open Project', 'desktop-e2e-clean-workspace');
  await assertProjectSwitchCleanState('project-switch-clean-git-status.json');
  await saveScreenshot('project-switch-clean-git-status.png');
  await clickButton('desktop-e2e-workspace');
  await assertProjectSwitchDirtyState('project-switch-dirty-git-status.json');
  await saveScreenshot('project-switch-dirty-git-status.png');
  target = await relaunchDesktopApp({
    cdpPort,
    homeDir,
    runtimeDir,
    userDataDir,
    workspaceDirs: [workspaceDir, cleanWorkspaceDir],
  });
  await waitForSelector('[data-testid="desktop-workspace"]');
  await waitForText('Connected');
  await assertWorkbenchLandmarks();
  await assertProjectRelaunchPersistence(
    homeDir,
    'project-relaunch-persistence.json',
  );
  await saveScreenshot('project-relaunch-persistence.png');
  await assertDraftRuntimeControls(
    'draft-runtime-controls.json',
    'qwen-e2e-cdp',
    'default',
  );
  await setFieldByAriaLabel('Permission mode', 'auto-edit');
  await assertDraftRuntimeControls(
    'draft-runtime-controls-selected.json',
    'qwen-e2e-cdp',
    'auto-edit',
  );
  await saveScreenshot('draft-runtime-controls-selected.png');
  await setFieldByAriaLabel('Message', commandApprovalPrompt);
  await clickButton('Send');
  await waitForText('Approve Once');
  await assertDraftRuntimeApplied(
    'draft-runtime-controls-applied.json',
    'qwen-e2e-cdp',
    'auto-edit',
  );
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
  await setFieldByAriaLabel('Message', questionPrompt);
  await clickButton('Send');
  await waitForText('Pick the next review focus');
  await assertInlineQuestionCard('inline-question-card.json');
  await saveScreenshot('inline-question-card.png');
  await clickButton('Submit Question');
  await waitForText('E2E fake ACP question response recorded');
  await setElectronWindowBounds(target.id, compactWindowBounds);
  await assertCompactDenseConversationLayout('compact-dense-conversation.json');
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
  await clickButton('Models');
  await waitForSelector('[data-testid="settings-page"]');
  await assertSidebarModelsSettingsEntry('sidebar-models-settings-entry.json');
  await saveScreenshot('sidebar-models-settings-entry.png');
  await clickButton('Close Settings');
  await waitFor(
    'sidebar Models settings drawer closed',
    async () =>
      evaluate(`(() => {
        return (
          !document.querySelector('[data-testid="settings-page"]') &&
          document.querySelector('[data-testid="chat-thread"]') !== null
        );
      })()`),
    5_000,
  );
  await clickButton('Search');
  await waitForSelector('[data-testid="sidebar-search"]');
  await assertSidebarSearchFilter('sidebar-search-filter.json');
  await saveScreenshot('sidebar-search-filter.png');
  await assertTopbarContextFidelity('topbar-context-fidelity.json');
  await saveScreenshot('topbar-context-fidelity.png');
  await clickButton('Branch');
  await waitForSelector('[data-testid="branch-menu"]');
  await waitForSelector('[data-testid="branch-menu-row"]');
  await assertBranchSwitchMenu('branch-create-menu.json', longBranchName);
  await assertBranchCreateValidation('branch-create-validation.json');
  await saveScreenshot('branch-create-menu.png');
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
        const gitStatus = document.querySelector(
          '[data-testid="topbar-git-status"]'
        );
        return (
          !document.querySelector('[data-testid="discard-confirmation"]') &&
          gitStatus?.textContent.trim() === '+2 -1' &&
          gitStatus?.getAttribute('title') ===
            'Git status: 1 modified · 0 staged · 1 untracked · Diff +2 -1'
        );
      })()`),
    10_000,
  );
  await assertWorkspaceStillDirtyAfterDiscardCancel(
    'discard-cancel-git-status.txt',
  );
  await clickButton('Add Comment');
  await waitForSelector('[aria-label="Review comment for README.md"]');
  await assertReviewCommentEditorChrome('review-comment-editor-chrome.json');
  await setFieldByAriaLabel(
    'Review comment for README.md',
    'Review note from E2E',
  );
  await clickButton('Add Comment');
  await waitForText('Review note from E2E');
  await clickButton('Stage All');
  await assertReviewStageAllResult('review-stage-all-result.json');
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
  await assertSettingsLabelChromeRestraint(
    'settings-label-chrome-restraint.json',
  );
  await saveScreenshot('settings-page.png');
  await assertSettingsSectionRailNavigation(
    'settings-section-rail-navigation.json',
  );
  await setElectronWindowBounds(target.id, compactWindowBounds);
  await assertCompactSettingsOverlayLayout('compact-settings-overlay.json');
  await saveScreenshot('compact-settings-overlay.png');
  await setElectronWindowBounds(target.id, defaultWindowBounds);
  await assertSettingsProviderKeyGuidanceMissingAndReady(
    'settings-provider-key-guidance.json',
  );
  await assertSettingsValidation('settings-validation.json');
  await clickButton('Save');
  await waitForText('qwen-e2e-cdp');
  await assertSettingsSaveStatusFeedback('settings-save-status-feedback.json');
  await assertSettingsProviderKeyGuidanceConfigured(
    'settings-provider-key-guidance.json',
    'api-key',
  );
  await assertSettingsProductState('settings-product-state.json');
  await assertSettingsCodingPlanWorkflow('settings-coding-plan-provider.json');
  await assertSettingsProviderKeyGuidanceConfigured(
    'settings-provider-key-guidance.json',
    'coding-plan',
  );
  await saveScreenshot('settings-coding-plan-state.png');
  await assertSettingsPermissionsModelLabelRestraint(
    'settings-permissions-model-label-restraint.json',
  );
  await assertSettingsPermissionsProviderHealth(
    'settings-permissions-provider-health.json',
    'qwen-e2e-cdp',
  );
  await saveScreenshot('settings-permissions-provider-health.png');
  await saveScreenshot('settings-permissions-model-label-restraint.png');
  await clickButton('Advanced Diagnostics');
  await waitForSelector('[data-testid="runtime-diagnostics"]');
  await assertSettingsAdvancedDiagnostics('settings-advanced-diagnostics.json');

  await clickButton('Conversation');
  await waitForSelector('[data-testid="terminal-drawer"]');
  await clickButton('New Thread');
  await assertDraftComposerSavedModelState(
    'draft-composer-saved-model-state.json',
    'qwen-e2e-cdp',
  );
  await saveScreenshot('draft-composer-saved-model-state.png');
  await clickFirstThreadRow();
  await assertComposerModelSwitch('composer-model-switch.json', 'qwen-e2e-cdp');
  await assertComposerModelProviderHealth(
    'composer-model-provider-health.json',
    'qwen-e2e-cdp',
  );
  await saveScreenshot('composer-model-provider-health.png');
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
  await assertTerminalControlRowsContained('terminal-long-command-layout.json');
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
        cleanWorkspaceDir,
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
  const rawDir = await mkdtemp(join(tmpdir(), 'desktop-e2e-workspace-'));
  const dir = await realpath(rawDir);
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

async function createCleanGitWorkspace() {
  const rawDir = await mkdtemp(join(tmpdir(), 'desktop-e2e-clean-workspace-'));
  const dir = await realpath(rawDir);
  await writeFile(
    join(dir, 'README.md'),
    '# Desktop E2E Clean\n\ninitial\n',
    'utf8',
  );
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'desktop-e2e-clean-workspace' }, null, 2)}\n`,
    'utf8',
  );
  await execFileP('git', ['init'], { cwd: dir });
  await execFileP('git', ['config', 'user.email', 'desktop-e2e@example.test'], {
    cwd: dir,
  });
  await execFileP('git', ['config', 'user.name', 'Desktop E2E'], { cwd: dir });
  await execFileP('git', ['checkout', '-B', 'main'], { cwd: dir });
  await execFileP('git', ['add', '.'], { cwd: dir });
  await execFileP('git', ['commit', '-m', 'initial clean commit'], {
    cwd: dir,
  });
  return dir;
}

async function seedMissingProviderSettings(homeDir) {
  const settingsDir = join(homeDir, '.qwen');
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, 'settings.json'),
    `${JSON.stringify(
      {
        security: { auth: { selectedType: 'openai' } },
        model: { name: 'qwen-e2e-cdp' },
        modelProviders: {
          openai: [
            {
              id: 'qwen-e2e-cdp',
              name: 'qwen-e2e-cdp',
              baseUrl: 'https://example.invalid/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
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
  workspaceDirs,
}) {
  const logStream = createWriteStream(join(artifactDir, 'electron.log'), {
    flags: 'a',
  });
  logStream.write(
    `\n[desktop launch] ${new Date().toISOString()} cdp=${cdpPort}\n`,
  );
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
      QWEN_DESKTOP_TEST_SELECT_DIRECTORY: JSON.stringify(workspaceDirs),
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

async function connectDesktopCdp(cdpPort) {
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
  return target;
}

async function relaunchDesktopApp({
  cdpPort,
  homeDir,
  runtimeDir,
  userDataDir,
  workspaceDirs,
}) {
  cdp?.close();
  cdp = null;
  browserCdp?.close();
  browserCdp = null;
  await stopDesktopApp();
  appProcess = launchDesktopApp({
    cdpPort,
    homeDir,
    runtimeDir,
    userDataDir,
    workspaceDirs,
  });
  return connectDesktopCdp(cdpPort);
}

async function stopDesktopApp() {
  const child = appProcess;
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }

  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
  });
  child.kill();
  await Promise.race([exited, delay(5_000)]);
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
        const permission = document.querySelector('select[aria-label="Permission mode"]');
        const model = document.querySelector('select[aria-label="Model"]');
        return Boolean(
          textarea &&
          permission &&
          model &&
          !textarea.disabled &&
          !permission.disabled &&
          !model.disabled &&
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
    const composer = document.querySelector('[data-testid="message-composer"]');
    const attach = document.querySelector('[data-testid="composer-attach-button"]');
    const controlRow = document.querySelector('.composer-control-row');
    const context = document.querySelector('.composer-context');
    const actions = document.querySelector('.composer-actions');
    const chatHeader = document.querySelector('.chat-header');
    const chatStatus = document.querySelector('.chat-status-announcement');
    attach?.focus();
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        lineHeight: Number.parseFloat(style.lineHeight)
      };
    };
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    return {
      composerText: composer?.textContent.trim() ?? '',
      placeholder: textarea?.placeholder ?? null,
      textareaDisabled: textarea?.disabled ?? null,
      composerRect: rectFor(composer),
      textareaRect: rectFor(textarea),
      textareaStyle: styleFor(textarea),
      attachControl: {
        ariaLabel: attach?.getAttribute('aria-label') ?? null,
        ariaDisabled: attach?.getAttribute('aria-disabled') ?? null,
        describedBy: attach?.getAttribute('aria-describedby') ?? null,
        disabled: attach?.disabled ?? null,
        focused: document.activeElement === attach,
        hasIcon: attach?.querySelector('svg') !== null,
        helpText:
          document.getElementById(
            attach?.getAttribute('aria-describedby') ?? ''
          )?.textContent.trim() ?? '',
        rect: rectFor(attach),
        text: attach?.textContent.trim() ?? '',
        title: attach?.getAttribute('title') ?? null
      },
      controlRowRect: rectFor(controlRow),
      contextRect: rectFor(context),
      actionsRect: rectFor(actions),
      iconButtonRects: [...document.querySelectorAll('.composer-icon-button')]
        .map((button) => rectFor(button)),
      chipRects: [...document.querySelectorAll(
        '.composer-chip, .composer-context-note, .composer-disabled-reason'
      )].map((chip) => ({
        text: chip.textContent.trim(),
        rect: rectFor(chip),
        style: styleFor(chip)
      })),
      selectRects: [...document.querySelectorAll('.composer-select-label select')]
        .map((select) => ({
          label: select.getAttribute('aria-label') || '',
          title: select.getAttribute('title') || '',
          rect: rectFor(select),
          style: styleFor(select)
        })),
      selectControls: [...document.querySelectorAll(
        '[data-testid="composer-mode-control"], [data-testid="composer-model-control"]'
      )].map((control) => {
        const shell = control.querySelector('.composer-select-shell');
        const select = control.querySelector('select');
        return {
          testId: control.getAttribute('data-testid') || '',
          title: control.getAttribute('title') || '',
          selectLabel: select?.getAttribute('aria-label') || '',
          selectTitle: select?.getAttribute('title') || '',
          hasLeadingIcon:
            shell?.querySelector('.composer-select-leading-icon') !== null,
          hasChevron:
            shell?.querySelector('.composer-select-chevron') !== null,
          rect: rectFor(shell),
          selectRect: rectFor(select),
          style: styleFor(select),
          optionTexts: select
            ? [...select.options].map((option) => option.textContent.trim())
            : []
        };
      }),
      actionButtonRects: [...document.querySelectorAll('.composer-actions button')]
        .map((button) => ({
          label: button.getAttribute('aria-label') || button.textContent.trim(),
          title: button.getAttribute('title') || '',
          className: button.className,
          hasIcon: button.querySelector('svg') !== null,
          hasSrOnly: button.querySelector('.sr-only') !== null,
          directText: [...button.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent.trim())
            .join(''),
          disabled: button.disabled,
          rect: rectFor(button),
          style: styleFor(button)
        })),
      permissionDisabled: permission?.disabled ?? null,
      modelDisabled: model?.disabled ?? null,
      chatHeaderPresent: chatHeader !== null,
      chatStatusText: chatStatus?.textContent.trim() ?? '',
      overflows: {
        composer: overflows(composer),
        controlRow: overflows(controlRow),
        context: overflows(context),
        actions: overflows(actions)
      },
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

  if (
    snapshot.permissionDisabled !== false ||
    snapshot.modelDisabled !== false
  ) {
    throw new Error(
      'Project composer runtime selectors should be enabled before a session exists.',
    );
  }

  if (snapshot.chatHeaderPresent) {
    throw new Error('Project composer view should not render a chat header.');
  }

  if (!snapshot.chatStatusText.includes('Conversation')) {
    throw new Error(
      `Project composer view is missing the accessible chat status: ${snapshot.chatStatusText}`,
    );
  }

  if (
    snapshot.attachControl.ariaLabel !== 'Attach files' ||
    snapshot.attachControl.ariaDisabled !== 'true' ||
    snapshot.attachControl.disabled !== false ||
    snapshot.attachControl.describedBy !== 'composer-attachment-help' ||
    snapshot.attachControl.title !== 'Attachments are not available yet' ||
    !snapshot.attachControl.helpText.includes(
      'Attachments are not available yet.',
    ) ||
    !snapshot.attachControl.hasIcon ||
    !snapshot.attachControl.focused
  ) {
    throw new Error(
      `Composer attachment control semantics regressed: ${JSON.stringify(
        snapshot.attachControl,
      )}`,
    );
  }

  if (snapshot.attachControl.text.includes('+')) {
    throw new Error('Composer attachment control still exposes + placeholder.');
  }

  if (!snapshot.composerRect || !snapshot.textareaRect) {
    throw new Error(
      `Project composer density metrics are missing: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (snapshot.composerRect.width > 840 || snapshot.composerRect.height > 94) {
    throw new Error(
      `Project composer should stay compact before a thread exists: ${JSON.stringify(
        snapshot.composerRect,
      )}`,
    );
  }

  if (
    snapshot.textareaRect.height > 44 ||
    snapshot.textareaStyle?.fontSize > 13.2
  ) {
    throw new Error(
      `Project composer textarea scale regressed: ${JSON.stringify({
        rect: snapshot.textareaRect,
        style: snapshot.textareaStyle,
      })}`,
    );
  }

  for (const [key, hasOverflow] of Object.entries(snapshot.overflows)) {
    if (hasOverflow) {
      throw new Error(`Project composer overflowed: ${key}`);
    }
  }

  for (const rect of snapshot.iconButtonRects) {
    if (!rect || rect.width > 25 || rect.height > 25) {
      throw new Error(
        `Composer attach control should stay icon-sized: ${JSON.stringify(
          rect,
        )}`,
      );
    }
  }

  for (const chip of snapshot.chipRects) {
    if (!chip.rect || !chip.style) {
      throw new Error(
        `Composer chip metrics are missing: ${JSON.stringify(chip)}`,
      );
    }

    if (chip.rect.height > 25 || chip.style.fontSize > 11.2) {
      throw new Error(`Composer chip scale regressed: ${JSON.stringify(chip)}`);
    }
  }

  for (const select of snapshot.selectRects) {
    if (!select.rect || !select.style) {
      throw new Error(
        `Composer select metrics are missing: ${JSON.stringify(select)}`,
      );
    }

    if (select.rect.height > 25 || select.style.fontSize > 11.2) {
      throw new Error(
        `Composer select scale regressed: ${JSON.stringify(select)}`,
      );
    }
  }

  if (snapshot.selectControls.length !== 2) {
    throw new Error(
      `Composer runtime controls are missing: ${JSON.stringify(
        snapshot.selectControls,
      )}`,
    );
  }

  for (const control of snapshot.selectControls) {
    if (
      !control.title ||
      control.title !== control.selectTitle ||
      !control.hasLeadingIcon ||
      !control.hasChevron ||
      !control.rect ||
      !control.selectRect ||
      !control.style
    ) {
      throw new Error(
        `Composer runtime control shell regressed: ${JSON.stringify(control)}`,
      );
    }

    if (
      control.rect.width > 128 ||
      control.rect.height > 25 ||
      control.selectRect.height > 25 ||
      control.style.fontSize > 11.2
    ) {
      throw new Error(
        `Composer runtime control scale regressed: ${JSON.stringify(control)}`,
      );
    }
  }

  const actionByLabel = new Map(
    snapshot.actionButtonRects.map((button) => [button.label, button]),
  );
  const stopAction = actionByLabel.get('Stop');
  const sendAction = actionByLabel.get('Send');
  if (!stopAction || !sendAction) {
    throw new Error(
      `Composer actions are missing Stop/Send controls: ${JSON.stringify(
        snapshot.actionButtonRects,
      )}`,
    );
  }

  for (const [label, expected] of [
    ['Stop', { title: 'Stop generation', disabled: true }],
    ['Send', { title: 'Send message', disabled: true }],
  ]) {
    const button = actionByLabel.get(label);
    if (
      !button ||
      button.title !== expected.title ||
      button.disabled !== expected.disabled ||
      !button.hasIcon ||
      !button.hasSrOnly ||
      button.directText !== '' ||
      !button.className.includes('composer-action-button')
    ) {
      throw new Error(
        `Composer ${label} control is not icon-led and accessible: ${JSON.stringify(
          button,
        )}`,
      );
    }
  }

  for (const button of snapshot.actionButtonRects) {
    if (!button.rect || !button.style) {
      throw new Error(
        `Composer action metrics are missing: ${JSON.stringify(button)}`,
      );
    }

    if (button.rect.width > 32 || button.rect.height > 32) {
      throw new Error(
        `Composer action scale regressed: ${JSON.stringify(button)}`,
      );
    }
  }
}

async function assertDraftRuntimeControls(fileName, modelId, modeId) {
  await waitFor(
    'draft runtime controls',
    async () =>
      evaluate(`(() => {
        const permission = document.querySelector('select[aria-label="Permission mode"]');
        const model = document.querySelector('select[aria-label="Model"]');
        return Boolean(
          permission &&
          model &&
          !permission.disabled &&
          !model.disabled &&
          permission.value === ${JSON.stringify(modeId)} &&
          model.value === ${JSON.stringify(modelId)} &&
          document.body.innerText.includes('New thread')
        );
      })()`),
    10_000,
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
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const composer = document.querySelector('[data-testid="message-composer"]');
    const permission = document.querySelector('select[aria-label="Permission mode"]');
    const model = document.querySelector('select[aria-label="Model"]');
    const modelControl = document.querySelector(
      '[data-testid="composer-model-control"]'
    );
    const permissionControl = document.querySelector(
      '[data-testid="composer-mode-control"]'
    );
    const providerStatus = document.querySelector(
      '[data-testid="composer-model-provider-status"]'
    );
    const selectedModel = model
      ? [...model.options].find((option) => option.selected)
      : null;
    const bodyText = document.body.innerText;
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      permissionDisabled: permission?.disabled ?? null,
      permissionValue: permission?.value ?? null,
      permissionTitle: permission?.getAttribute('title') ?? null,
      permissionOptions: permission
        ? [...permission.options].map((option) => ({
            value: option.value,
            text: option.textContent.trim(),
            title: option.getAttribute('title') ?? ''
          }))
        : [],
      modelDisabled: model?.disabled ?? null,
      modelValue: model?.value ?? null,
      modelTitle: model?.getAttribute('title') ?? null,
      modelOptions: model
        ? [...model.options].map((option) => ({
            value: option.value,
            text: option.textContent.trim(),
            title: option.getAttribute('title') ?? '',
            selected: option.selected
          }))
        : [],
      modelGroups: model
        ? [...model.querySelectorAll('optgroup')].map((group) => ({
            label: group.label,
            values: [...group.querySelectorAll('option')].map(
              (option) => option.value
            )
          }))
        : [],
      selectedModelText: selectedModel?.textContent.trim() ?? null,
      selectedModelTitle: selectedModel?.getAttribute('title') ?? null,
      providerStatusLabel:
        providerStatus?.getAttribute('aria-label') ?? null,
      providerStatusClass: providerStatus?.className ?? '',
      hasNewThreadNotice: bodyText.includes('New thread'),
      hasRawCodingPlanLabel:
        bodyText.includes('ModelStudio Coding Plan') ||
        (selectedModel?.textContent ?? '').includes('ModelStudio Coding Plan'),
      hasSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      composerRect: rectFor(composer),
      permissionControlRect: rectFor(permissionControl),
      modelControlRect: rectFor(modelControl),
      permissionRect: rectFor(permission),
      modelRect: rectFor(model),
      composerOverflow: overflows(composer),
      permissionOverflow: overflows(permissionControl),
      modelOverflow: overflows(modelControl),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    snapshot.permissionDisabled !== false ||
    snapshot.modelDisabled !== false ||
    snapshot.permissionValue !== modeId ||
    snapshot.modelValue !== modelId
  ) {
    throw new Error(
      `Draft runtime controls did not keep the selected values: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  const modeValues = snapshot.permissionOptions.map((option) => option.value);
  if (
    !['default', 'auto-edit', 'plan', 'yolo'].every((value) =>
      modeValues.includes(value),
    )
  ) {
    throw new Error(
      `Draft permission mode options are incomplete: ${JSON.stringify(
        snapshot.permissionOptions,
      )}`,
    );
  }

  if (
    !snapshot.modelGroups.some(
      (group) =>
        group.label === 'Saved providers' && group.values.includes(modelId),
    ) ||
    snapshot.selectedModelText !== modelId ||
    snapshot.providerStatusLabel !==
      'Saved API key provider · API key missing' ||
    !snapshot.providerStatusClass.includes('composer-model-status-missing')
  ) {
    throw new Error(
      `Draft model control lost saved-provider metadata: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.hasRawCodingPlanLabel ||
    snapshot.hasSecret ||
    snapshot.hasServerUrl ||
    snapshot.documentOverflow ||
    snapshot.composerOverflow ||
    snapshot.permissionOverflow ||
    snapshot.modelOverflow
  ) {
    throw new Error(
      `Draft runtime controls leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.composerRect ||
    !snapshot.permissionControlRect ||
    !snapshot.modelControlRect ||
    !snapshot.permissionRect ||
    !snapshot.modelRect ||
    snapshot.permissionControlRect.width > 128 ||
    snapshot.modelControlRect.width > 128 ||
    snapshot.permissionRect.height > 25 ||
    snapshot.modelRect.height > 25 ||
    snapshot.composerRect.height > 94
  ) {
    throw new Error(
      `Draft runtime control geometry regressed: ${JSON.stringify(snapshot)}`,
    );
  }
}

async function assertDraftRuntimeApplied(fileName, modelId, modeId) {
  await waitFor(
    'draft runtime controls applied to active session',
    async () =>
      evaluate(`(() => {
        const permission = document.querySelector('select[aria-label="Permission mode"]');
        const model = document.querySelector('select[aria-label="Model"]');
        return Boolean(
          permission &&
          model &&
          !permission.disabled &&
          !model.disabled &&
          permission.value === ${JSON.stringify(modeId)} &&
          model.value === ${JSON.stringify(modelId)} &&
          document.body.innerText.includes('Approve Once')
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
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const composer = document.querySelector('[data-testid="message-composer"]');
    const permission = document.querySelector('select[aria-label="Permission mode"]');
    const model = document.querySelector('select[aria-label="Model"]');
    const modelControl = document.querySelector(
      '[data-testid="composer-model-control"]'
    );
    const providerStatus = document.querySelector(
      '[data-testid="composer-model-provider-status"]'
    );
    const selectedModel = model
      ? [...model.options].find((option) => option.selected)
      : null;
    const bodyText = document.body.innerText;
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      permissionDisabled: permission?.disabled ?? null,
      permissionValue: permission?.value ?? null,
      permissionTitle: permission?.getAttribute('title') ?? null,
      modelDisabled: model?.disabled ?? null,
      modelValue: model?.value ?? null,
      modelTitle: model?.getAttribute('title') ?? null,
      selectedModelText: selectedModel?.textContent.trim() ?? null,
      selectedModelTitle: selectedModel?.getAttribute('title') ?? null,
      providerStatusLabel:
        providerStatus?.getAttribute('aria-label') ?? null,
      providerStatusClass: providerStatus?.className ?? '',
      hasApproval: bodyText.includes('Approve Once'),
      hasNewThreadNotice: bodyText.includes('New thread'),
      hasSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      composerRect: rectFor(composer),
      modelControlRect: rectFor(modelControl),
      modelRect: rectFor(model),
      composerOverflow: overflows(composer),
      modelOverflow: overflows(modelControl),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    snapshot.permissionDisabled !== false ||
    snapshot.modelDisabled !== false ||
    snapshot.permissionValue !== modeId ||
    snapshot.modelValue !== modelId ||
    !snapshot.hasApproval ||
    snapshot.hasNewThreadNotice
  ) {
    throw new Error(
      `Draft runtime choices were not applied to the active session: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.providerStatusLabel !==
      'Saved API key provider · API key missing' ||
    !snapshot.providerStatusClass.includes('composer-model-status-missing') ||
    snapshot.selectedModelText !== modelId ||
    !snapshot.selectedModelTitle?.includes('API key missing')
  ) {
    throw new Error(
      `Applied draft model lost provider health metadata: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.hasSecret ||
    snapshot.hasServerUrl ||
    snapshot.documentOverflow ||
    snapshot.composerOverflow ||
    snapshot.modelOverflow
  ) {
    throw new Error(
      `Applied draft runtime state leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.composerRect ||
    !snapshot.modelControlRect ||
    !snapshot.modelRect ||
    snapshot.modelControlRect.width > 128 ||
    snapshot.modelRect.height > 25 ||
    snapshot.composerRect.height > 94
  ) {
    throw new Error(
      `Applied draft runtime geometry regressed: ${JSON.stringify(snapshot)}`,
    );
  }
}

async function assertComposerMissingProviderKeyShortcut(fileName, modelId) {
  const expectedStatus = 'Saved API key provider · API key missing';
  const expectedTitle = `${modelId} · ${expectedStatus}`;

  await waitFor(
    'composer missing provider key shortcut',
    async () =>
      evaluate(`(() => {
        const control = document.querySelector(
          '[data-testid="composer-model-control"]'
        );
        const select = control?.querySelector('select[aria-label="Model"]');
        const dot = control?.querySelector(
          '[data-testid="composer-model-provider-status"]'
        );
        const shortcut = document.querySelector(
          '[data-testid="composer-model-settings-button"]'
        );
        return Boolean(
          control &&
          select &&
          dot &&
          shortcut &&
          select.value === ${JSON.stringify(modelId)} &&
          select.getAttribute('title') === ${JSON.stringify(expectedTitle)} &&
          dot.getAttribute('aria-label') === ${JSON.stringify(expectedStatus)} &&
          shortcut.getAttribute('aria-label') === 'Configure models' &&
          shortcut.getAttribute('title') ===
            'Configure models - API key missing'
        );
      })()`),
    10_000,
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height)
      };
    };
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const composer = document.querySelector('[data-testid="message-composer"]');
    const control = document.querySelector(
      '[data-testid="composer-model-control"]'
    );
    const select = control?.querySelector('select[aria-label="Model"]');
    const dot = control?.querySelector(
      '[data-testid="composer-model-provider-status"]'
    );
    const shortcut = document.querySelector(
      '[data-testid="composer-model-settings-button"]'
    );
    const selected = select
      ? [...select.options].find((option) => option.selected)
      : null;
    const bodyText = document.body.innerText;
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      composerRect: rectFor(composer),
      controlRect: rectFor(control),
      selectRect: rectFor(select),
      dotRect: rectFor(dot),
      shortcutRect: rectFor(shortcut),
      shortcutStyle: styleFor(shortcut),
      controlTitle: control?.getAttribute('title') ?? null,
      selectTitle: select?.getAttribute('title') ?? null,
      selectValue: select?.value ?? null,
      selectDisabled: select?.disabled ?? null,
      selectedText: selected?.textContent.trim() ?? null,
      selectedTitle: selected?.getAttribute('title') ?? null,
      dotAriaLabel: dot?.getAttribute('aria-label') ?? null,
      dotClass: dot?.className ?? '',
      shortcutAriaLabel: shortcut?.getAttribute('aria-label') ?? null,
      shortcutTitle: shortcut?.getAttribute('title') ?? null,
      shortcutClass: shortcut?.className ?? '',
      shortcutHasIcon: shortcut?.querySelector('svg') !== null,
      shortcutDirectText: [...(shortcut?.childNodes ?? [])]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .join(''),
      composerOverflow: overflows(composer),
      controlOverflow: overflows(control),
      shortcutOverflow: overflows(shortcut),
      hasRawCodingPlanLabel:
        (selected?.textContent ?? '').includes('ModelStudio Coding Plan'),
      hasSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    snapshot.controlTitle !== expectedTitle ||
    snapshot.selectTitle !== expectedTitle ||
    snapshot.selectedTitle !== expectedTitle ||
    snapshot.selectValue !== modelId ||
    snapshot.selectDisabled !== false ||
    snapshot.dotAriaLabel !== expectedStatus ||
    !snapshot.dotClass.includes('composer-model-status-missing')
  ) {
    throw new Error(
      `Composer missing provider metadata is not visible: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.shortcutAriaLabel !== 'Configure models' ||
    snapshot.shortcutTitle !== 'Configure models - API key missing' ||
    !snapshot.shortcutClass.includes('composer-model-settings-button') ||
    !snapshot.shortcutClass.includes(
      'composer-model-settings-button-warning',
    ) ||
    !snapshot.shortcutHasIcon ||
    snapshot.shortcutDirectText !== ''
  ) {
    throw new Error(
      `Composer missing provider shortcut is not actionable: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.composerRect ||
    !snapshot.controlRect ||
    !snapshot.selectRect ||
    !snapshot.dotRect ||
    !snapshot.shortcutRect ||
    !snapshot.shortcutStyle ||
    snapshot.controlRect.width > 128 ||
    snapshot.selectRect.height > 25 ||
    snapshot.shortcutRect.width > 25 ||
    snapshot.shortcutRect.height > 25 ||
    snapshot.shortcutStyle.width > 25 ||
    snapshot.shortcutStyle.height > 25
  ) {
    throw new Error(
      `Composer missing provider shortcut geometry regressed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.hasRawCodingPlanLabel ||
    snapshot.hasSecret ||
    snapshot.hasServerUrl ||
    snapshot.documentOverflow ||
    snapshot.composerOverflow ||
    snapshot.controlOverflow ||
    snapshot.shortcutOverflow
  ) {
    throw new Error(
      `Composer missing provider shortcut leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function assertComposerModelSettingsShortcut(fileName) {
  await waitFor(
    'composer Configure models opens focused model provider settings',
    async () =>
      evaluate(`(() => {
        const settings = document.querySelector('[data-testid="settings-page"]');
        const provider = document.querySelector(
          '[data-testid="settings-provider-select"]'
        );
        return (
          settings?.getAttribute('data-initial-section') ===
            'settings-model-providers' &&
          provider !== null &&
          document.activeElement === provider
        );
      })()`),
    5_000,
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        lineHeight: Number.parseFloat(style.lineHeight)
      };
    };
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const composer = document.querySelector('[data-testid="message-composer"]');
    const shortcut = document.querySelector(
      '[data-testid="composer-model-settings-button"]'
    );
    const settings = document.querySelector('[data-testid="settings-page"]');
    const overlay = document.querySelector('[data-testid="settings-overlay"]');
    const provider = document.querySelector(
      '[data-testid="settings-provider-select"]'
    );
    const modelConfig = document.querySelector('[data-testid="model-config"]');
    const chatThread = document.querySelector('[data-testid="chat-thread"]');
    const runtime = document.querySelector('[data-testid="runtime-diagnostics"]');
    const settingsText = settings?.innerText ?? '';
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      initialSection:
        settings?.getAttribute('data-initial-section') ?? null,
      settingsRole: settings?.getAttribute('role') ?? null,
      settingsModal: settings?.getAttribute('aria-modal') ?? null,
      settingsRect: rectFor(settings),
      overlayRect: rectFor(overlay),
      modelConfigRect: rectFor(modelConfig),
      chatThreadRect: rectFor(chatThread),
      providerLabel: provider?.getAttribute('aria-label') ?? null,
      providerFocused: document.activeElement === provider,
      providerRect: rectFor(provider),
      providerStyle: styleFor(provider),
      runtimeDiagnosticsPresent: runtime !== null,
      shortcut: {
        ariaLabel: shortcut?.getAttribute('aria-label') ?? null,
        title: shortcut?.getAttribute('title') ?? null,
        className: shortcut?.className ?? '',
        hasIcon: shortcut?.querySelector('svg') !== null,
        directText: [...(shortcut?.childNodes ?? [])]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(''),
        rect: rectFor(shortcut),
        style: styleFor(shortcut),
        overflows: overflows(shortcut)
      },
      composerRect: rectFor(composer),
      composerOverflow: overflows(composer),
      settingsText,
      visibleSecret:
        settingsText.includes('sk-desktop-e2e') ||
        settingsText.includes('cp-desktop-e2e'),
      hasAnySecret:
        settingsText.includes('sk-desktop-e2e') ||
        settingsText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4,
      settingsOverflow: overflows(settings)
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.initialSection !== 'settings-model-providers') {
    throw new Error(
      `Composer Configure models should target Model Providers settings: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.settingsRole !== 'dialog' ||
    snapshot.settingsModal !== 'true' ||
    !snapshot.settingsRect ||
    !snapshot.overlayRect ||
    !snapshot.chatThreadRect
  ) {
    throw new Error(
      `Composer Configure models did not open the settings drawer over conversation: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.providerLabel !== 'Model provider' ||
    !snapshot.providerFocused ||
    !snapshot.providerRect ||
    snapshot.providerStyle?.fontSize > 14.5
  ) {
    throw new Error(
      `Composer Configure models did not focus the compact provider selector: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (!snapshot.modelConfigRect || !snapshot.settingsRect) {
    throw new Error(
      `Composer Configure models is missing model provider geometry: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  const modelConfigVisible =
    snapshot.modelConfigRect.bottom > snapshot.settingsRect.top &&
    snapshot.modelConfigRect.top < snapshot.settingsRect.bottom;
  if (!modelConfigVisible) {
    throw new Error(
      `Model Providers section is not visible from composer shortcut: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  const shortcutTitleAllowed =
    snapshot.shortcut.title === 'Configure models' ||
    snapshot.shortcut.title === 'Configure models - API key missing';
  if (
    snapshot.shortcut.ariaLabel !== 'Configure models' ||
    !shortcutTitleAllowed ||
    !snapshot.shortcut.className.includes('composer-icon-button') ||
    (snapshot.shortcut.title === 'Configure models - API key missing' &&
      !snapshot.shortcut.className.includes(
        'composer-model-settings-button-warning',
      )) ||
    !snapshot.shortcut.hasIcon ||
    snapshot.shortcut.directText !== '' ||
    !snapshot.shortcut.rect ||
    snapshot.shortcut.rect.width > 25 ||
    snapshot.shortcut.rect.height > 25 ||
    snapshot.shortcut.overflows
  ) {
    throw new Error(
      `Composer Configure models shortcut should stay icon-led and compact: ${JSON.stringify(
        snapshot.shortcut,
      )}`,
    );
  }

  if (
    snapshot.runtimeDiagnosticsPresent ||
    snapshot.settingsText.includes('Server URL') ||
    snapshot.settingsText.includes('ACP Not started') ||
    snapshot.settingsText.includes('Node') ||
    snapshot.visibleSecret ||
    snapshot.hasAnySecret ||
    snapshot.documentOverflow ||
    snapshot.settingsOverflow ||
    snapshot.composerOverflow
  ) {
    throw new Error(
      `Composer Configure models exposed diagnostics, secrets, or overflow: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function assertRalphWorkspaceLayout(fileName) {
  const expectInitialEmptyState = fileName === 'initial-layout.json';
  const metrics = await evaluate(`(() => {
    const rectForElement = (element) => {
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
    const rectFor = (selector) => rectForElement(document.querySelector(selector));
    const alphaFromColor = (color) => {
      if (!color || color === 'transparent') {
        return 0;
      }
      const match = color.match(/rgba?\\(([^)]+)\\)/u);
      if (!match) {
        return 1;
      }
      const parts = match[1].split(',').map((part) => part.trim());
      return parts.length < 4 ? 1 : Number.parseFloat(parts[3]);
    };
    const styleForElement = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        color: style.color,
        colorAlpha: alphaFromColor(style.color),
        backgroundAlpha: alphaFromColor(style.backgroundColor),
        backgroundImage: style.backgroundImage,
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        lineHeight: Number.parseFloat(style.lineHeight),
        opacity: Number.parseFloat(style.opacity),
        textTransform: style.textTransform
      };
    };
    const styleFor = (selector) =>
      styleForElement(document.querySelector(selector));
    const overflows = (selector) => {
      const element = document.querySelector(selector);
      return Boolean(element && element.scrollWidth > element.clientWidth + 4);
    };
    const overflowsElement = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const emptyState = document.querySelector(
      '[data-testid="conversation-empty"]'
    );
    const emptyStateLabel = emptyState?.firstElementChild ?? emptyState;
    const disabledReason = document.querySelector(
      '[data-testid="composer-disabled-reason"]'
    );

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
      terminalProject: rectFor('[data-testid="terminal-strip-project"]'),
      terminalStatus: rectFor('[data-testid="terminal-strip-status"]'),
      terminalPreview: rectFor('[data-testid="terminal-strip-preview"]'),
      emptyState: {
        text: emptyState?.textContent.trim() ?? null,
        rect: rectForElement(emptyState),
        style: styleForElement(emptyState),
        labelRect: rectForElement(emptyStateLabel),
        labelStyle: styleForElement(emptyStateLabel)
      },
      disabledComposerReason: {
        text: disabledReason?.textContent.trim() ?? null,
        rect: rectForElement(disabledReason),
        style: styleForElement(disabledReason),
        overflows: overflowsElement(disabledReason)
      },
      composerActionButtons: [
        ...document.querySelectorAll('.composer-actions button')
      ].map((button) => ({
        label: button.getAttribute('aria-label') || '',
        disabled: button.disabled,
        className: button.className,
        rect: rectForElement(button),
        style: styleForElement(button)
      })),
      sidebarActionRows: [
        ...document.querySelectorAll('.sidebar-action-row')
      ].map((row) => ({
        text: row.textContent.trim(),
        rect: rectForElement(row),
        style: styleForElement(row),
        overflows: overflowsElement(row)
      })),
      sidebarHeadingStyles: [
        ...document.querySelectorAll('.sidebar-section-heading h2')
      ].map((heading) => styleForElement(heading)),
      sidebarHeadingCountStyles: [
        ...document.querySelectorAll('.sidebar-section-count')
      ].map((count) => styleForElement(count)),
      sidebarEmptyRows: [...document.querySelectorAll('.empty-row')].map(
        (row) => ({
          text: row.textContent.trim(),
          rect: rectForElement(row),
          style: styleForElement(row),
          overflows: overflowsElement(row)
        })
      ),
      topbarTitleHeadingStyle: styleFor('[data-testid="topbar-title"] h2'),
      topbarTitleProjectStyle: styleFor('[data-testid="topbar-title"] span'),
      topbarContextStyles: [
        ...document.querySelectorAll('.topbar-context-item')
      ].map((item) => styleForElement(item)),
      runtimeStatusStyle: styleFor('[data-testid="topbar-runtime-status"]'),
      terminalStatusStyle: styleFor(
        '[data-testid="terminal-strip-status"]'
      ),
      terminalVisibleLabelText:
        document
          .querySelector('[data-testid="terminal-toggle"] .message-role')
          ?.textContent.trim() ?? null,
      terminalExpanded:
        document
          .querySelector('[data-testid="terminal-toggle"]')
          ?.getAttribute('aria-expanded') ?? null,
      terminalOverflow: {
        toggle: overflows('[data-testid="terminal-toggle"]')
      },
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
  if (expectInitialEmptyState) {
    if (
      metrics.emptyState.text !== 'Open a project to start' ||
      !metrics.emptyState.rect ||
      !metrics.emptyState.style ||
      !metrics.emptyState.labelRect ||
      !metrics.emptyState.labelStyle
    ) {
      throw new Error(
        `Initial empty state is missing or changed: ${JSON.stringify(
          metrics.emptyState,
        )}`,
      );
    }

    if (
      metrics.emptyState.labelStyle.fontSize > 12.2 ||
      metrics.emptyState.labelStyle.fontWeight > 620 ||
      metrics.emptyState.labelStyle.colorAlpha > 0.58
    ) {
      throw new Error(
        `Initial empty state should stay visually quiet: ${JSON.stringify(
          metrics.emptyState,
        )}`,
      );
    }

    if (metrics.emptyState.labelRect.bottom < metrics.composer.top - 48) {
      throw new Error(
        `Initial empty state should sit near the composer instead of centered high in the canvas: ${JSON.stringify(
          {
            emptyState: metrics.emptyState.labelRect,
            composer: metrics.composer,
          },
        )}`,
      );
    }

    if (
      metrics.disabledComposerReason.text !== 'Open a project to start' ||
      !metrics.disabledComposerReason.rect ||
      !metrics.disabledComposerReason.style ||
      metrics.disabledComposerReason.overflows ||
      metrics.disabledComposerReason.rect.height > 24 ||
      metrics.disabledComposerReason.style.fontSize > 10.8 ||
      metrics.disabledComposerReason.style.fontWeight > 640 ||
      metrics.disabledComposerReason.style.colorAlpha > 0.62 ||
      metrics.disabledComposerReason.style.backgroundAlpha > 0.08
    ) {
      throw new Error(
        `Disabled composer reason should stay present, muted, and compact: ${JSON.stringify(
          metrics.disabledComposerReason,
        )}`,
      );
    }

    const disabledSend = metrics.composerActionButtons.find(
      (button) => button.label === 'Send',
    );
    if (
      !disabledSend ||
      !disabledSend.disabled ||
      !disabledSend.className.includes('composer-send-button') ||
      !disabledSend.style ||
      disabledSend.style.backgroundImage !== 'none' ||
      disabledSend.style.backgroundAlpha > 0.08 ||
      disabledSend.style.opacity < 0.68
    ) {
      throw new Error(
        `Initial disabled send action should be neutral, not primary blue: ${JSON.stringify(
          disabledSend,
        )}`,
      );
    }
  }

  const heavySidebarActions = metrics.sidebarActionRows.filter(
    (row) =>
      !row.style ||
      row.style.fontSize > 11.2 ||
      row.style.fontWeight > 600 ||
      row.overflows,
  );
  if (heavySidebarActions.length > 0) {
    throw new Error(
      `Initial sidebar actions are too heavy: ${JSON.stringify(
        heavySidebarActions,
      )}`,
    );
  }

  const heavySidebarHeadings = metrics.sidebarHeadingStyles.filter(
    (style) =>
      !style ||
      style.textTransform !== 'none' ||
      style.fontSize > 10.3 ||
      style.fontWeight > 680,
  );
  if (heavySidebarHeadings.length > 0) {
    throw new Error(
      `Initial sidebar headings are too heavy: ${JSON.stringify(
        heavySidebarHeadings,
      )}`,
    );
  }

  const heavySidebarHeadingCounts = metrics.sidebarHeadingCountStyles.filter(
    (style) =>
      !style ||
      style.textTransform !== 'none' ||
      style.fontSize > 9.8 ||
      style.fontWeight > 640,
  );
  if (heavySidebarHeadingCounts.length > 0) {
    throw new Error(
      `Initial sidebar heading counts are too heavy: ${JSON.stringify(
        heavySidebarHeadingCounts,
      )}`,
    );
  }

  const heavySidebarEmptyRows = metrics.sidebarEmptyRows.filter(
    (row) =>
      !row.style ||
      row.style.fontSize > 11 ||
      row.style.fontWeight > 580 ||
      row.overflows,
  );
  if (heavySidebarEmptyRows.length > 0) {
    throw new Error(
      `Initial sidebar empty rows are too heavy: ${JSON.stringify(
        heavySidebarEmptyRows,
      )}`,
    );
  }

  if (
    metrics.topbarTitleHeadingStyle?.fontWeight > 720 ||
    metrics.topbarTitleProjectStyle?.fontWeight > 620 ||
    metrics.runtimeStatusStyle?.fontWeight > 760 ||
    metrics.topbarContextStyles.some(
      (style) => !style || style.fontWeight > 640,
    )
  ) {
    throw new Error(
      `Initial topbar typography should stay restrained: ${JSON.stringify({
        title: metrics.topbarTitleHeadingStyle,
        project: metrics.topbarTitleProjectStyle,
        context: metrics.topbarContextStyles,
        runtime: metrics.runtimeStatusStyle,
      })}`,
    );
  }

  if (doc.bodyScrollHeight > viewport.height + 4) {
    throw new Error(
      `Desktop document should fit one viewport; body scrollHeight=${doc.bodyScrollHeight}, viewport=${viewport.height}`,
    );
  }

  if (metrics.sidebar.width < 238 || metrics.sidebar.width > 248) {
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

  if (metrics.terminal.height < 38 || metrics.terminal.height > 52) {
    throw new Error(
      `Unexpected collapsed terminal height: ${metrics.terminal.height}`,
    );
  }

  if (
    !metrics.terminalToggle ||
    metrics.terminalToggle.height < 30 ||
    metrics.terminalToggle.height > 36
  ) {
    throw new Error(
      `Collapsed terminal toggle should be slim: ${JSON.stringify(
        metrics.terminalToggle,
      )}`,
    );
  }

  if (metrics.terminalVisibleLabelText !== null) {
    throw new Error(
      `Collapsed terminal should not render a visible section label: ${metrics.terminalVisibleLabelText}`,
    );
  }

  if (
    !metrics.terminalStatusStyle ||
    metrics.terminalStatusStyle.textTransform !== 'none' ||
    metrics.terminalStatusStyle.fontWeight > 720 ||
    metrics.terminalStatusStyle.fontSize > 11.2
  ) {
    throw new Error(
      `Collapsed terminal status should stay normal-case and restrained: ${JSON.stringify(
        metrics.terminalStatusStyle,
      )}`,
    );
  }

  if (metrics.terminalOverflow.toggle) {
    throw new Error('Collapsed terminal toggle overflowed.');
  }

  for (const [key, rect] of Object.entries({
    project: metrics.terminalProject,
    status: metrics.terminalStatus,
    preview: metrics.terminalPreview,
  })) {
    if (
      !rect ||
      rect.left < metrics.terminalToggle.left - 1 ||
      rect.right > metrics.terminalToggle.right + 1
    ) {
      throw new Error(
        `Collapsed terminal ${key} is not contained in the strip: ${JSON.stringify(
          rect,
        )}`,
      );
    }
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        lineHeight: Number.parseFloat(style.lineHeight),
        textTransform: style.textTransform,
      };
    };
    const sidebar = document.querySelector('[data-testid="project-sidebar"]');
    const appActions = document.querySelector('[data-testid="sidebar-app-actions"]');
    const footerSettings = document.querySelector(
      '[data-testid="sidebar-footer-settings"]'
    );
    const headingOpenProject = document.querySelector(
      '.sidebar-heading-icon-button[aria-label="Open Project"]'
    );
    const projectList = document.querySelector('[data-testid="project-list"]');
    const threadList = document.querySelector('[data-testid="thread-list"]');
    const activeProjectGroup = document.querySelector(
      '[data-testid="sidebar-active-project-group"]'
    );
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
        threadTitle:
          row.querySelector('.session-row-title')?.textContent.trim() ?? null,
        className: row.className,
        rect: rectFor(row),
        style: styleFor(row),
        scrollWidth: row.scrollWidth,
        clientWidth: row.clientWidth,
        overflows: overflows(row)
      };
    });
    const projectRows = [
      ...document.querySelectorAll('[data-testid="project-row"]')
    ].map((row) => {
      const name = row.querySelector('[data-testid="project-row-name"]');
      const branch = row.querySelector('[data-testid="project-row-branch"]');
      const dirty = row.querySelector('[data-testid="project-row-dirty"]');
      return {
        text: row.textContent.trim(),
        label: row.getAttribute('aria-label') || '',
        title: row.getAttribute('title') || '',
        className: row.className,
        nameText: name?.textContent.trim() ?? '',
        branchText: branch?.textContent.trim() ?? '',
        branchTitle: branch?.getAttribute('title') || '',
        branchHasIcon: branch?.querySelector('svg') !== null,
        dirtyText: dirty?.textContent.trim() ?? null,
        dirtyTitle: dirty?.getAttribute('title') || null,
        branchRect: rectFor(branch),
        dirtyRect: rectFor(dirty),
        branchStyle: styleFor(branch),
        dirtyStyle: styleFor(dirty),
        branchOverflows: overflows(branch),
        dirtyOverflows: overflows(dirty)
      };
    });
    const headingStyles = [
      ...document.querySelectorAll('.sidebar-section-heading h2')
    ].map((heading) => styleFor(heading));
    const headingCountStyles = [
      ...document.querySelectorAll('.sidebar-section-count')
    ].map((count) => styleFor(count));
    const headingLabels = [
      ...document.querySelectorAll('.sidebar-section-heading h2')
    ].map((heading) => heading.textContent.trim());
    const projectTitleStyles = [
      ...document.querySelectorAll('.project-row-name')
    ].map((title) => styleFor(title));
    const projectMetaStyles = [
      ...document.querySelectorAll('.project-row-branch, .project-row-dirty')
    ].map((meta) => styleFor(meta));
    const threadTitleStyles = [
      ...document.querySelectorAll('.session-row-title')
    ].map((title) => styleFor(title));
    const threadMetaStyles = [
      ...document.querySelectorAll('.session-row-meta')
    ].map((meta) => styleFor(meta));

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      sidebar: rectFor(sidebar),
      appActions: rectFor(appActions),
      footerSettings: rectFor(footerSettings),
      headingOpenProject: {
        rect: rectFor(headingOpenProject),
        ariaLabel: headingOpenProject?.getAttribute('aria-label') ?? '',
        title: headingOpenProject?.getAttribute('title') ?? '',
        hasIcon: headingOpenProject?.querySelector('svg') !== null,
        directText: headingOpenProject?.textContent.trim() ?? ''
      },
      projectList: rectFor(projectList),
      threadList: rectFor(threadList),
      activeProjectGroup: rectFor(activeProjectGroup),
      hasLegacyToolbar: document.querySelector('.sidebar-toolbar') !== null,
      headingLabels,
      threadListInsideProjectList: Boolean(projectList?.contains(threadList)),
      threadListInsideActiveProject: Boolean(
        activeProjectGroup?.contains(threadList)
      ),
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
      projectRows,
      headingStyles,
      headingCountStyles,
      projectTitleStyles,
      projectMetaStyles,
      threadTitleStyles,
      threadMetaStyles,
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
    'headingOpenProject',
    'projectList',
    'threadList',
    'activeProjectGroup',
  ].filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing sidebar app rail rects: ${missing.join(', ')}`);
  }

  if (metrics.hasLegacyToolbar) {
    throw new Error('Sidebar should not render the old project toolbar.');
  }

  if (
    metrics.headingLabels.length !== 1 ||
    metrics.headingLabels[0] !== 'Projects'
  ) {
    throw new Error(
      `Sidebar should use one grouped project browser heading: ${JSON.stringify(
        metrics.headingLabels,
      )}`,
    );
  }

  if (
    !metrics.threadListInsideProjectList ||
    !metrics.threadListInsideActiveProject
  ) {
    throw new Error(
      `Sidebar thread list should be nested under the active project: ${JSON.stringify(
        {
          threadListInsideProjectList: metrics.threadListInsideProjectList,
          threadListInsideActiveProject: metrics.threadListInsideActiveProject,
          activeProjectGroup: metrics.activeProjectGroup,
          projectList: metrics.projectList,
          threadList: metrics.threadList,
        },
      )}`,
    );
  }

  for (const expectedLabel of ['New Thread', 'Search', 'Models']) {
    if (!metrics.appActionLabels.includes(expectedLabel)) {
      throw new Error(
        `Sidebar app actions missing ${expectedLabel}: ${metrics.appActionLabels.join(
          ', ',
        )}`,
      );
    }
  }

  if (
    metrics.headingOpenProject.ariaLabel !== 'Open Project' ||
    metrics.headingOpenProject.title !== 'Open Project' ||
    !metrics.headingOpenProject.hasIcon ||
    metrics.headingOpenProject.directText !== '' ||
    !metrics.headingOpenProject.rect ||
    metrics.headingOpenProject.rect.width > 22 ||
    metrics.headingOpenProject.rect.height > 22
  ) {
    throw new Error(
      `Sidebar Open Project should be an icon-led heading action: ${JSON.stringify(
        metrics.headingOpenProject,
      )}`,
    );
  }

  if (metrics.footerLabel !== 'Settings') {
    throw new Error(
      `Sidebar footer label should be Settings: ${metrics.footerLabel}`,
    );
  }

  if (metrics.sidebar.width < 238 || metrics.sidebar.width > 248) {
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

  const tallRows = metrics.rows.filter((row) => {
    if (row.className.includes('sidebar-action-row')) {
      return row.rect.height > 28;
    }
    if (row.className.includes('session-row')) {
      return row.rect.height > 32;
    }
    if (row.className.includes('project-row')) {
      return row.rect.height > 34;
    }
    return row.rect.height > 34;
  });
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

  const oversizedRowText = metrics.rows.filter(
    (row) => row.style && row.style.fontSize > 11.75,
  );
  if (oversizedRowText.length > 0) {
    throw new Error(
      `Sidebar row typography regressed: ${JSON.stringify(oversizedRowText)}`,
    );
  }

  const heavySidebarActionText = metrics.rows.filter(
    (row) =>
      row.className.includes('sidebar-action-row') &&
      row.style &&
      row.style.fontWeight > 600,
  );
  if (heavySidebarActionText.length > 0) {
    throw new Error(
      `Sidebar action text weight regressed: ${JSON.stringify(
        heavySidebarActionText,
      )}`,
    );
  }

  const loudHeadings = metrics.headingStyles.filter(
    (style) =>
      !style ||
      style.textTransform !== 'none' ||
      style.fontSize > 10.3 ||
      style.fontWeight > 680,
  );
  if (loudHeadings.length > 0) {
    throw new Error(
      `Sidebar heading typography regressed: ${JSON.stringify(loudHeadings)}`,
    );
  }

  const loudHeadingCounts = metrics.headingCountStyles.filter(
    (style) =>
      !style ||
      style.textTransform !== 'none' ||
      style.fontSize > 9.8 ||
      style.fontWeight > 640,
  );
  if (loudHeadingCounts.length > 0) {
    throw new Error(
      `Sidebar heading count typography regressed: ${JSON.stringify(
        loudHeadingCounts,
      )}`,
    );
  }

  const oversizedProjectTitles = metrics.projectTitleStyles.filter(
    (style) => style && style.fontSize > 11.75,
  );
  const oversizedProjectMeta = metrics.projectMetaStyles.filter(
    (style) => style && style.fontSize > 9.5,
  );
  const oversizedThreadTitles = metrics.threadTitleStyles.filter(
    (style) => style && style.fontSize > 11.75,
  );
  const oversizedThreadMeta = metrics.threadMetaStyles.filter(
    (style) => style && style.fontSize > 9.5,
  );
  if (
    oversizedProjectTitles.length > 0 ||
    oversizedProjectMeta.length > 0 ||
    oversizedThreadTitles.length > 0 ||
    oversizedThreadMeta.length > 0
  ) {
    throw new Error(
      `Sidebar project/thread text scale regressed: ${JSON.stringify({
        oversizedProjectTitles,
        oversizedProjectMeta,
        oversizedThreadTitles,
        oversizedThreadMeta,
      })}`,
    );
  }

  const heavyProjectTitles = metrics.projectTitleStyles.filter(
    (style) => style && style.fontWeight > 620,
  );
  const heavyProjectMeta = metrics.projectMetaStyles.filter(
    (style) => style && style.fontWeight > 650,
  );
  const heavyThreadTitles = metrics.threadTitleStyles.filter(
    (style) => style && style.fontWeight > 620,
  );
  const heavyThreadMeta = metrics.threadMetaStyles.filter(
    (style) => style && style.fontWeight > 660,
  );
  if (
    heavyProjectTitles.length > 0 ||
    heavyProjectMeta.length > 0 ||
    heavyThreadTitles.length > 0 ||
    heavyThreadMeta.length > 0
  ) {
    throw new Error(
      `Sidebar project/thread text weight regressed: ${JSON.stringify({
        heavyProjectTitles,
        heavyProjectMeta,
        heavyThreadTitles,
        heavyThreadMeta,
      })}`,
    );
  }

  if (metrics.projectRows.length === 0) {
    throw new Error('Sidebar project rows were not recorded.');
  }

  const activeProjectRow =
    metrics.projectRows.find((row) =>
      row.nameText.includes('desktop-e2e-workspace'),
    ) ?? metrics.projectRows[0];

  if (
    !activeProjectRow.branchText ||
    !activeProjectRow.branchTitle ||
    !activeProjectRow.branchHasIcon
  ) {
    throw new Error(
      `Sidebar project branch metadata is not structured: ${JSON.stringify(
        activeProjectRow,
      )}`,
    );
  }

  if (activeProjectRow.branchTitle !== longBranchName) {
    throw new Error(
      `Sidebar project row should preserve the full branch in its title: ${JSON.stringify(
        activeProjectRow,
      )}`,
    );
  }

  if (
    activeProjectRow.text.includes(longBranchName) ||
    activeProjectRow.label.includes(longBranchName) ||
    activeProjectRow.branchText.includes(longBranchName) ||
    activeProjectRow.branchText.length > 22
  ) {
    throw new Error(
      `Sidebar project row exposed an oversized branch label: ${JSON.stringify(
        activeProjectRow,
      )}`,
    );
  }

  if (
    activeProjectRow.dirtyText !== '2 dirty' ||
    activeProjectRow.dirtyTitle !== '1 modified · 0 staged · 1 untracked'
  ) {
    throw new Error(
      `Sidebar project dirty metadata regressed: ${JSON.stringify(
        activeProjectRow,
      )}`,
    );
  }

  if (activeProjectRow.branchOverflows || activeProjectRow.dirtyOverflows) {
    throw new Error(
      `Sidebar project metadata overflowed: ${JSON.stringify(activeProjectRow)}`,
    );
  }

  if (metrics.sidebarText.includes(longBranchName)) {
    throw new Error(
      `Sidebar visible text leaked the raw long branch: ${metrics.sidebarText}`,
    );
  }

  if (!metrics.sidebarText.includes(compactThreadTitle)) {
    throw new Error(
      `Sidebar did not expose the compact thread title: ${metrics.sidebarText}`,
    );
  }

  const activeThreadRow = metrics.rows.find(
    (row) =>
      row.className.includes('session-row-active') &&
      row.text.includes(compactThreadTitle),
  );
  if (!activeThreadRow) {
    throw new Error(
      `Sidebar active thread row did not expose the compact thread title: ${JSON.stringify(
        metrics.rows,
      )}`,
    );
  }
  if (activeThreadRow.threadTitle !== compactThreadTitle) {
    throw new Error(
      `Sidebar active thread row kept prompt tail noise: ${JSON.stringify(
        activeThreadRow,
      )}`,
    );
  }

  const sidebarLeaks = noisyThreadTitleLeaks.filter((leak) =>
    metrics.sidebarText.includes(leak),
  );
  if (
    sidebarLeaks.length > 0 ||
    metrics.sidebarText.includes('session-e2e') ||
    metrics.sidebarText.includes('Connected to')
  ) {
    throw new Error(
      `Sidebar leaked protocol or path noise: ${metrics.sidebarText}`,
    );
  }
}

async function assertSidebarModelsSettingsEntry(fileName) {
  await waitFor(
    'sidebar Models opens focused model provider settings',
    async () =>
      evaluate(`(() => {
        const settings = document.querySelector('[data-testid="settings-page"]');
        const provider = document.querySelector(
          '[data-testid="settings-provider-select"]'
        );
        return (
          settings?.getAttribute('data-initial-section') ===
            'settings-model-providers' &&
          provider !== null &&
          document.activeElement === provider
        );
      })()`),
    5_000,
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        lineHeight: Number.parseFloat(style.lineHeight)
      };
    };
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const modelsButton = document.querySelector(
      '[data-testid="sidebar-app-actions"] button[aria-label="Models"]'
    );
    const settings = document.querySelector('[data-testid="settings-page"]');
    const overlay = document.querySelector('[data-testid="settings-overlay"]');
    const provider = document.querySelector(
      '[data-testid="settings-provider-select"]'
    );
    const modelConfig = document.querySelector('[data-testid="model-config"]');
    const account = document.querySelector(
      '[data-testid="settings-account-section"]'
    );
    const runtime = document.querySelector('[data-testid="runtime-diagnostics"]');
    const settingsText = settings?.innerText ?? '';
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      initialSection:
        settings?.getAttribute('data-initial-section') ?? null,
      settingsRole: settings?.getAttribute('role') ?? null,
      settingsModal: settings?.getAttribute('aria-modal') ?? null,
      settingsRect: rectFor(settings),
      overlayRect: rectFor(overlay),
      modelConfigRect: rectFor(modelConfig),
      accountRect: rectFor(account),
      providerLabel: provider?.getAttribute('aria-label') ?? null,
      providerFocused: document.activeElement === provider,
      providerValue: provider?.value ?? null,
      providerRect: rectFor(provider),
      providerStyle: styleFor(provider),
      runtimeDiagnosticsPresent: runtime !== null,
      modelsButton: {
        ariaLabel: modelsButton?.getAttribute('aria-label') ?? null,
        title: modelsButton?.getAttribute('title') ?? null,
        hasIcon: modelsButton?.querySelector('svg') !== null,
        directText: [...(modelsButton?.childNodes ?? [])]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(''),
        rect: rectFor(modelsButton),
        overflows: overflows(modelsButton)
      },
      settingsText,
      visibleSecret:
        settingsText.includes('sk-desktop-e2e') ||
        settingsText.includes('cp-desktop-e2e'),
      hasAnySecret:
        settingsText.includes('sk-desktop-e2e') ||
        settingsText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4,
      settingsOverflow: overflows(settings)
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.initialSection !== 'settings-model-providers') {
    throw new Error(
      `Models should target Model Providers settings: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.settingsRole !== 'dialog' ||
    snapshot.settingsModal !== 'true' ||
    !snapshot.settingsRect ||
    !snapshot.overlayRect
  ) {
    throw new Error(
      `Models settings entry did not open the settings drawer: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.providerLabel !== 'Model provider' ||
    !snapshot.providerFocused ||
    !snapshot.providerRect ||
    snapshot.providerStyle?.fontSize > 14.5
  ) {
    throw new Error(
      `Models settings entry did not focus the compact provider selector: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (!snapshot.modelConfigRect || !snapshot.settingsRect) {
    throw new Error(
      `Models settings entry is missing model provider geometry: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  const modelConfigVisible =
    snapshot.modelConfigRect.bottom > snapshot.settingsRect.top &&
    snapshot.modelConfigRect.top < snapshot.settingsRect.bottom;
  if (!modelConfigVisible) {
    throw new Error(
      `Model Providers section is not visible after Models entry: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.modelsButton.ariaLabel !== 'Models' ||
    snapshot.modelsButton.title !== 'Models' ||
    !snapshot.modelsButton.hasIcon ||
    snapshot.modelsButton.directText !== '' ||
    snapshot.modelsButton.overflows
  ) {
    throw new Error(
      `Sidebar Models action should stay icon-led and compact: ${JSON.stringify(
        snapshot.modelsButton,
      )}`,
    );
  }

  if (
    snapshot.runtimeDiagnosticsPresent ||
    snapshot.settingsText.includes('Server URL') ||
    snapshot.settingsText.includes('ACP Not started') ||
    snapshot.settingsText.includes('Node') ||
    snapshot.visibleSecret ||
    snapshot.hasAnySecret ||
    snapshot.documentOverflow ||
    snapshot.settingsOverflow
  ) {
    throw new Error(
      `Models settings entry exposed diagnostics, secrets, or overflow: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function assertSidebarSearchFilter(fileName) {
  await waitFor(
    'sidebar search input focus',
    async () =>
      evaluate(`(() => {
        const input = document.querySelector(
          'input[aria-label="Search projects and threads"]'
        );
        return Boolean(input && document.activeElement === input);
      })()`),
    5_000,
  );

  await setFieldByAriaLabel('Search projects and threads', 'Review README');
  await waitFor(
    'sidebar search filtered to active thread',
    async () =>
      evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-testid="thread-row"]')];
        const sidebar = document.querySelector('[data-testid="project-sidebar"]');
        return (
          rows.length === 1 &&
          rows[0]?.textContent.includes(${JSON.stringify(compactThreadTitle)}) &&
          sidebar?.innerText.includes(${JSON.stringify(compactThreadTitle)}) &&
          !sidebar?.innerText.includes('desktop-e2e-clean-workspace')
        );
      })()`),
    10_000,
  );

  const filtered = await captureSidebarSearchSnapshot();

  await clickButton('Clear Search');
  await waitFor(
    'sidebar search clear restores grouped browser',
    async () =>
      evaluate(`(() => {
        const input = document.querySelector(
          'input[aria-label="Search projects and threads"]'
        );
        const projectRows = document.querySelectorAll('[data-testid="project-row"]');
        const threadRows = document.querySelectorAll('[data-testid="thread-row"]');
        const sidebar = document.querySelector('[data-testid="project-sidebar"]');
        return Boolean(
          input &&
            input.value === '' &&
            projectRows.length >= 2 &&
            threadRows.length >= 1 &&
            sidebar?.innerText.includes('desktop-e2e-clean-workspace') &&
            sidebar?.innerText.includes(${JSON.stringify(compactThreadTitle)})
        );
      })()`),
    10_000,
  );

  const cleared = await captureSidebarSearchSnapshot();

  await setFieldByAriaLabel('Search projects and threads', 'no-sidebar-match');
  await waitFor(
    'sidebar search empty state',
    async () =>
      evaluate(`(() => {
        const emptyState = document.querySelector(
          '[data-testid="sidebar-search-empty"]'
        );
        return (
          emptyState?.textContent.trim() ===
            'No matching projects or threads' &&
          document.querySelectorAll('[data-testid="project-row"]').length ===
            0 &&
          document.querySelectorAll('[data-testid="thread-row"]').length === 0
        );
      })()`),
    10_000,
  );

  const noMatch = await captureSidebarSearchSnapshot();

  await pressKey('Escape');
  await waitFor(
    'sidebar search closed by Escape',
    async () =>
      evaluate(`(() => {
        const searchButton = document.querySelector(
          '[data-testid="sidebar-app-actions"] button[aria-label="Search"]'
        );
        const sidebar = document.querySelector('[data-testid="project-sidebar"]');
        return (
          !document.querySelector('[data-testid="sidebar-search"]') &&
          searchButton?.getAttribute('aria-pressed') === 'false' &&
          document.querySelectorAll('[data-testid="project-row"]').length >= 2 &&
          document.querySelectorAll('[data-testid="thread-row"]').length >= 1 &&
          sidebar?.innerText.includes('desktop-e2e-clean-workspace') &&
          sidebar?.innerText.includes(${JSON.stringify(compactThreadTitle)})
        );
      })()`),
    5_000,
  );

  const closed = await evaluate(`(() => ({
    searchOpen: document.querySelector('[data-testid="sidebar-search"]') !== null,
    buttonPressed:
      document
        .querySelector('[data-testid="sidebar-app-actions"] button[aria-label="Search"]')
        ?.getAttribute('aria-pressed') ?? null,
    projectRowCount: document.querySelectorAll('[data-testid="project-row"]').length,
    threadRowCount: document.querySelectorAll('[data-testid="thread-row"]').length,
    appActionLabels: [
      ...document.querySelectorAll('[data-testid="sidebar-app-actions"] button')
    ].map((button) => button.getAttribute('aria-label') || ''),
    sidebarText:
      document.querySelector('[data-testid="project-sidebar"]')?.innerText ?? ''
  }))()`);

  const snapshot = { filtered, cleared, noMatch, closed };
  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    !filtered.search ||
    filtered.search.inputValue !== 'Review README' ||
    !filtered.search.inputFocused ||
    filtered.search.buttonPressed !== 'true' ||
    filtered.search.rect.height > 32 ||
    filtered.search.inputRect.height > 24 ||
    filtered.search.style.fontSize > 11
  ) {
    throw new Error(
      `Sidebar search input did not stay focused, active, and compact: ${JSON.stringify(
        filtered.search,
      )}`,
    );
  }

  if (
    filtered.projectRows.length !== 1 ||
    !filtered.projectRows[0]?.active ||
    !filtered.projectRows[0]?.text.includes('desktop-e2e-workspace') ||
    filtered.threadRows.length !== 1 ||
    filtered.threadRows[0]?.threadTitle !== compactThreadTitle ||
    filtered.sidebarText.includes('desktop-e2e-clean-workspace')
  ) {
    throw new Error(
      `Sidebar search did not isolate the matching active thread: ${JSON.stringify(
        {
          projectRows: filtered.projectRows,
          threadRows: filtered.threadRows,
          sidebarText: filtered.sidebarText,
        },
      )}`,
    );
  }

  if (Object.values(filtered.overflows).some(Boolean)) {
    throw new Error(
      `Sidebar search regions overflowed while filtered: ${JSON.stringify(
        filtered.overflows,
      )}`,
    );
  }

  const filteredLeaks = noisyThreadTitleLeaks.filter((leak) =>
    filtered.sidebarText.includes(leak),
  );
  if (
    filteredLeaks.length > 0 ||
    filtered.sidebarText.includes('session-e2e') ||
    filtered.sidebarText.includes('Connected to')
  ) {
    throw new Error(
      `Sidebar search leaked protocol or path noise: ${filtered.sidebarText}`,
    );
  }

  if (
    cleared.search?.inputValue !== '' ||
    cleared.projectRows.length < 2 ||
    !cleared.sidebarText.includes('desktop-e2e-clean-workspace') ||
    !cleared.sidebarText.includes(compactThreadTitle)
  ) {
    throw new Error(
      `Clearing sidebar search did not restore the grouped browser: ${JSON.stringify(
        cleared,
      )}`,
    );
  }

  if (
    noMatch.search?.inputValue !== 'no-sidebar-match' ||
    noMatch.emptyRows.length !== 1 ||
    noMatch.emptyRows[0]?.text !== 'No matching projects or threads' ||
    noMatch.projectRows.length !== 0 ||
    noMatch.threadRows.length !== 0 ||
    noMatch.sidebarText.includes('No matching threads') ||
    Object.values(noMatch.overflows).some(Boolean)
  ) {
    throw new Error(
      `Sidebar search no-match state is not concise and contained: ${JSON.stringify(
        noMatch,
      )}`,
    );
  }

  const noMatchLeaks = noisyThreadTitleLeaks.filter((leak) =>
    noMatch.sidebarText.includes(leak),
  );
  if (
    noMatchLeaks.length > 0 ||
    noMatch.sidebarText.includes('session-e2e') ||
    noMatch.sidebarText.includes('Connected to')
  ) {
    throw new Error(
      `Sidebar no-match state leaked protocol or path noise: ${noMatch.sidebarText}`,
    );
  }

  if (
    closed.searchOpen ||
    closed.buttonPressed !== 'false' ||
    closed.projectRowCount < 2 ||
    closed.threadRowCount < 1 ||
    !closed.appActionLabels.includes('Search') ||
    !closed.sidebarText.includes(compactThreadTitle)
  ) {
    throw new Error(
      `Closing sidebar search did not restore the app rail: ${JSON.stringify(
        closed,
      )}`,
    );
  }
}

async function captureSidebarSearchSnapshot() {
  return evaluate(`(() => {
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        lineHeight: Number.parseFloat(style.lineHeight)
      };
    };
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const sidebar = document.querySelector('[data-testid="project-sidebar"]');
    const search = document.querySelector('[data-testid="sidebar-search"]');
    const input = document.querySelector(
      'input[aria-label="Search projects and threads"]'
    );
    const searchButton = document.querySelector(
      '[data-testid="sidebar-app-actions"] button[aria-label="Search"]'
    );
    const clearButton = search?.querySelector('button[aria-label="Clear Search"]');
    const projectRows = [
      ...document.querySelectorAll('[data-testid="project-row"]')
    ].map((row) => ({
      text: row.textContent.trim(),
      label: row.getAttribute('aria-label') || '',
      active: row.classList.contains('project-row-active'),
      rect: rectFor(row),
      overflows: overflows(row),
      style: styleFor(row)
    }));
    const threadRows = [
      ...document.querySelectorAll('[data-testid="thread-row"]')
    ].map((row) => ({
      text: row.textContent.trim(),
      threadTitle:
        row.querySelector('.session-row-title')?.textContent.trim() ?? '',
      active: row.classList.contains('session-row-active'),
      rect: rectFor(row),
      overflows: overflows(row),
      style: styleFor(row)
    }));
    const emptyRows = [...document.querySelectorAll('.empty-row')].map(
      (row) => ({
        text: row.textContent.trim(),
        rect: rectFor(row),
        overflows: overflows(row),
        style: styleFor(row)
      })
    );

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      document: {
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight
      },
      sidebar: rectFor(sidebar),
      search: search
        ? {
            rect: rectFor(search),
            inputRect: rectFor(input),
            inputValue: input?.value ?? null,
            inputFocused: document.activeElement === input,
            buttonPressed: searchButton?.getAttribute('aria-pressed') ?? null,
            clearDisabled: clearButton?.disabled ?? null,
            style: styleFor(input)
          }
        : null,
      appActionLabels: [
        ...document.querySelectorAll('[data-testid="sidebar-app-actions"] button')
      ].map((button) => button.getAttribute('aria-label') || ''),
      headingOpenProjectHasIcon:
        document.querySelector(
          '.sidebar-heading-icon-button[aria-label="Open Project"] svg'
        ) !== null,
      projectRows,
      threadRows,
      emptyRows,
      sidebarText: sidebar?.innerText ?? '',
      overflows: {
        sidebar: overflows(sidebar),
        search: overflows(search),
        input: overflows(input),
        projectRows: projectRows.some((row) => row.overflows),
        threadRows: threadRows.some((row) => row.overflows),
        emptyRows: emptyRows.some((row) => row.overflows)
      }
    };
  })()`);
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
        color: style.color,
        backgroundAlpha: alphaFromColor(style.backgroundColor),
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
        borderRightWidth: Number.parseFloat(style.borderRightWidth),
        borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
        borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
        borderTopAlpha: alphaFromColor(style.borderTopColor),
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        textTransform: style.textTransform,
        lineHeight: Number.parseFloat(style.lineHeight)
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
    const branchTrigger = document.querySelector(
      '[data-testid="topbar-branch-trigger"]'
    );
    const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
    const diffStat = gitStatus?.querySelector('[data-testid="topbar-diff-stat"]');
    const diffAddition = diffStat?.querySelector('.diff-addition');
    const diffDeletion = diffStat?.querySelector('.diff-deletion');
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
      titleText: title?.querySelector('h2')?.textContent.trim() ?? '',
      titleHeadingStyle: styleFor(title?.querySelector('h2')),
      titleProjectStyle: styleFor(title?.querySelector('span')),
      context: contextRect,
      runtimeStatus: rectFor(runtimeStatus),
      runtimeStatusText: runtimeStatus?.textContent.trim() ?? '',
      runtimeStatusStyle: styleFor(runtimeStatus),
      topbarText: topbar?.textContent ?? '',
      contextText: context?.textContent ?? '',
      contextItems,
      branchTrigger: {
        text: branchTrigger?.textContent.trim() ?? '',
        title: branchTrigger?.getAttribute('title') ?? '',
        ariaLabel: branchTrigger?.getAttribute('aria-label') ?? '',
        rect: rectFor(branchTrigger)
      },
      gitStatus: {
        text: gitStatus?.textContent.trim() ?? '',
        title: gitStatus?.getAttribute('title') ?? '',
        ariaLabel: gitStatus?.getAttribute('aria-label') ?? '',
        rect: rectFor(gitStatus)
      },
      diffStat: {
        text: diffStat?.textContent.trim() ?? '',
        rect: rectFor(diffStat),
        style: styleFor(diffStat),
        additionText: diffAddition?.textContent.trim() ?? '',
        deletionText: diffDeletion?.textContent.trim() ?? '',
        additionStyle: styleFor(diffAddition),
        deletionStyle: styleFor(diffDeletion)
      },
      actionRects,
      hasLegacyMeta: document.querySelector('.topbar-meta') !== null,
      hasSegmentedTabs: document.querySelector('.topbar-nav') !== null,
      visibleHasLongBranch: topbar?.textContent.includes(longBranchName) ?? false,
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

  if (metrics.topbar.height < 46 || metrics.topbar.height > 52) {
    throw new Error(`Topbar is no longer slim: ${metrics.topbar.height}`);
  }

  if (metrics.document.bodyScrollWidth > metrics.viewport.width + 4) {
    throw new Error(
      `Topbar fidelity caused horizontal body overflow: ${JSON.stringify(
        metrics.document,
      )}`,
    );
  }

  if (metrics.visibleHasLongBranch) {
    throw new Error(
      `Topbar visible text leaked the raw long branch: ${metrics.topbarText}`,
    );
  }

  if (
    !metrics.branchTrigger.title.includes(longBranchName) ||
    !metrics.branchTrigger.ariaLabel.includes(longBranchName)
  ) {
    throw new Error(
      `Topbar branch metadata lost the full branch: ${JSON.stringify(
        metrics.branchTrigger,
      )}`,
    );
  }

  if (
    metrics.branchTrigger.text.includes(longBranchName) ||
    metrics.branchTrigger.text.length > 30
  ) {
    throw new Error(
      `Topbar branch trigger is not compact: ${JSON.stringify(
        metrics.branchTrigger,
      )}`,
    );
  }

  if (
    metrics.contextText.includes('modified ·') ||
    metrics.contextText.includes('untracked') ||
    metrics.gitStatus.text !== '+2 -1' ||
    !metrics.gitStatus.title.includes('1 modified · 0 staged · 1 untracked') ||
    !metrics.gitStatus.title.includes('Diff +2 -1') ||
    !metrics.gitStatus.ariaLabel.includes(
      '1 modified · 0 staged · 1 untracked',
    ) ||
    !metrics.gitStatus.ariaLabel.includes('Diff +2 -1') ||
    metrics.diffStat.text !== '+2 -1' ||
    metrics.diffStat.additionText !== '+2' ||
    metrics.diffStat.deletionText !== '-1' ||
    !metrics.diffStat.additionStyle ||
    !metrics.diffStat.deletionStyle ||
    metrics.diffStat.additionStyle.color ===
      metrics.diffStat.deletionStyle.color
  ) {
    throw new Error(
      `Topbar Git status should expose compact diff stats and preserve details: ${JSON.stringify(
        {
          gitStatus: metrics.gitStatus,
          diffStat: metrics.diffStat,
        },
      )}`,
    );
  }

  if (!metrics.topbarText.includes(compactThreadTitle)) {
    throw new Error(
      `Topbar did not expose the compact thread title: ${metrics.topbarText}`,
    );
  }

  if (metrics.titleText !== compactThreadTitle) {
    throw new Error(
      `Topbar title kept prompt tail noise: ${JSON.stringify({
        titleText: metrics.titleText,
        topbarText: metrics.topbarText,
      })}`,
    );
  }

  const topbarLeaks = noisyThreadTitleLeaks.filter((leak) =>
    metrics.topbarText.includes(leak),
  );
  if (
    topbarLeaks.length > 0 ||
    metrics.topbarText.includes('session-e2e') ||
    metrics.topbarText.includes('Connected to')
  ) {
    throw new Error(
      `Topbar leaked protocol or path noise: ${metrics.topbarText}`,
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

  if (metrics.titleHeadingStyle?.fontSize > 13.5) {
    throw new Error(
      `Topbar title typography regressed: ${JSON.stringify(
        metrics.titleHeadingStyle,
      )}`,
    );
  }

  if (
    metrics.titleHeadingStyle?.fontWeight > 720 ||
    metrics.titleProjectStyle?.fontWeight > 620
  ) {
    throw new Error(
      `Topbar title weight regressed: ${JSON.stringify({
        title: metrics.titleHeadingStyle,
        project: metrics.titleProjectStyle,
      })}`,
    );
  }

  if (metrics.titleProjectStyle?.fontSize > 11) {
    throw new Error(
      `Topbar project typography regressed: ${JSON.stringify(
        metrics.titleProjectStyle,
      )}`,
    );
  }

  const oversizedContextText = metrics.contextItems.filter(
    (item) => item.style.fontSize > 10.75,
  );
  if (oversizedContextText.length > 0) {
    throw new Error(
      `Topbar context typography regressed: ${JSON.stringify(
        oversizedContextText,
      )}`,
    );
  }

  const heavyContextText = metrics.contextItems.filter(
    (item) => item.style.fontWeight > 640,
  );
  if (heavyContextText.length > 0) {
    throw new Error(
      `Topbar context text weight regressed: ${JSON.stringify(
        heavyContextText,
      )}`,
    );
  }

  if (
    metrics.runtimeStatus.height > 29 ||
    metrics.runtimeStatus.width > 72 ||
    metrics.runtimeStatusStyle.fontSize > 10.75 ||
    metrics.runtimeStatusStyle.fontWeight > 720 ||
    metrics.runtimeStatusStyle.textTransform !== 'none'
  ) {
    throw new Error(
      `Runtime status should stay compact: ${JSON.stringify({
        rect: metrics.runtimeStatus,
        style: metrics.runtimeStatusStyle,
      })}`,
    );
  }

  if (metrics.diffStat.style?.fontWeight > 780) {
    throw new Error(
      `Topbar diff stat text weight regressed: ${JSON.stringify(
        metrics.diffStat,
      )}`,
    );
  }

  const oversizedActions = metrics.actionRects.filter(
    (action) => action.rect.width > 29 || action.rect.height > 29,
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

async function assertProjectSwitchCleanState(fileName) {
  await waitFor(
    'clean project selected without stale diff stat',
    async () =>
      evaluate(`(() => {
        const activeProject = [...document.querySelectorAll(
          '[data-testid="project-row"]'
        )].find((row) => row.classList.contains('project-row-active'));
        const gitStatus = document.querySelector(
          '[data-testid="topbar-git-status"]'
        );
        const projectLabel = document.querySelector(
          '[data-testid="topbar-title"] span'
        );
        return Boolean(
          activeProject?.textContent.includes('desktop-e2e-clean-workspace') &&
            projectLabel?.textContent.includes('desktop-e2e-clean-workspace') &&
            gitStatus?.textContent.trim() === 'Clean' &&
            !gitStatus.querySelector('[data-testid="topbar-diff-stat"]') &&
            !document.querySelector('[data-testid="conversation-changes-summary"]')
        );
      })()`),
    15_000,
  );

  const snapshot = await captureProjectSwitchSnapshot(fileName);
  const activeProject = snapshot.ui.projectRows.find((row) => row.active);

  if (!activeProject?.name.includes('desktop-e2e-clean-workspace')) {
    throw new Error(
      `Clean project should be active after opening the second workspace: ${JSON.stringify(
        snapshot.ui.projectRows,
      )}`,
    );
  }

  if (
    snapshot.ui.gitStatusText !== 'Clean' ||
    snapshot.ui.hasTopbarDiffStat ||
    snapshot.ui.hasConversationChangesSummary
  ) {
    throw new Error(
      `Clean project leaked stale dirty state: ${JSON.stringify(snapshot.ui)}`,
    );
  }

  if (!snapshot.ui.topbarProject.includes('desktop-e2e-clean-workspace')) {
    throw new Error(
      `Topbar should identify the clean project: ${JSON.stringify(snapshot.ui)}`,
    );
  }

  if (snapshot.cleanGitStatus.trim() !== '') {
    throw new Error(
      `Clean workspace should remain clean:\n${snapshot.cleanGitStatus}`,
    );
  }

  if (snapshot.ui.document.bodyScrollWidth > snapshot.ui.viewport.width + 4) {
    throw new Error(
      `Project switch caused horizontal overflow: ${JSON.stringify(
        snapshot.ui.document,
      )}`,
    );
  }
}

async function waitForDirtyTopbarDiffStat() {
  await waitFor(
    'dirty project topbar diff stat',
    async () =>
      evaluate(`(() => {
        const gitStatus = document.querySelector(
          '[data-testid="topbar-git-status"]'
        );
        return Boolean(
          gitStatus?.textContent.trim() === '+2 -1' &&
            gitStatus?.querySelector('[data-testid="topbar-diff-stat"]')
        );
      })()`),
    15_000,
  );
}

async function assertProjectSwitchDirtyState(fileName) {
  await waitFor(
    'dirty project selected with restored diff stat',
    async () =>
      evaluate(`(() => {
        const activeProject = [...document.querySelectorAll(
          '[data-testid="project-row"]'
        )].find((row) => row.classList.contains('project-row-active'));
        const gitStatus = document.querySelector(
          '[data-testid="topbar-git-status"]'
        );
        const projectLabel = document.querySelector(
          '[data-testid="topbar-title"] span'
        );
        return Boolean(
          activeProject?.textContent.includes('desktop-e2e-workspace') &&
            !activeProject?.textContent.includes('desktop-e2e-clean-workspace') &&
            projectLabel?.textContent.includes('desktop-e2e-workspace') &&
            gitStatus?.textContent.trim() === '+2 -1' &&
            gitStatus?.querySelector('[data-testid="topbar-diff-stat"]') &&
            document.querySelector('[data-testid="conversation-changes-summary"]')
        );
      })()`),
    15_000,
  );

  const snapshot = await captureProjectSwitchSnapshot(fileName);
  const activeProject = snapshot.ui.projectRows.find((row) => row.active);

  if (
    !activeProject?.name.includes('desktop-e2e-workspace') ||
    activeProject.name.includes('desktop-e2e-clean-workspace')
  ) {
    throw new Error(
      `Dirty project should be active after sidebar switch: ${JSON.stringify(
        snapshot.ui.projectRows,
      )}`,
    );
  }

  if (
    snapshot.ui.gitStatusText !== '+2 -1' ||
    !snapshot.ui.gitStatusTitle.includes(
      '1 modified · 0 staged · 1 untracked',
    ) ||
    !snapshot.ui.gitStatusTitle.includes('Diff +2 -1') ||
    !snapshot.ui.hasTopbarDiffStat ||
    !snapshot.ui.hasConversationChangesSummary
  ) {
    throw new Error(
      `Dirty project diff state was not restored: ${JSON.stringify(
        snapshot.ui,
      )}`,
    );
  }

  if (!snapshot.dirtyGitStatus.includes('README.md')) {
    throw new Error(
      `Dirty workspace should still include README.md changes:\n${snapshot.dirtyGitStatus}`,
    );
  }
}

async function assertProjectRelaunchPersistence(homeDir, fileName) {
  await waitFor(
    'dirty project recovered after relaunch',
    async () =>
      evaluate(`(() => {
        const rows = [...document.querySelectorAll(
          '[data-testid="project-row"]'
        )];
        const activeProject = rows.find((row) =>
          row.classList.contains('project-row-active')
        );
        const firstProject = rows[0];
        const gitStatus = document.querySelector(
          '[data-testid="topbar-git-status"]'
        );
        const projectLabel = document.querySelector(
          '[data-testid="topbar-title"] span'
        );
        return Boolean(
          rows.length >= 2 &&
            activeProject === firstProject &&
            activeProject?.textContent.includes('desktop-e2e-workspace') &&
            !activeProject?.textContent.includes('desktop-e2e-clean-workspace') &&
            projectLabel?.textContent.includes('desktop-e2e-workspace') &&
            gitStatus?.textContent.trim() === '+2 -1' &&
            gitStatus?.querySelector('[data-testid="topbar-diff-stat"]') &&
            document.querySelector('[data-testid="conversation-changes-summary"]')
        );
      })()`),
    20_000,
  );

  const [ui, dirtyStatus, cleanStatus] = await Promise.all([
    evaluate(`(() => {
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
      const rows = [...document.querySelectorAll('[data-testid="project-row"]')]
        .map((row, index) => ({
          index,
          label: row.getAttribute('aria-label') || '',
          title: row.getAttribute('title') || '',
          text: row.textContent.trim(),
          active: row.classList.contains('project-row-active'),
          name:
            row
              .querySelector('[data-testid="project-row-name"]')
              ?.textContent.trim() ?? '',
          branch:
            row
              .querySelector('[data-testid="project-row-branch"]')
              ?.textContent.trim() ?? '',
          dirty:
            row
              .querySelector('[data-testid="project-row-dirty"]')
              ?.textContent.trim() ?? null,
          rect: rectFor(row)
        }));
      const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
      const title = document.querySelector('[data-testid="topbar-title"]');
      const diffStat = gitStatus?.querySelector('[data-testid="topbar-diff-stat"]');
      return {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        document: {
          bodyScrollWidth: document.body.scrollWidth,
          bodyScrollHeight: document.body.scrollHeight
        },
        topbarProject: title?.querySelector('span')?.textContent.trim() ?? '',
        gitStatusText: gitStatus?.textContent.trim() ?? '',
        gitStatusTitle: gitStatus?.getAttribute('title') ?? '',
        hasTopbarDiffStat: diffStat !== null,
        hasConversationChangesSummary:
          document.querySelector('[data-testid="conversation-changes-summary"]') !== null,
        projectRows: rows,
        activeProjectCount: rows.filter((row) => row.active).length
      };
    })()`),
    execFileP('git', ['-C', workspaceDir, 'status', '--porcelain=v1']),
    execFileP('git', ['-C', cleanWorkspaceDir, 'status', '--porcelain=v1']),
  ]);
  const storePath = join(homeDir, '.qwen', 'desktop-projects.json');
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  const storeProjects = Array.isArray(store.projects) ? store.projects : [];
  const snapshot = {
    ui,
    storePath,
    storeProjects,
    dirtyGitStatus: dirtyStatus.stdout,
    cleanGitStatus: cleanStatus.stdout,
  };

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  const paths = storeProjects.map((project) => project.path);
  const uniquePaths = new Set(paths);
  if (
    store.version !== 1 ||
    paths.length !== 2 ||
    uniquePaths.size !== 2 ||
    paths[0] !== workspaceDir ||
    paths[1] !== cleanWorkspaceDir
  ) {
    throw new Error(
      `Recent project store did not preserve sidebar-selected recency: ${JSON.stringify(
        storeProjects,
      )}`,
    );
  }

  const firstRow = ui.projectRows[0];
  const activeRows = ui.projectRows.filter((row) => row.active);
  if (
    activeRows.length !== 1 ||
    firstRow !== activeRows[0] ||
    !firstRow.name.includes('desktop-e2e-workspace') ||
    firstRow.name.includes('desktop-e2e-clean-workspace')
  ) {
    throw new Error(
      `Relaunch should recover the sidebar-selected dirty project first: ${JSON.stringify(
        ui.projectRows,
      )}`,
    );
  }

  if (
    ui.gitStatusText !== '+2 -1' ||
    !ui.gitStatusTitle.includes('1 modified · 0 staged · 1 untracked') ||
    !ui.gitStatusTitle.includes('Diff +2 -1') ||
    !ui.hasTopbarDiffStat ||
    !ui.hasConversationChangesSummary ||
    !ui.topbarProject.includes('desktop-e2e-workspace')
  ) {
    throw new Error(
      `Relaunch did not restore the dirty project workbench state: ${JSON.stringify(
        ui,
      )}`,
    );
  }

  if (cleanStatus.stdout.trim() !== '') {
    throw new Error(
      `Clean workspace should stay clean across relaunch:\n${cleanStatus.stdout}`,
    );
  }

  if (!dirtyStatus.stdout.includes('README.md')) {
    throw new Error(
      `Dirty workspace should still include README.md after relaunch:\n${dirtyStatus.stdout}`,
    );
  }

  if (ui.document.bodyScrollWidth > ui.viewport.width + 4) {
    throw new Error(
      `Relaunch recovery caused horizontal overflow: ${JSON.stringify(
        ui.document,
      )}`,
    );
  }
}

async function captureProjectSwitchSnapshot(fileName) {
  const [ui, dirtyStatus, cleanStatus] = await Promise.all([
    evaluate(`(() => {
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
      const topbar = document.querySelector('[data-testid="workspace-topbar"]');
      const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
      const diffStat = gitStatus?.querySelector('[data-testid="topbar-diff-stat"]');
      const title = document.querySelector('[data-testid="topbar-title"]');
      const rows = [...document.querySelectorAll('[data-testid="project-row"]')]
        .map((row) => ({
          label: row.getAttribute('aria-label') || '',
          title: row.getAttribute('title') || '',
          text: row.textContent.trim(),
          active: row.classList.contains('project-row-active'),
          name:
            row
              .querySelector('[data-testid="project-row-name"]')
              ?.textContent.trim() ?? '',
          branch:
            row
              .querySelector('[data-testid="project-row-branch"]')
              ?.textContent.trim() ?? '',
          dirty:
            row
              .querySelector('[data-testid="project-row-dirty"]')
              ?.textContent.trim() ?? null,
          rect: rectFor(row)
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
        topbar: rectFor(topbar),
        topbarTitle: title?.querySelector('h2')?.textContent.trim() ?? '',
        topbarProject: title?.querySelector('span')?.textContent.trim() ?? '',
        gitStatusText: gitStatus?.textContent.trim() ?? '',
        gitStatusTitle: gitStatus?.getAttribute('title') ?? '',
        gitStatusAria: gitStatus?.getAttribute('aria-label') ?? '',
        hasTopbarDiffStat: diffStat !== null,
        hasConversationChangesSummary:
          document.querySelector('[data-testid="conversation-changes-summary"]') !== null,
        projectRows: rows,
        activeProjectCount: rows.filter((row) => row.active).length
      };
    })()`),
    execFileP('git', ['-C', workspaceDir, 'status', '--porcelain=v1']),
    execFileP('git', ['-C', cleanWorkspaceDir, 'status', '--porcelain=v1']),
  ]);
  const snapshot = {
    ui,
    dirtyGitStatus: dirtyStatus.stdout,
    cleanGitStatus: cleanStatus.stdout,
  };

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.ui.projectRows.length < 2) {
    throw new Error(
      `Project switch should show both recent projects: ${JSON.stringify(
        snapshot.ui.projectRows,
      )}`,
    );
  }

  if (snapshot.ui.activeProjectCount !== 1) {
    throw new Error(
      `Exactly one project should be active: ${JSON.stringify(
        snapshot.ui.projectRows,
      )}`,
    );
  }

  return snapshot;
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
            (
              currentRow.getAttribute('title') === ${JSON.stringify(
                expectedCurrentBranch,
              )} ||
              currentRow.getAttribute('aria-label')?.includes(${JSON.stringify(
                expectedCurrentBranch,
              )})
            )
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
        color: style.color,
        backgroundAlpha: alphaFromColor(style.backgroundColor),
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
        borderRightWidth: Number.parseFloat(style.borderRightWidth),
        borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
        borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        textTransform: style.textTransform,
        lineHeight: Number.parseFloat(style.lineHeight)
      };
    };
    const menu = document.querySelector('[data-testid="branch-menu"]');
    const header = menu?.querySelector('.branch-menu-header');
    const createForm = document.querySelector('[data-testid="branch-create-form"]');
    const createLabel = document.querySelector('.branch-create-label');
    const trigger = document.querySelector('[data-testid="topbar-branch-trigger"]');
    const topbar = document.querySelector('[data-testid="workspace-topbar"]');
    const rows = [...document.querySelectorAll('[data-testid="branch-menu-row"]')];
    const createButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim().includes('Create Branch'));
    const rowSnapshots = rows.map((row) => ({
      label: row.getAttribute('aria-label') || '',
      title: row.getAttribute('title') || '',
      checked: row.getAttribute('aria-checked'),
      disabled: row.disabled,
      text: row.textContent.trim(),
      visibleLabel:
        row.querySelector('[data-testid="branch-menu-row-label"]')
          ?.textContent.trim() ?? '',
      style: styleFor(row),
      markerStyle: styleFor(row.querySelector('em')),
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
      headerText: header?.textContent.trim() ?? '',
      headerStyle: styleFor(header),
      createLabelStyle: styleFor(createLabel),
      rows: rowSnapshots,
      hasLongBranch: rowSnapshots.some((row) =>
        row.title === ${JSON.stringify(longBranchName)} &&
          row.label.includes(${JSON.stringify(longBranchName)})
      ),
      hasCreatedBranch: rowSnapshots.some((row) =>
        row.title === ${JSON.stringify(createdBranchName)} &&
          row.label.includes(${JSON.stringify(createdBranchName)})
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
    throw new Error(
      'Branch trigger should be expanded while the menu is open.',
    );
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
      `Branch menu did not preserve expected branch metadata: ${JSON.stringify(
        snapshot.rows,
      )}`,
    );
  }

  const rawLongBranchRows = snapshot.rows.filter((row) =>
    row.text.includes(longBranchName),
  );
  if (rawLongBranchRows.length > 0) {
    throw new Error(
      `Branch menu visibly exposed raw long branch names: ${JSON.stringify(
        rawLongBranchRows,
      )}`,
    );
  }

  const compactLongBranchRows = snapshot.rows.filter(
    (row) => row.title === longBranchName || row.title === createdBranchName,
  );
  const unrestrainedLongBranchRows = compactLongBranchRows.filter(
    (row) =>
      !row.visibleLabel.includes('...') ||
      row.visibleLabel.length > 30 ||
      row.visibleLabel.includes(row.title),
  );
  if (unrestrainedLongBranchRows.length > 0) {
    throw new Error(
      `Branch menu row labels should stay compact: ${JSON.stringify(
        unrestrainedLongBranchRows,
      )}`,
    );
  }

  const heavyBranchRows = snapshot.rows.filter(
    (row) =>
      !row.style || row.style.fontWeight > 680 || row.style.fontSize > 12.2,
  );
  if (heavyBranchRows.length > 0) {
    throw new Error(
      `Branch menu rows are too visually heavy: ${JSON.stringify(
        heavyBranchRows,
      )}`,
    );
  }

  const currentMarker = snapshot.rows.find((row) => row.markerStyle);
  if (
    currentMarker?.markerStyle &&
    (currentMarker.markerStyle.textTransform !== 'none' ||
      currentMarker.markerStyle.fontWeight > 660)
  ) {
    throw new Error(
      `Branch menu current marker should stay normal-case and restrained: ${JSON.stringify(
        currentMarker,
      )}`,
    );
  }

  if (
    !snapshot.headerStyle ||
    snapshot.headerStyle.textTransform !== 'none' ||
    snapshot.headerStyle.fontWeight > 720 ||
    snapshot.headerStyle.fontSize > 11.2 ||
    !snapshot.createLabelStyle ||
    snapshot.createLabelStyle.fontWeight > 700
  ) {
    throw new Error(
      `Branch menu support labels should stay normal-case and restrained: ${JSON.stringify(
        {
          header: snapshot.headerStyle,
          createLabel: snapshot.createLabelStyle,
        },
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

  if (snapshot.currentRows[0].title !== expectedCurrentBranch) {
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
  const readSnapshot = async (label) =>
    evaluate(`(() => {
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
      const form = document.querySelector('[data-testid="branch-create-form"]');
      const input = document.querySelector('[aria-label="New branch name"]');
      const error = document.querySelector('[data-testid="branch-create-error"]');
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent.trim().includes('Create Branch'));
      const menuRect = rectFor(menu);
      const errorRect = rectFor(error);
      return {
        label: ${JSON.stringify(label)},
        formText: form?.textContent.trim() ?? '',
        inputValue: input?.value ?? null,
        buttonDisabled: button?.disabled ?? null,
        errorText: error?.textContent.trim() ?? '',
        menu: menuRect,
        createForm: rectFor(form),
        error: errorRect,
        errorEscapesMenu: Boolean(
          errorRect &&
            menuRect &&
            (errorRect.left < menuRect.left - 1 ||
              errorRect.right > menuRect.right + 1)
        ),
        bodyScrollWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth
      };
    })()`);

  const empty = await readSnapshot('empty');

  await setFieldByAriaLabel('New branch name', longBranchName);
  await waitFor(
    'duplicate branch create validation',
    async () =>
      evaluate(`(() => {
        const error = document.querySelector('[data-testid="branch-create-error"]');
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent.trim().includes('Create Branch'));
        return Boolean(
          button?.disabled &&
            error?.textContent.includes('already exists')
        );
      })()`),
    10_000,
  );
  const duplicate = await readSnapshot('duplicate');

  await setFieldByAriaLabel('New branch name', 'feature/has space');
  await waitFor(
    'malformed branch create validation',
    async () =>
      evaluate(`(() => {
        const error = document.querySelector('[data-testid="branch-create-error"]');
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent.trim().includes('Create Branch'));
        return Boolean(
          button?.disabled &&
            error?.textContent.includes('valid local branch')
        );
      })()`),
    10_000,
  );
  const malformed = await readSnapshot('malformed');

  await setFieldByAriaLabel('New branch name', createdBranchName);
  await waitFor(
    'valid branch create validation',
    async () =>
      evaluate(`(() => {
        const error = document.querySelector('[data-testid="branch-create-error"]');
        const button = [...document.querySelectorAll('button')]
          .find((candidate) => candidate.textContent.trim().includes('Create Branch'));
        return Boolean(button && !button.disabled && !error);
      })()`),
    10_000,
  );
  const valid = await readSnapshot('valid');
  const snapshot = {
    empty,
    duplicate,
    malformed,
    valid,
  };

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.empty.inputValue !== '') {
    throw new Error(
      `New branch input should start empty: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.empty.buttonDisabled !== true) {
    throw new Error(
      `Create Branch should be disabled while the branch name is empty: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.duplicate.buttonDisabled !== true ||
    !snapshot.duplicate.errorText.includes('already exists')
  ) {
    throw new Error(
      `Duplicate branch validation did not disable creation: ${JSON.stringify(
        snapshot.duplicate,
      )}`,
    );
  }

  if (
    snapshot.malformed.buttonDisabled !== true ||
    !snapshot.malformed.errorText.includes('valid local branch')
  ) {
    throw new Error(
      `Malformed branch validation did not disable creation: ${JSON.stringify(
        snapshot.malformed,
      )}`,
    );
  }

  if (
    snapshot.valid.inputValue !== createdBranchName ||
    snapshot.valid.buttonDisabled !== false ||
    snapshot.valid.errorText !== ''
  ) {
    throw new Error(
      `Valid branch name should clear validation: ${JSON.stringify(
        snapshot.valid,
      )}`,
    );
  }

  for (const state of [snapshot.duplicate, snapshot.malformed]) {
    if (state.errorEscapesMenu) {
      throw new Error(
        `Branch validation error escaped the menu: ${JSON.stringify(state)}`,
      );
    }

    if (state.bodyScrollWidth > state.viewportWidth + 4) {
      throw new Error(
        `Branch validation caused body overflow: ${JSON.stringify(state)}`,
      );
    }
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
        const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
        return {
          branchText: trigger?.textContent.trim() ?? '',
          branchTitle: trigger?.getAttribute('title') ?? '',
          branchAriaLabel: trigger?.getAttribute('aria-label') ?? '',
          menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
          gitStatusText: gitStatus?.textContent.trim() ?? '',
          gitStatusTitle: gitStatus?.getAttribute('title') ?? '',
          gitStatusAriaLabel: gitStatus?.getAttribute('aria-label') ?? ''
        };
      })()`);
      const { stdout } = await execFileP('git', [
        '-C',
        workspaceDir,
        'branch',
        '--show-current',
      ]);
      return (
        ui.branchTitle.includes(createdBranchName) &&
        !ui.menuOpen &&
        stdout.trim() === createdBranchName
      );
    },
    15_000,
  );

  const [ui, branch, status] = await Promise.all([
    evaluate(`(() => {
      const trigger = document.querySelector('[data-testid="topbar-branch-trigger"]');
      const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
      return {
        branchText: trigger?.textContent.trim() ?? '',
        branchTitle: trigger?.getAttribute('title') ?? '',
        branchAriaLabel: trigger?.getAttribute('aria-label') ?? '',
        menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
        gitStatusText: gitStatus?.textContent.trim() ?? '',
        gitStatusTitle: gitStatus?.getAttribute('title') ?? '',
        gitStatusAriaLabel: gitStatus?.getAttribute('aria-label') ?? ''
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

  if (
    snapshot.ui.gitStatusText !== '+2 -1' ||
    !snapshot.ui.gitStatusTitle.includes(
      '1 modified · 0 staged · 1 untracked',
    ) ||
    !snapshot.ui.gitStatusTitle.includes('Diff +2 -1')
  ) {
    throw new Error(
      `Branch creation should preserve dirty status in the topbar: ${JSON.stringify(
        snapshot.ui,
      )}`,
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
    throw new Error(
      'Branch confirmation should remain inside the branch menu.',
    );
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
        const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
        return {
          branchText: trigger?.textContent.trim() ?? '',
          branchTitle: trigger?.getAttribute('title') ?? '',
          branchAriaLabel: trigger?.getAttribute('aria-label') ?? '',
          menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
          gitStatusText: gitStatus?.textContent.trim() ?? '',
          gitStatusTitle: gitStatus?.getAttribute('title') ?? '',
          gitStatusAriaLabel: gitStatus?.getAttribute('aria-label') ?? ''
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
      const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
      return {
        branchText: trigger?.textContent.trim() ?? '',
        branchTitle: trigger?.getAttribute('title') ?? '',
        branchAriaLabel: trigger?.getAttribute('aria-label') ?? '',
        menuOpen: document.querySelector('[data-testid="branch-menu"]') !== null,
        gitStatusText: gitStatus?.textContent.trim() ?? '',
        gitStatusTitle: gitStatus?.getAttribute('title') ?? '',
        gitStatusAriaLabel: gitStatus?.getAttribute('aria-label') ?? '',
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

  if (
    snapshot.ui.gitStatusText !== '+2 -1' ||
    !snapshot.ui.gitStatusTitle.includes(
      '1 modified · 0 staged · 1 untracked',
    ) ||
    !snapshot.ui.gitStatusTitle.includes('Diff +2 -1')
  ) {
    throw new Error(
      `Branch switch should preserve dirty status in the topbar: ${JSON.stringify(
        snapshot.ui,
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
    const summaryLabel = summary?.querySelector('.conversation-activity-label');
    const reviewAction = summary?.querySelector(
      'button[aria-label="Review Changes"]'
    );
    const firstRow = summary?.querySelector('.conversation-changes-list li');
    const firstRowState = firstRow?.querySelector('small');
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
        borderRadius: style.borderTopLeftRadius,
        display: style.display,
        fontSize: numberFromPixel(style.fontSize),
        fontWeight: numberFromPixel(style.fontWeight),
        lineHeight: numberFromPixel(style.lineHeight),
        position: style.position,
        textTransform: style.textTransform
      };
    };
    return {
      bodyHasSessionId: bodyText.includes('session-e2e-1'),
      bodyHasConnectedEvent: bodyText.includes('Connected to session-e2e'),
      bodyHasTurnComplete: bodyText.includes('Turn complete'),
      summaryText: summary?.innerText ?? '',
      summaryRect: rectFor(summary),
      summaryStyle: styleFor(summary),
      labelText: summaryLabel?.textContent.trim() ?? '',
      labelStyle: styleFor(summaryLabel),
      rowStateText: firstRowState?.textContent.trim() ?? '',
      rowStateStyle: styleFor(firstRowState),
      actionText: reviewAction?.textContent.trim() ?? '',
      actionLabel: reviewAction?.getAttribute('aria-label') ?? '',
      actionTitle: reviewAction?.getAttribute('title') ?? '',
      actionRect: rectFor(reviewAction),
      actionStyle: styleFor(reviewAction),
      actionHasIcon: Boolean(reviewAction?.querySelector('svg')),
      hasLegacyMessageRole: Boolean(summary?.querySelector('.message-role')),
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
      `Conversation leaked a protocol stop reason: ${JSON.stringify(snapshot)}`,
    );
  }

  for (const expectedText of [
    '2 files changed',
    'README.md',
    'notes.txt',
    '+2',
    '-1',
    'Modified · Unstaged',
    'Untracked',
  ]) {
    if (!snapshot.summaryText.includes(expectedText)) {
      throw new Error(
        `Changed-files summary is missing ${expectedText}: ${snapshot.summaryText}`,
      );
    }
  }

  for (const legacyText of ['CHANGED FILES', 'MODIFIED · UNSTAGED']) {
    if (snapshot.summaryText.includes(legacyText)) {
      throw new Error(
        `Changed-files summary retained uppercase legacy text ${legacyText}: ${snapshot.summaryText}`,
      );
    }
  }

  if (snapshot.hasLegacyMessageRole) {
    throw new Error(
      'Changed-files summary should not use message-role chrome.',
    );
  }

  if (
    snapshot.labelText !== 'Changed files' ||
    !snapshot.labelStyle ||
    snapshot.labelStyle.textTransform !== 'none' ||
    snapshot.labelStyle.fontWeight > 700
  ) {
    throw new Error(
      `Changed-files label is too heavy: ${JSON.stringify({
        text: snapshot.labelText,
        style: snapshot.labelStyle,
      })}`,
    );
  }

  if (
    snapshot.rowStateText !== 'Modified · Unstaged' ||
    !snapshot.rowStateStyle ||
    snapshot.rowStateStyle.textTransform !== 'none' ||
    snapshot.rowStateStyle.fontWeight > 700
  ) {
    throw new Error(
      `Changed-files row state should be title-case and subdued: ${JSON.stringify(
        {
          text: snapshot.rowStateText,
          style: snapshot.rowStateStyle,
        },
      )}`,
    );
  }

  if (
    snapshot.actionLabel !== 'Review Changes' ||
    snapshot.actionTitle !== 'Review Changes' ||
    snapshot.actionText !== 'Review' ||
    !snapshot.actionHasIcon
  ) {
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
    snapshot.summaryRect.height > 92
  ) {
    throw new Error(
      `Changed-files summary geometry is unexpected: ${JSON.stringify(
        snapshot.summaryRect,
      )}`,
    );
  }

  if (
    !snapshot.summaryStyle ||
    snapshot.summaryStyle.backgroundAlpha > 0.025 ||
    snapshot.summaryStyle.borderTopWidth > 0 ||
    snapshot.summaryStyle.borderRightWidth > 0 ||
    snapshot.summaryStyle.borderBottomWidth > 0 ||
    snapshot.summaryStyle.borderLeftWidth < 1.5 ||
    snapshot.summaryStyle.borderLeftWidth > 2.5 ||
    snapshot.summaryStyle.borderRadius !== '0px'
  ) {
    throw new Error(
      `Changed-files summary should render as an inline rail: ${JSON.stringify(
        snapshot.summaryStyle,
      )}`,
    );
  }

  if (
    !snapshot.actionRect ||
    !snapshot.actionStyle ||
    snapshot.actionRect.height > 28 ||
    snapshot.actionStyle.backgroundAlpha > 0.1 ||
    snapshot.actionStyle.borderRadius !== '999px'
  ) {
    throw new Error(
      `Changed-files review action should stay compact: ${JSON.stringify({
        rect: snapshot.actionRect,
        style: snapshot.actionStyle,
      })}`,
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
        fontSize: numberFromPixel(style.fontSize),
        fontWeight: numberFromPixel(style.fontWeight),
        textTransform: style.textTransform
      };
    };
    const promptLabel = card?.querySelector('.conversation-prompt-label');
    const statusLabel = card?.querySelector('.conversation-approval-status');
    return {
      bodyText: document.body.innerText,
      cardText: card?.innerText ?? '',
      buttons,
      cardRect: rectFor(card),
      timelineRect: rectFor(timeline),
      composerRect: rectFor(composer),
      promptLabelText: promptLabel?.textContent.trim() ?? '',
      promptLabelStyle: styleFor(promptLabel),
      statusLabelText: statusLabel?.textContent.trim() ?? '',
      statusLabelStyle: styleFor(statusLabel),
      hasLegacyMessageRole: Boolean(card?.querySelector('.message-role')),
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
    'execute',
    'run desktop e2e command',
    'printf desktop-e2e',
    'needs approval',
  ]) {
    if (!cardText.includes(expectedText)) {
      throw new Error(
        `Inline approval card is missing ${expectedText}: ${snapshot.cardText}`,
      );
    }
  }

  if (
    snapshot.promptLabelText !== 'Execute' ||
    snapshot.statusLabelText !== 'Needs approval'
  ) {
    throw new Error(
      `Inline approval labels should use title-case product language: ${JSON.stringify(
        {
          prompt: snapshot.promptLabelText,
          status: snapshot.statusLabelText,
        },
      )}`,
    );
  }

  for (const legacyLabel of ['EXECUTE', 'PENDING', 'NEEDS APPROVAL']) {
    if (snapshot.cardText.includes(legacyLabel)) {
      throw new Error(
        `Inline approval card should not show uppercase legacy label ${legacyLabel}: ${snapshot.cardText}`,
      );
    }
  }

  if (snapshot.hasLegacyMessageRole) {
    throw new Error('Inline approval card should not use message-role chrome.');
  }

  if (
    !snapshot.promptLabelStyle ||
    !snapshot.statusLabelStyle ||
    snapshot.promptLabelStyle.textTransform !== 'none' ||
    snapshot.statusLabelStyle.textTransform !== 'none' ||
    snapshot.promptLabelStyle.fontWeight > 700 ||
    snapshot.statusLabelStyle.fontWeight > 700
  ) {
    throw new Error(
      `Inline approval labels are too heavy: ${JSON.stringify({
        prompt: snapshot.promptLabelStyle,
        status: snapshot.statusLabelStyle,
      })}`,
    );
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

  if (snapshot.cardRect.width < 360 || snapshot.cardRect.height > 130) {
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

async function assertInlineQuestionCard(fileName) {
  await waitForSelector('[data-testid="conversation-question-card"]');
  const snapshot = await evaluate(`(() => {
    const card = document.querySelector(
      '[data-testid="conversation-question-card"]'
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
        fontSize: numberFromPixel(style.fontSize),
        fontWeight: numberFromPixel(style.fontWeight),
        textTransform: style.textTransform
      };
    };
    const buttons = [...(card?.querySelectorAll('button') ?? [])].map(
      (button) =>
        button.getAttribute('aria-label') ||
        button.getAttribute('title') ||
        button.textContent.trim()
    );
    const promptLabel = card?.querySelector('.conversation-prompt-label');
    const statusLabel = card?.querySelector('.conversation-approval-status');
    const questionLabel = card?.querySelector('.conversation-question-label');
    return {
      bodyText: document.body.innerText,
      cardText: card?.innerText ?? '',
      buttons,
      cardRect: rectFor(card),
      timelineRect: rectFor(timeline),
      composerRect: rectFor(composer),
      promptLabelText: promptLabel?.textContent.trim() ?? '',
      promptLabelStyle: styleFor(promptLabel),
      statusLabelText: statusLabel?.textContent.trim() ?? '',
      statusLabelStyle: styleFor(statusLabel),
      questionLabelText: questionLabel?.textContent.trim() ?? '',
      questionLabelStyle: styleFor(questionLabel),
      hasLegacyMessageRole: Boolean(card?.querySelector('.message-role')),
      hasRawQuestionProtocol: document.body.innerText.includes('ask_user_question')
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  const cardText = snapshot.cardText.toLowerCase();
  for (const expectedText of [
    'question',
    'input needed',
    'waiting',
    'choice',
    'pick the next review focus',
    'review changes',
    'continue task',
  ]) {
    if (!cardText.includes(expectedText)) {
      throw new Error(
        `Inline question card is missing ${expectedText}: ${snapshot.cardText}`,
      );
    }
  }

  if (
    snapshot.promptLabelText !== 'Question' ||
    snapshot.statusLabelText !== 'Waiting' ||
    snapshot.questionLabelText !== 'Choice'
  ) {
    throw new Error(
      `Inline question labels should use restrained product language: ${JSON.stringify(
        {
          prompt: snapshot.promptLabelText,
          status: snapshot.statusLabelText,
          question: snapshot.questionLabelText,
        },
      )}`,
    );
  }

  for (const legacyLabel of ['QUESTION', 'WAITING', 'CHOICE']) {
    if (snapshot.cardText.includes(legacyLabel)) {
      throw new Error(
        `Inline question card should not show uppercase legacy label ${legacyLabel}: ${snapshot.cardText}`,
      );
    }
  }

  for (const expectedAction of ['Cancel Question', 'Submit Question']) {
    if (!snapshot.buttons.includes(expectedAction)) {
      throw new Error(
        `Inline question card missing action ${expectedAction}; buttons=${snapshot.buttons.join(
          ', ',
        )}`,
      );
    }
  }

  if (snapshot.hasLegacyMessageRole) {
    throw new Error('Inline question card should not use message-role chrome.');
  }

  if (snapshot.hasRawQuestionProtocol) {
    throw new Error('Ask-user-question protocol name leaked into the body.');
  }

  if (
    !snapshot.promptLabelStyle ||
    !snapshot.statusLabelStyle ||
    !snapshot.questionLabelStyle ||
    snapshot.promptLabelStyle.textTransform !== 'none' ||
    snapshot.statusLabelStyle.textTransform !== 'none' ||
    snapshot.questionLabelStyle.textTransform !== 'none' ||
    snapshot.promptLabelStyle.fontWeight > 700 ||
    snapshot.statusLabelStyle.fontWeight > 700 ||
    snapshot.questionLabelStyle.fontWeight > 700
  ) {
    throw new Error(
      `Inline question labels are too heavy: ${JSON.stringify({
        prompt: snapshot.promptLabelStyle,
        status: snapshot.statusLabelStyle,
        question: snapshot.questionLabelStyle,
      })}`,
    );
  }

  if (!snapshot.cardRect || !snapshot.timelineRect || !snapshot.composerRect) {
    throw new Error(
      `Inline question geometry is missing: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.cardRect.width < 360 || snapshot.cardRect.height > 170) {
    throw new Error(
      `Inline question card geometry is unexpected: ${JSON.stringify(
        snapshot.cardRect,
      )}`,
    );
  }

  if (
    snapshot.cardRect.left < snapshot.timelineRect.left ||
    snapshot.cardRect.right > snapshot.timelineRect.right + 1
  ) {
    throw new Error('Inline question card should stay inside the timeline.');
  }

  if (snapshot.cardRect.bottom > snapshot.composerRect.top) {
    throw new Error('Inline question card overlaps the composer.');
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
    const kindLabel = card?.querySelector('.conversation-activity-label');
    const statusLabel = card?.querySelector('.conversation-tool-status');
    const sectionLabels = card
      ? [...card.querySelectorAll('.conversation-tool-section-label')]
      : [];
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
        borderRadius: style.borderTopLeftRadius,
        color: style.color,
        fontSize: numberFromPixel(style.fontSize),
        fontWeight: numberFromPixel(style.fontWeight),
        textTransform: style.textTransform
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
      kindLabelText: kindLabel?.textContent.trim() ?? '',
      kindLabelStyle: styleFor(kindLabel),
      statusLabelText: statusLabel?.textContent.trim() ?? '',
      statusLabelStyle: styleFor(statusLabel),
      sectionLabels: sectionLabels.map((label) => ({
        text: label.textContent.trim(),
        style: styleFor(label)
      })),
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

  if (
    snapshot.kindLabelText !== 'Execute' ||
    snapshot.statusLabelText !== 'Completed' ||
    snapshot.sectionLabels.map((label) => label.text).join(',') !==
      'Input,Result'
  ) {
    throw new Error(
      `Resolved tool activity labels should use title-case product language: ${JSON.stringify(
        {
          kind: snapshot.kindLabelText,
          status: snapshot.statusLabelText,
          sections: snapshot.sectionLabels,
        },
      )}`,
    );
  }

  for (const legacyLabel of ['EXECUTE', 'INPUT', 'RESULT', 'COMPLETED']) {
    if (snapshot.cardText.includes(legacyLabel)) {
      throw new Error(
        `Resolved tool activity should not show uppercase legacy label ${legacyLabel}: ${snapshot.cardText}`,
      );
    }
  }

  if (!snapshot.cardRect || !snapshot.timelineRect || !snapshot.composerRect) {
    throw new Error(
      `Resolved tool activity geometry is missing: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.cardRect.width < 360 || snapshot.cardRect.height > 180) {
    throw new Error(
      `Resolved tool activity geometry is unexpected: ${JSON.stringify(
        snapshot.cardRect,
      )}`,
    );
  }

  if (snapshot.cardRect.height > 130) {
    throw new Error(
      `Resolved tool activity should be compact, not card-like: ${JSON.stringify(
        snapshot.cardRect,
      )}`,
    );
  }

  if (
    !snapshot.cardStyle ||
    !snapshot.previewStyle ||
    !snapshot.fileChipStyle ||
    !snapshot.kindLabelStyle ||
    !snapshot.statusLabelStyle ||
    snapshot.sectionLabels.some((label) => !label.style)
  ) {
    throw new Error(
      `Resolved tool activity styles are missing: ${JSON.stringify(snapshot)}`,
    );
  }

  if (
    snapshot.kindLabelStyle.textTransform !== 'none' ||
    snapshot.kindLabelStyle.fontWeight > 700 ||
    snapshot.statusLabelStyle.textTransform !== 'none' ||
    snapshot.statusLabelStyle.fontWeight > 700 ||
    snapshot.sectionLabels.some(
      (label) =>
        label.style.textTransform !== 'none' || label.style.fontWeight > 700,
    )
  ) {
    throw new Error(
      `Resolved tool activity labels are too heavy: ${JSON.stringify({
        kind: snapshot.kindLabelStyle,
        status: snapshot.statusLabelStyle,
        sections: snapshot.sectionLabels,
      })}`,
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
      actionButtonRects: actions
        ? [...actions.querySelectorAll('button')].map((button) =>
            rectFor(button)
          )
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

  if (snapshot.actionsRect.height > 30) {
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

    if (chipRect.width > 222 || chipRect.height > 23) {
      throw new Error(
        `Assistant file chip is too large: ${JSON.stringify(chipRect)}`,
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

  for (const actionRect of snapshot.actionButtonRects) {
    if (!actionRect) {
      throw new Error('Assistant action button geometry is missing.');
    }

    if (actionRect.width > 26 || actionRect.height > 26) {
      throw new Error(
        `Assistant action button should stay icon-sized: ${JSON.stringify(
          actionRect,
        )}`,
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

      const parts = color.match(/[\\d.]+/gu)?.map(Number) ?? [];
      if (parts.length < 4) {
        return 1;
      }

      const alpha = parts[3];
      return Number.isFinite(alpha) ? alpha : 1;
    };
    const rgbFromColor = (color) => {
      const parts = color?.match(/[\\d.]+/gu)?.map(Number) ?? [];
      return {
        red: Number.isFinite(parts[0]) ? parts[0] : 0,
        green: Number.isFinite(parts[1]) ? parts[1] : 0,
        blue: Number.isFinite(parts[2]) ? parts[2] : 0
      };
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
        backgroundRgb: rgbFromColor(style.backgroundColor),
        backgroundAlpha: alphaFromColor(style.backgroundColor),
        borderColor: style.borderTopColor,
        borderRgb: rgbFromColor(style.borderTopColor),
        borderAlpha: alphaFromColor(style.borderTopColor),
        borderTopWidth: numberFromPixel(style.borderTopWidth),
        borderRightWidth: numberFromPixel(style.borderRightWidth),
        borderBottomWidth: numberFromPixel(style.borderBottomWidth),
        borderLeftWidth: numberFromPixel(style.borderLeftWidth),
        borderRadius: style.borderTopLeftRadius,
        display: style.display,
        fontSize: numberFromPixel(style.fontSize),
        fontWeight: numberFromPixel(style.fontWeight),
        lineHeight: numberFromPixel(style.lineHeight),
        position: style.position,
        textTransform: style.textTransform
      };
    };
    const assistantMessage = [
      ...document.querySelectorAll('[data-testid="assistant-message"]')
    ].find((candidate) =>
      candidate.innerText.includes('E2E fake ACP response received')
    );
    const userMessage = document.querySelector('.chat-message-user');
    const assistantParagraph = assistantMessage?.querySelector('p');
    const userParagraph = userMessage?.querySelector('p');
    const plan = document.querySelector('.chat-plan');
    const planItem = plan?.querySelector('li');
    const planLabel = plan?.querySelector('.conversation-activity-label');
    const planCount = plan?.querySelector('.conversation-plan-count');
    const planStatuses = plan
      ? [...plan.querySelectorAll('.conversation-plan-status')]
      : [];
    const summary = document.querySelector(
      '[data-testid="conversation-changes-summary"]'
    );
    const chat = document.querySelector('[data-testid="chat-thread"]');
    const chatHeader = document.querySelector('.chat-header');
    const chatStatus = document.querySelector('.chat-status-announcement');
    const summaryAction = summary?.querySelector(
      'button[aria-label="Review Changes"]'
    );
    const firstSummaryRow = summary?.querySelector(
      '.conversation-changes-list li'
    );
    const firstSummaryRowLabel = firstSummaryRow?.querySelector('span');
    const timeline = document.querySelector('.chat-timeline');
    const composer = document.querySelector('[data-testid="message-composer"]');
    const composerTextarea = composer?.querySelector(
      'textarea[aria-label="Message"]'
    );
    const composerActionButtons = [
      ...document.querySelectorAll('.composer-actions button')
    ].map((button) => ({
      label: button.getAttribute('aria-label') || button.textContent.trim(),
      title: button.getAttribute('title') || '',
      className: button.className,
      hasIcon: button.querySelector('svg') !== null,
      hasSrOnly: button.querySelector('.sr-only') !== null,
      directText: [...button.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .join(''),
      disabled: button.disabled,
      rect: rectFor(button)
    }));
    const composerSelectControls = [
      ...document.querySelectorAll('.composer-select-shell')
    ].map((shell) => {
      const select = shell.querySelector('select');
      return {
        label: select?.getAttribute('aria-label') || '',
        title: select?.getAttribute('title') || '',
        hasLeadingIcon:
          shell.querySelector('.composer-select-leading-icon') !== null,
        hasChevron: shell.querySelector('.composer-select-chevron') !== null,
        rect: rectFor(shell),
        selectRect: rectFor(select),
        style: styleFor(select)
      };
    });
    const actionButtons = assistantMessage
      ? [
          ...assistantMessage.querySelectorAll(
            '[data-testid="assistant-message-actions"] button'
          )
        ]
      : [];

    return {
      chat: {
        rect: rectFor(chat),
        headerPresent: chatHeader !== null,
        statusText: chatStatus?.textContent.trim() ?? ''
      },
      assistant: {
        rect: rectFor(assistantMessage),
        style: styleFor(assistantMessage),
        label: assistantMessage?.getAttribute('aria-label') ?? '',
        hasRoleLabel: Boolean(assistantMessage?.querySelector('.message-role')),
        text: assistantMessage?.innerText ?? ''
      },
      user: {
        rect: rectFor(userMessage),
        style: styleFor(userMessage),
        label: userMessage?.getAttribute('aria-label') ?? '',
        hasRoleLabel: Boolean(userMessage?.querySelector('.message-role')),
        text: userMessage?.innerText ?? ''
      },
      assistantParagraph: {
        rect: rectFor(assistantParagraph),
        style: styleFor(assistantParagraph)
      },
      userParagraph: {
        rect: rectFor(userParagraph),
        style: styleFor(userParagraph)
      },
      plan: {
        rect: rectFor(plan),
        itemRect: rectFor(planItem),
        itemStyle: styleFor(planItem),
        labelText: planLabel?.textContent.trim() ?? '',
        labelStyle: styleFor(planLabel),
        countText: planCount?.textContent.trim() ?? '',
        countStyle: styleFor(planCount),
        statuses: planStatuses.map((status) => ({
          text: status.textContent.trim(),
          style: styleFor(status)
        })),
        text: plan?.innerText ?? ''
      },
      summary: {
        rect: rectFor(summary),
        style: styleFor(summary),
        actionRect: rectFor(summaryAction),
        rowRect: rectFor(firstSummaryRow),
        rowStyle: styleFor(firstSummaryRow),
        rowLabelStyle: styleFor(firstSummaryRowLabel)
      },
      timeline: rectFor(timeline),
      timelineText: timeline?.innerText ?? '',
      composer: {
        rect: rectFor(composer),
        textareaRect: rectFor(composerTextarea),
        actionButtons: composerActionButtons,
        selectControls: composerSelectControls
      },
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
    !snapshot.assistantParagraph.rect ||
    !snapshot.assistantParagraph.style ||
    !snapshot.userParagraph.rect ||
    !snapshot.userParagraph.style ||
    !snapshot.plan.rect ||
    !snapshot.plan.itemRect ||
    !snapshot.plan.itemStyle ||
    !snapshot.plan.labelStyle ||
    !snapshot.plan.countStyle ||
    snapshot.plan.statuses.some((status) => !status.style) ||
    !snapshot.summary.rect ||
    !snapshot.summary.style ||
    !snapshot.summary.actionRect ||
    !snapshot.summary.rowRect ||
    !snapshot.summary.rowStyle ||
    !snapshot.summary.rowLabelStyle ||
    !snapshot.chat.rect ||
    !snapshot.timeline ||
    !snapshot.composer.rect ||
    !snapshot.composer.textareaRect
  ) {
    throw new Error(
      `Conversation surface fidelity metrics are missing: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (snapshot.chat.headerPresent) {
    throw new Error('Conversation canvas should not render a visible header.');
  }

  if (!snapshot.chat.statusText.includes('Conversation')) {
    throw new Error(
      `Conversation canvas is missing the accessible status text: ${snapshot.chat.statusText}`,
    );
  }

  const timelineOffset = snapshot.timeline.top - snapshot.chat.rect.top;
  if (timelineOffset < -1 || timelineOffset > 4) {
    throw new Error(
      `Conversation timeline should start directly below the topbar: ${JSON.stringify(
        {
          chat: snapshot.chat.rect,
          timeline: snapshot.timeline,
          timelineOffset,
        },
      )}`,
    );
  }

  if (
    snapshot.assistantParagraph.style.fontSize > 13.5 ||
    snapshot.assistantParagraph.style.lineHeight > 20
  ) {
    throw new Error(
      `Assistant prose type scale is too large: ${JSON.stringify(
        snapshot.assistantParagraph.style,
      )}`,
    );
  }

  if (
    snapshot.userParagraph.style.fontSize > 13.5 ||
    snapshot.userParagraph.style.lineHeight > 20 ||
    snapshot.user.rect.height > 54
  ) {
    throw new Error(
      `User prompt bubble should stay compact: ${JSON.stringify({
        rect: snapshot.user.rect,
        paragraph: snapshot.userParagraph.style,
      })}`,
    );
  }

  if (
    snapshot.assistant.label !== 'Assistant message' ||
    snapshot.user.label !== 'User message'
  ) {
    throw new Error(
      `Message articles should expose accessible labels without visible role chrome: ${JSON.stringify(
        {
          assistant: snapshot.assistant.label,
          user: snapshot.user.label,
        },
      )}`,
    );
  }

  if (snapshot.assistant.hasRoleLabel || snapshot.user.hasRoleLabel) {
    throw new Error(
      `Messages should not render role-label text nodes: ${JSON.stringify({
        assistant: snapshot.assistant,
        user: snapshot.user,
      })}`,
    );
  }

  for (const roleText of [
    'Assistant message',
    'ASSISTANT MESSAGE',
    'User message',
    'USER MESSAGE',
  ]) {
    if (
      snapshot.assistant.text.includes(roleText) ||
      snapshot.user.text.includes(roleText) ||
      snapshot.timelineText.includes(roleText)
    ) {
      throw new Error(
        `Conversation text should not include role label ${roleText}: ${JSON.stringify(
          {
            assistant: snapshot.assistant.text,
            user: snapshot.user.text,
          },
        )}`,
      );
    }
  }

  if (
    snapshot.plan.itemStyle.fontSize > 12.5 ||
    snapshot.plan.itemStyle.lineHeight > 17 ||
    snapshot.plan.rect.height > 96 ||
    snapshot.plan.labelStyle.fontWeight > 700 ||
    snapshot.plan.labelStyle.textTransform !== 'none' ||
    snapshot.plan.statuses.some(
      (status) =>
        status.style.fontWeight > 700 || status.style.textTransform !== 'none',
    )
  ) {
    throw new Error(
      `Plan rows should stay compact: ${JSON.stringify(snapshot.plan)}`,
    );
  }

  if (
    snapshot.plan.labelText !== 'Plan' ||
    snapshot.plan.countText !== '2 tasks' ||
    snapshot.plan.statuses.map((status) => status.text).join(',') !==
      'Completed,In progress'
  ) {
    throw new Error(
      `Plan labels should use restrained title-case text: ${JSON.stringify(
        snapshot.plan,
      )}`,
    );
  }

  for (const legacyLabel of ['PLAN', 'COMPLETED', 'IN_PROGRESS']) {
    if (snapshot.plan.text.includes(legacyLabel)) {
      throw new Error(
        `Plan should not show uppercase legacy label ${legacyLabel}: ${snapshot.plan.text}`,
      );
    }
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

  const userBorderRgb = snapshot.user.style.borderRgb;
  if (
    snapshot.user.rect.width > 380 ||
    snapshot.user.style.backgroundAlpha < 0.05 ||
    snapshot.user.style.borderTopWidth < 1 ||
    userBorderRgb.blue < 180 ||
    userBorderRgb.blue <= userBorderRgb.red
  ) {
    throw new Error(
      `User prompt bubble lost compact blue accent treatment: ${JSON.stringify(
        snapshot.user,
      )}`,
    );
  }

  if (
    snapshot.summary.style.backgroundAlpha > 0.025 ||
    snapshot.summary.style.borderTopWidth > 0 ||
    snapshot.summary.style.borderRightWidth > 0 ||
    snapshot.summary.style.borderBottomWidth > 0 ||
    snapshot.summary.style.borderLeftWidth < 1.5 ||
    snapshot.summary.style.borderLeftWidth > 2.5
  ) {
    throw new Error(
      `Changed-files summary should render as an inline rail: ${JSON.stringify(
        snapshot.summary.style,
      )}`,
    );
  }

  if (snapshot.summary.rect.height > 100) {
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

  if (
    snapshot.summary.rowRect.height > 26 ||
    snapshot.summary.rowLabelStyle.fontSize > 11.2
  ) {
    throw new Error(
      `Changed-files rows should stay chip-sized: ${JSON.stringify({
        rect: snapshot.summary.rowRect,
        rowStyle: snapshot.summary.rowStyle,
        labelStyle: snapshot.summary.rowLabelStyle,
      })}`,
    );
  }

  if (snapshot.summary.actionRect.height > 28) {
    throw new Error(
      `Changed-files action is too tall: ${JSON.stringify(
        snapshot.summary.actionRect,
      )}`,
    );
  }

  if (
    snapshot.composer.rect.width > 840 ||
    snapshot.composer.rect.height > 94
  ) {
    throw new Error(
      `Composer should stay compact in the default conversation view: ${JSON.stringify(
        snapshot.composer.rect,
      )}`,
    );
  }

  if (snapshot.composer.textareaRect.height > 44) {
    throw new Error(
      `Composer textarea should stay short in the default conversation view: ${JSON.stringify(
        snapshot.composer.textareaRect,
      )}`,
    );
  }

  assertComposerActionButtons(snapshot.composer.actionButtons, {
    sendDisabled: true,
    stopDisabled: true,
  });

  if (snapshot.composer.selectControls.length !== 2) {
    throw new Error(
      `Conversation composer runtime controls are missing: ${JSON.stringify(
        snapshot.composer.selectControls,
      )}`,
    );
  }

  for (const control of snapshot.composer.selectControls) {
    if (
      !control.title ||
      !control.hasLeadingIcon ||
      !control.hasChevron ||
      !control.rect ||
      !control.selectRect ||
      !control.style
    ) {
      throw new Error(
        `Conversation composer runtime control shell regressed: ${JSON.stringify(
          control,
        )}`,
      );
    }

    if (
      control.rect.width > 128 ||
      control.rect.height > 25 ||
      control.selectRect.height > 25 ||
      control.style.fontSize > 11.2
    ) {
      throw new Error(
        `Conversation composer runtime control scale regressed: ${JSON.stringify(
          control,
        )}`,
      );
    }
  }

  for (const button of snapshot.actionButtons) {
    if (!button.rect || !button.style) {
      throw new Error(
        `Assistant action button metrics are missing: ${JSON.stringify(
          button,
        )}`,
      );
    }

    if (button.rect.width > 26 || button.rect.height > 26) {
      throw new Error(
        `Assistant action button should remain compact: ${JSON.stringify(
          button,
        )}`,
      );
    }

    if (
      button.style.backgroundAlpha > 0.02 ||
      button.style.borderAlpha > 0.08
    ) {
      throw new Error(
        `Assistant action button idle chrome is too heavy: ${JSON.stringify(
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

function assertComposerActionButtons(
  actionButtons,
  { sendDisabled, stopDisabled },
) {
  const actionByLabel = new Map(
    actionButtons.map((button) => [button.label, button]),
  );

  for (const [label, expected] of [
    ['Stop', { title: 'Stop generation', disabled: stopDisabled }],
    ['Send', { title: 'Send message', disabled: sendDisabled }],
  ]) {
    const button = actionByLabel.get(label);
    if (
      !button ||
      button.title !== expected.title ||
      button.disabled !== expected.disabled ||
      !button.hasIcon ||
      !button.hasSrOnly ||
      button.directText !== '' ||
      !button.className.includes('composer-action-button') ||
      !button.rect ||
      button.rect.width > 32 ||
      button.rect.height > 32
    ) {
      throw new Error(
        `Composer ${label} control is not compact and icon-led: ${JSON.stringify(
          button,
        )}`,
      );
    }
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
    const promptToken = ${JSON.stringify(longPromptToken)};
    const numberFromPixel = (value) => {
      const number = Number.parseFloat(value);
      return Number.isFinite(number) ? number : 0;
    };
    const typeStyleFor = (element) => {
      if (!element) {
        return null;
      }

      const style = window.getComputedStyle(element);
      return {
        fontSize: numberFromPixel(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        lineHeight: numberFromPixel(style.lineHeight),
        overflowWrap: style.overflowWrap,
        position: style.position,
        textTransform: style.textTransform,
        whiteSpace: style.whiteSpace,
        wordBreak: style.wordBreak
      };
    };
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
    const longAssistantMessage = [
      ...document.querySelectorAll('[data-testid="assistant-message"]')
    ].find((candidate) =>
      candidate.innerText.includes('E2E fake ACP question response recorded') &&
      candidate.innerText.includes(promptToken)
    );
    const userMessage = [...document.querySelectorAll('.chat-message-user')]
      .find((candidate) => candidate.innerText.includes(promptToken));
    const timeline = document.querySelector('.chat-timeline');
    const summary = document.querySelector(
      '[data-testid="conversation-changes-summary"]'
    );
    const composer = document.querySelector('[data-testid="message-composer"]');
    const composerActionButtons = [
      ...document.querySelectorAll('.composer-actions button')
    ].map((button) => ({
      label: button.getAttribute('aria-label') || button.textContent.trim(),
      title: button.getAttribute('title') || '',
      className: button.className,
      hasIcon: button.querySelector('svg') !== null,
      hasSrOnly: button.querySelector('.sr-only') !== null,
      directText: [...button.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .join(''),
      disabled: button.disabled,
      rect: rectFor(button)
    }));
    const composerSelectControls = [
      ...document.querySelectorAll('.composer-select-shell')
    ].map((shell) => {
      const select = shell.querySelector('select');
      return {
        label: select?.getAttribute('aria-label') || '',
        title: select?.getAttribute('title') || '',
        hasLeadingIcon:
          shell.querySelector('.composer-select-leading-icon') !== null,
        hasChevron: shell.querySelector('.composer-select-chevron') !== null,
        rect: rectFor(shell),
        selectRect: rectFor(select),
        style: typeStyleFor(select)
      };
    });
    const terminal = document.querySelector('[data-testid="terminal-drawer"]');
    const terminalBody = document.querySelector('[data-testid="terminal-body"]');
    const terminalToggle = document.querySelector(
      '[data-testid="terminal-toggle"]'
    );
    const terminalProject = document.querySelector(
      '[data-testid="terminal-strip-project"]'
    );
    const terminalStatus = document.querySelector(
      '[data-testid="terminal-strip-status"]'
    );
    const terminalPreview = document.querySelector(
      '[data-testid="terminal-strip-preview"]'
    );
    const chatHeader = document.querySelector('.chat-header');
    const chatStatus = document.querySelector('.chat-status-announcement');

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
    const messageParagraph = message?.querySelector('p');
    const longAssistantParagraph = longAssistantMessage?.querySelector('p');
    const userParagraph = userMessage?.querySelector('p');
    const plan = document.querySelector('.chat-plan');
    const planItem = plan?.querySelector('li');
    const actions = message?.querySelector(
      '[data-testid="assistant-message-actions"]'
    );
    const messageRect = rectFor(message);
    const longAssistantMessageRect = rectFor(longAssistantMessage);
    const userMessageRect = rectFor(userMessage);
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
    if (timeline) {
      timeline.scrollTop = timeline.scrollHeight;
    }
    const bottomScroll = {
      summaryRect: rectFor(summary),
      timelineRect: rectFor(timeline),
      composerRect: rectFor(composer)
    };

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
      chatHeaderPresent: chatHeader !== null,
      chatStatusText: chatStatus?.textContent.trim() ?? '',
      timeline: timelineRect,
      message: messageRect,
      messageLabel: message?.getAttribute('aria-label') ?? '',
      messageHasRoleLabel: Boolean(message?.querySelector('.message-role')),
      messageText: message?.innerText ?? '',
      longAssistantMessage: longAssistantMessageRect,
      longAssistantMessageLabel:
        longAssistantMessage?.getAttribute('aria-label') ?? '',
      longAssistantMessageHasRoleLabel: Boolean(
        longAssistantMessage?.querySelector('.message-role')
      ),
      longAssistantMessageText: longAssistantMessage?.innerText ?? '',
      userMessage: userMessageRect,
      userMessageLabel: userMessage?.getAttribute('aria-label') ?? '',
      userMessageHasRoleLabel: Boolean(
        userMessage?.querySelector('.message-role')
      ),
      userMessageText: userMessage?.innerText ?? '',
      timelineText: timeline?.innerText ?? '',
      messageParagraphStyle: typeStyleFor(messageParagraph),
      longAssistantParagraphStyle: typeStyleFor(longAssistantParagraph),
      userParagraphStyle: typeStyleFor(userParagraph),
      promptTokenInAssistant: Boolean(
        longAssistantMessage?.innerText.includes(promptToken)
      ),
      promptTokenInUser: Boolean(userMessage?.innerText.includes(promptToken)),
      plan: rectFor(plan),
      planItemStyle: typeStyleFor(planItem),
      fileReferences: rectFor(fileReferences),
      actions: rectFor(actions),
      summary: rectFor(summary),
      composer: composerRect,
      composerActionButtons,
      composerSelectControls,
      terminal: rectFor(terminal),
      terminalToggle: rectFor(terminalToggle),
      terminalProject: rectFor(terminalProject),
      terminalStatus: rectFor(terminalStatus),
      terminalStatusStyle: typeStyleFor(terminalStatus),
      terminalPreview: rectFor(terminalPreview),
      terminalVisibleLabelText:
        terminalToggle?.querySelector('.message-role')?.textContent.trim() ??
        null,
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
      bottomScroll,
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
      longAssistantMessageContained: isContained(
        longAssistantMessageRect,
        timelineRect
      ),
      userMessageContained: isContained(userMessageRect, timelineRect),
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
        longAssistantMessage: overflows(longAssistantMessage),
        userMessage: overflows(userMessage),
        fileReferences: overflows(fileReferences),
        composer: overflows(composer),
        composerContext: overflows(document.querySelector('.composer-context')),
        composerActions: overflows(document.querySelector('.composer-actions')),
        terminalToggle: overflows(terminalToggle)
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
    'longAssistantMessage',
    'userMessage',
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

  if (
    !snapshot.messageParagraphStyle ||
    !snapshot.longAssistantParagraphStyle ||
    !snapshot.userParagraphStyle ||
    !snapshot.planItemStyle
  ) {
    throw new Error(
      `Compact conversation type metrics are missing: ${JSON.stringify({
        messageParagraphStyle: snapshot.messageParagraphStyle,
        longAssistantParagraphStyle: snapshot.longAssistantParagraphStyle,
        userParagraphStyle: snapshot.userParagraphStyle,
        planItemStyle: snapshot.planItemStyle,
      })}`,
    );
  }

  if (snapshot.chatHeaderPresent) {
    throw new Error(
      'Compact dense conversation should not render a chat header.',
    );
  }

  if (!snapshot.chatStatusText.includes('Conversation')) {
    throw new Error(
      `Compact dense conversation is missing the accessible status text: ${snapshot.chatStatusText}`,
    );
  }

  const compactTimelineOffset = snapshot.timeline.top - snapshot.chat.top;
  if (compactTimelineOffset < -1 || compactTimelineOffset > 4) {
    throw new Error(
      `Compact conversation timeline should start directly below the topbar: ${JSON.stringify(
        {
          chat: snapshot.chat,
          timeline: snapshot.timeline,
          compactTimelineOffset,
        },
      )}`,
    );
  }

  if (
    snapshot.messageParagraphStyle.fontSize > 13.5 ||
    snapshot.messageParagraphStyle.lineHeight > 20
  ) {
    throw new Error(
      `Compact assistant prose type scale is too large: ${JSON.stringify(
        snapshot.messageParagraphStyle,
      )}`,
    );
  }

  if (snapshot.messageLabel !== 'Assistant message') {
    throw new Error(
      `Compact assistant message is missing its accessible label: ${snapshot.messageLabel}`,
    );
  }

  if (snapshot.messageHasRoleLabel) {
    throw new Error('Compact assistant message rendered a role-label node.');
  }

  if (snapshot.longAssistantMessageLabel !== 'Assistant message') {
    throw new Error(
      `Compact long assistant message is missing its accessible label: ${snapshot.longAssistantMessageLabel}`,
    );
  }

  if (snapshot.longAssistantMessageHasRoleLabel) {
    throw new Error(
      'Compact long assistant message rendered a role-label node.',
    );
  }

  if (snapshot.userMessageLabel !== 'User message') {
    throw new Error(
      `Compact user message is missing its accessible label: ${snapshot.userMessageLabel}`,
    );
  }

  if (snapshot.userMessageHasRoleLabel) {
    throw new Error('Compact user message rendered a role-label node.');
  }

  if (!snapshot.promptTokenInAssistant || !snapshot.promptTokenInUser) {
    throw new Error(
      `Compact long prompt token is missing from the conversation: ${JSON.stringify(
        {
          promptTokenInAssistant: snapshot.promptTokenInAssistant,
          promptTokenInUser: snapshot.promptTokenInUser,
          longAssistantMessageText: snapshot.longAssistantMessageText,
          userMessageText: snapshot.userMessageText,
        },
      )}`,
    );
  }

  for (const [name, style] of Object.entries({
    assistant: snapshot.longAssistantParagraphStyle,
    user: snapshot.userParagraphStyle,
  })) {
    if (style.overflowWrap !== 'anywhere') {
      throw new Error(
        `Compact ${name} message prose should wrap long tokens: ${JSON.stringify(
          style,
        )}`,
      );
    }
  }

  for (const roleText of [
    'Assistant message',
    'ASSISTANT MESSAGE',
    'User message',
    'USER MESSAGE',
  ]) {
    if (
      snapshot.messageText.includes(roleText) ||
      snapshot.timelineText.includes(roleText)
    ) {
      throw new Error(
        `Compact conversation text should not include role label ${roleText}.`,
      );
    }
  }

  if (
    snapshot.planItemStyle.fontSize > 12.5 ||
    snapshot.planItemStyle.lineHeight > 17
  ) {
    throw new Error(
      `Compact plan row type scale is too large: ${JSON.stringify(
        snapshot.planItemStyle,
      )}`,
    );
  }

  if (snapshot.message.height > 218) {
    throw new Error(
      `Compact assistant message should stay dense: ${snapshot.message.height}`,
    );
  }

  if (snapshot.document.bodyScrollWidth > snapshot.viewport.width + 4) {
    throw new Error(
      `Compact layout caused horizontal body overflow: ${JSON.stringify(
        snapshot.document,
      )}`,
    );
  }

  if (snapshot.sidebar.width < 228 || snapshot.sidebar.width > 236) {
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

  if (snapshot.terminal.height < 38 || snapshot.terminal.height > 52) {
    throw new Error(
      `Compact terminal strip height is unexpected: ${snapshot.terminal.height}`,
    );
  }

  if (
    !snapshot.terminalToggle ||
    snapshot.terminalToggle.height < 30 ||
    snapshot.terminalToggle.height > 36
  ) {
    throw new Error(
      `Compact terminal toggle should stay slim: ${JSON.stringify(
        snapshot.terminalToggle,
      )}`,
    );
  }

  if (snapshot.terminalVisibleLabelText !== null) {
    throw new Error(
      `Compact terminal should not render a visible section label: ${snapshot.terminalVisibleLabelText}`,
    );
  }

  if (
    !snapshot.terminalStatusStyle ||
    snapshot.terminalStatusStyle.textTransform !== 'none' ||
    snapshot.terminalStatusStyle.fontWeight > 720 ||
    snapshot.terminalStatusStyle.fontSize > 11.2
  ) {
    throw new Error(
      `Compact terminal status should stay normal-case and restrained: ${JSON.stringify(
        snapshot.terminalStatusStyle,
      )}`,
    );
  }

  if (snapshot.overflow.terminalToggle) {
    throw new Error('Compact terminal toggle overflowed.');
  }

  for (const [key, rect] of Object.entries({
    project: snapshot.terminalProject,
    status: snapshot.terminalStatus,
    preview: snapshot.terminalPreview,
  })) {
    if (
      !rect ||
      rect.left < snapshot.terminalToggle.left - 1 ||
      rect.right > snapshot.terminalToggle.right + 1
    ) {
      throw new Error(
        `Compact terminal ${key} is not contained in the strip: ${JSON.stringify(
          rect,
        )}`,
      );
    }
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

  if (
    !snapshot.bottomScroll.summaryRect ||
    !snapshot.bottomScroll.timelineRect ||
    !snapshot.bottomScroll.composerRect
  ) {
    throw new Error(
      `Compact bottom scroll metrics are missing: ${JSON.stringify(
        snapshot.bottomScroll,
      )}`,
    );
  }

  if (
    snapshot.bottomScroll.summaryRect.bottom >
    snapshot.bottomScroll.composerRect.top + 1
  ) {
    throw new Error(
      `Compact changed-files summary should not sit behind the composer: ${JSON.stringify(
        snapshot.bottomScroll,
      )}`,
    );
  }

  if (
    !isRectContained(
      snapshot.bottomScroll.summaryRect,
      snapshot.bottomScroll.timelineRect,
    )
  ) {
    throw new Error(
      `Compact changed-files summary should remain inside the timeline after bottom scroll: ${JSON.stringify(
        snapshot.bottomScroll,
      )}`,
    );
  }

  if (snapshot.summary && snapshot.summary.height > 100) {
    throw new Error(
      `Compact changed-files summary should stay compact: ${snapshot.summary.height}`,
    );
  }

  if (snapshot.composer.height > 96) {
    throw new Error(
      `Compact composer should not crowd the conversation: ${snapshot.composer.height}`,
    );
  }

  assertComposerActionButtons(snapshot.composerActionButtons, {
    sendDisabled: true,
    stopDisabled: true,
  });

  if (snapshot.composerSelectControls.length !== 2) {
    throw new Error(
      `Compact composer runtime controls are missing: ${JSON.stringify(
        snapshot.composerSelectControls,
      )}`,
    );
  }

  for (const control of snapshot.composerSelectControls) {
    if (
      !control.title ||
      !control.hasLeadingIcon ||
      !control.hasChevron ||
      !control.rect ||
      !control.selectRect ||
      !control.style
    ) {
      throw new Error(
        `Compact composer runtime control shell regressed: ${JSON.stringify(
          control,
        )}`,
      );
    }

    if (
      control.rect.width > 108 ||
      control.rect.height > 25 ||
      control.selectRect.height > 25 ||
      control.style.fontSize > 11.2
    ) {
      throw new Error(
        `Compact composer runtime control scale regressed: ${JSON.stringify(
          control,
        )}`,
      );
    }
  }

  if (!snapshot.messageContained) {
    throw new Error('Dense assistant message escaped the compact timeline.');
  }

  if (!snapshot.longAssistantMessageContained) {
    throw new Error(
      'Dense long assistant message escaped the compact timeline.',
    );
  }

  if (!snapshot.userMessageContained) {
    throw new Error('Dense user message escaped the compact timeline.');
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

    if (chipRect.width > 222 || chipRect.height > 24) {
      throw new Error(
        `Compact assistant chip is too large: ${JSON.stringify(chipRect)}`,
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

    if (actionRect.width > 28 || actionRect.height > 28) {
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

  if (snapshot.composerValue !== commandApprovalPrompt) {
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
    const rectForElement = (element) => {
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
    const styleForElement = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        textTransform: style.textTransform
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
      reviewButtons: Array.from(
        document.querySelectorAll('[data-testid="review-panel"] button')
      ).map((button) => ({
        label:
          button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          button.textContent.trim(),
        title: button.getAttribute('title') || '',
        className: button.className,
        hasIcon: button.querySelector('svg') !== null,
        hasSrOnly: button.querySelector('.sr-only') !== null,
        directText: [...button.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(''),
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height
      })),
      reviewTabs: Array.from(
        document.querySelectorAll(
          '[data-testid="review-panel"] .review-tabs button',
        )
      ).map((button) => ({
        label:
          button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          button.textContent.trim(),
        title: button.getAttribute('title') || '',
        hasIcon: button.querySelector('svg') !== null,
        directText: [...button.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(''),
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height
      })),
      reviewMetaItems: Array.from(
        document.querySelectorAll('.runtime-details-compact div')
      ).map((item) => ({
        label: item.querySelector('dt')?.textContent.trim() ?? '',
        value: item.querySelector('dd')?.textContent.trim() ?? '',
        width: item.getBoundingClientRect().width,
        height: item.getBoundingClientRect().height
      })),
      supportLabelStyles: {
        changedFileMeta: styleForElement(
          document.querySelector('.changed-files summary small')
        ),
        hunkSource: styleForElement(
          document.querySelector('.diff-hunk-header small')
        ),
        reviewNote: styleForElement(
          document.querySelector('.review-comment-prompt')
        ),
        terminalStatus: styleForElement(
          document.querySelector('[data-testid="terminal-strip-status"]')
        )
      },
      commentBox: rectFor('.review-comment-box'),
      commentEditor: rectFor('[data-testid="review-comment-editor"]'),
      commentTextarea: rectFor('[aria-label="Review comment for README.md"]'),
      composerActionButtons: [
        ...document.querySelectorAll('.composer-actions button')
      ].map((button) => ({
        label: button.getAttribute('aria-label') || button.textContent.trim(),
        title: button.getAttribute('title') || '',
        className: button.className,
        hasIcon: button.querySelector('svg') !== null,
        hasSrOnly: button.querySelector('.sr-only') !== null,
        directText: [...button.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(''),
        disabled: button.disabled,
        rect: rectForElement(button)
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
  for (const expectedLabel of ['Conversation', 'Close Changes', 'Settings']) {
    if (!labels.includes(expectedLabel)) {
      throw new Error(
        `Missing compact topbar action ${expectedLabel}; labels=${labels.join(
          ', ',
        )}`,
      );
    }
  }
  if (labels.includes('Refresh Git')) {
    throw new Error(
      `Refresh Git should live in the review drawer, not the topbar: ${labels.join(
        ', ',
      )}`,
    );
  }

  const reviewLabels = metrics.reviewButtons.map((button) => button.label);
  if (!reviewLabels.includes('Refresh Git')) {
    throw new Error(
      `Review drawer should expose Refresh Git; labels=${reviewLabels.join(
        ', ',
      )}`,
    );
  }
  assertReviewActionButtonDensity(metrics.reviewButtons, 'review drawer');

  if (metrics.reviewTabs.length !== 4) {
    throw new Error(
      `Review drawer should keep four compact section tabs: ${JSON.stringify(
        metrics.reviewTabs,
      )}`,
    );
  }
  for (const tab of metrics.reviewTabs) {
    if (!tab.hasIcon || !tab.title || tab.directText !== '') {
      throw new Error(
        `Review tab should be icon-led with title metadata: ${JSON.stringify(
          tab,
        )}`,
      );
    }
    if (tab.height > 34) {
      throw new Error(
        `Review tab height should stay compact: ${JSON.stringify(tab)}`,
      );
    }
  }

  if (metrics.reviewMetaItems.length < 5) {
    throw new Error(
      `Review metadata strip is missing Git context: ${JSON.stringify(
        metrics.reviewMetaItems,
      )}`,
    );
  }
  for (const item of metrics.reviewMetaItems) {
    if (item.height > 28) {
      throw new Error(
        `Review metadata item should stay compact: ${JSON.stringify(item)}`,
      );
    }
  }

  for (const [name, style] of Object.entries(metrics.supportLabelStyles)) {
    if (
      !style ||
      style.textTransform !== 'none' ||
      style.fontWeight > 720 ||
      style.fontSize > 11.2
    ) {
      throw new Error(
        `Review support label ${name} should stay normal-case and restrained: ${JSON.stringify(
          style,
        )}`,
      );
    }
  }

  if (metrics.commentBox === null || metrics.commentBox.height > 56) {
    throw new Error(
      `Collapsed review comment box should stay compact: ${JSON.stringify(
        metrics.commentBox,
      )}`,
    );
  }
  if (metrics.commentEditor !== null || metrics.commentTextarea !== null) {
    throw new Error('Review comment editor should be collapsed by default.');
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

  if (metrics.terminal.height < 38 || metrics.terminal.height > 52) {
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

  assertComposerActionButtons(metrics.composerActionButtons, {
    sendDisabled: true,
    stopDisabled: true,
  });

  if (metrics.document.bodyScrollHeight > metrics.viewport.height + 4) {
    throw new Error(
      `Review drawer document should fit one viewport; body scrollHeight=${metrics.document.bodyScrollHeight}, viewport=${metrics.viewport.height}`,
    );
  }
}

function assertReviewActionButtonDensity(buttons, context) {
  const expected = [
    'Discard All',
    'Stage All',
    'Open',
    'Discard File',
    'Stage File',
    'Discard Hunk',
    'Stage Hunk',
    'Add Comment',
    'Commit',
  ];
  const labels = buttons.map((button) => button.label);

  for (const label of expected) {
    const button = buttons.find((candidate) => candidate.label === label);
    if (!button) {
      throw new Error(
        `${context} missing review action ${label}; labels=${labels.join(
          ', ',
        )}`,
      );
    }

    if (!button.hasIcon || !button.hasSrOnly || button.directText !== '') {
      throw new Error(
        `${context} action ${label} should be icon-led with sr-only text: ${JSON.stringify(
          button,
        )}`,
      );
    }

    if (button.width > 42 || button.height > 42) {
      throw new Error(
        `${context} action ${label} should stay compact: ${JSON.stringify(
          button,
        )}`,
      );
    }

    if (label.startsWith('Discard') && !button.className.includes('danger')) {
      throw new Error(
        `${context} discard action ${label} lost danger styling: ${JSON.stringify(
          button,
        )}`,
      );
    }

    if (label === 'Commit' && !button.className.includes('primary')) {
      throw new Error(
        `${context} commit action should keep primary styling: ${JSON.stringify(
          button,
        )}`,
      );
    }
  }
}

async function assertReviewCommentEditorChrome(fileName) {
  const snapshot = await evaluate(`(() => {
    const editor = document.querySelector('[data-testid="review-comment-editor"]');
    const label = editor?.querySelector('span') ?? null;
    const textarea = document.querySelector(
      '[aria-label="Review comment for README.md"]'
    );
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        textTransform: style.textTransform
      };
    };

    return {
      editor: rectFor(editor),
      labelText: label?.textContent.trim() ?? '',
      labelStyle: styleFor(label),
      textarea: rectFor(textarea),
      textareaLabel: textarea?.getAttribute('aria-label') ?? ''
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    !snapshot.editor ||
    !snapshot.textarea ||
    snapshot.textareaLabel !== 'Review comment for README.md'
  ) {
    throw new Error(
      `Review comment editor should be open and accessible: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.labelText !== 'Comment' ||
    !snapshot.labelStyle ||
    snapshot.labelStyle.textTransform !== 'none' ||
    snapshot.labelStyle.fontWeight > 720 ||
    snapshot.labelStyle.fontSize > 11.2
  ) {
    throw new Error(
      `Review comment label should stay normal-case and restrained: ${JSON.stringify(
        snapshot,
      )}`,
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
    const rectForElement = (element) => {
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
    const styleForElement = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
        textTransform: style.textTransform
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
      title: button.getAttribute('title') || '',
      className: button.className,
      hasIcon: button.querySelector('svg') !== null,
      hasSrOnly: button.querySelector('.sr-only') !== null,
      directText: [...button.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .join(''),
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
      composerActionButtons: [
        ...document.querySelectorAll('.composer-actions button')
      ].map((button) => ({
        label: button.getAttribute('aria-label') || button.textContent.trim(),
        title: button.getAttribute('title') || '',
        className: button.className,
        hasIcon: button.querySelector('svg') !== null,
        hasSrOnly: button.querySelector('.sr-only') !== null,
        directText: [...button.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(''),
        disabled: button.disabled,
        rect: rectForElement(button)
      })),
      composerSelectControls: [
        ...document.querySelectorAll('.composer-select-shell')
      ].map((shell) => {
        const select = shell.querySelector('select');
        const style = select ? window.getComputedStyle(select) : null;
        return {
          label: select?.getAttribute('aria-label') || '',
          title: select?.getAttribute('title') || '',
          hasLeadingIcon:
            shell.querySelector('.composer-select-leading-icon') !== null,
          hasChevron: shell.querySelector('.composer-select-chevron') !== null,
          rect: rectForElement(shell),
          selectRect: rectForElement(select),
          fontSize: style ? Number.parseFloat(style.fontSize) : null
        };
      }),
      reviewButtons,
      reviewTabs: [
        ...document.querySelectorAll(
          '[data-testid="review-panel"] .review-tabs button'
        )
      ].map((button) => ({
        label:
          button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          button.textContent.trim(),
        title: button.getAttribute('title') || '',
        hasIcon: button.querySelector('svg') !== null,
        directText: [...button.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(''),
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height
      })),
      reviewMetaItems: [
        ...document.querySelectorAll('.runtime-details-compact div')
      ].map((item) => ({
        label: item.querySelector('dt')?.textContent.trim() ?? '',
        value: item.querySelector('dd')?.textContent.trim() ?? '',
        width: item.getBoundingClientRect().width,
        height: item.getBoundingClientRect().height
      })),
      supportLabelStyles: {
        changedFileMeta: styleForElement(
          document.querySelector('.changed-files summary small')
        ),
        hunkSource: styleForElement(
          document.querySelector('.diff-hunk-header small')
        ),
        reviewNote: styleForElement(
          document.querySelector('.review-comment-prompt')
        ),
        terminalStatus: styleForElement(
          document.querySelector('[data-testid="terminal-strip-status"]')
        )
      },
      commentBox: rectFor('.review-comment-box'),
      commentEditor: rectFor('[data-testid="review-comment-editor"]'),
      commentTextarea: rectFor('[aria-label="Review comment for README.md"]'),
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

  if (metrics.sidebar.width < 228 || metrics.sidebar.width > 236) {
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
  for (const expectedLabel of ['Conversation', 'Close Changes', 'Settings']) {
    if (!topbarLabels.includes(expectedLabel)) {
      throw new Error(
        `Compact review missing topbar action ${expectedLabel}: ${topbarLabels.join(
          ', ',
        )}`,
      );
    }
  }
  if (topbarLabels.includes('Refresh Git')) {
    throw new Error(
      `Compact review should keep Refresh Git out of the topbar: ${topbarLabels.join(
        ', ',
      )}`,
    );
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

  if (metrics.terminal.height < 38 || metrics.terminal.height > 52) {
    throw new Error(
      `Compact review terminal strip height is unexpected: ${metrics.terminal.height}`,
    );
  }

  if (metrics.composer.height > 142) {
    throw new Error(
      `Compact review composer should stay bounded: ${metrics.composer.height}`,
    );
  }

  if (
    metrics.composerTextareaHeight === null ||
    metrics.composerTextareaHeight > 44
  ) {
    throw new Error(
      `Compact review textarea should stay short: ${metrics.composerTextareaHeight}`,
    );
  }

  assertComposerActionButtons(metrics.composerActionButtons, {
    sendDisabled: true,
    stopDisabled: true,
  });

  if (metrics.composerSelectControls.length !== 2) {
    throw new Error(
      `Compact review composer runtime controls are missing: ${JSON.stringify(
        metrics.composerSelectControls,
      )}`,
    );
  }

  for (const control of metrics.composerSelectControls) {
    if (
      !control.title ||
      !control.hasLeadingIcon ||
      !control.hasChevron ||
      !control.rect ||
      !control.selectRect ||
      control.fontSize === null
    ) {
      throw new Error(
        `Compact review composer runtime control shell regressed: ${JSON.stringify(
          control,
        )}`,
      );
    }

    if (
      control.rect.width > 100 ||
      control.rect.height > 25 ||
      control.selectRect.height > 25 ||
      control.fontSize > 11.2
    ) {
      throw new Error(
        `Compact review composer runtime control scale regressed: ${JSON.stringify(
          control,
        )}`,
      );
    }
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
    'Refresh Git',
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
        `Compact review missing action ${expectedLabel}: ${labels.join(', ')}`,
      );
    }
  }
  assertReviewActionButtonDensity(metrics.reviewButtons, 'compact review');

  if (metrics.reviewTabs.length !== 4) {
    throw new Error(
      `Compact review should keep four section tabs: ${JSON.stringify(
        metrics.reviewTabs,
      )}`,
    );
  }
  for (const tab of metrics.reviewTabs) {
    if (!tab.hasIcon || !tab.title || tab.directText !== '') {
      throw new Error(
        `Compact review tab should be icon-led with title metadata: ${JSON.stringify(
          tab,
        )}`,
      );
    }
    if (tab.height > 32) {
      throw new Error(
        `Compact review tab height regressed: ${JSON.stringify(tab)}`,
      );
    }
  }

  if (metrics.reviewMetaItems.length < 5) {
    throw new Error(
      `Compact review metadata strip is missing Git context: ${JSON.stringify(
        metrics.reviewMetaItems,
      )}`,
    );
  }
  for (const item of metrics.reviewMetaItems) {
    if (item.height > 26) {
      throw new Error(
        `Compact review metadata item should stay short: ${JSON.stringify(
          item,
        )}`,
      );
    }
  }

  for (const [name, style] of Object.entries(metrics.supportLabelStyles)) {
    if (
      !style ||
      style.textTransform !== 'none' ||
      style.fontWeight > 720 ||
      style.fontSize > 11.2
    ) {
      throw new Error(
        `Compact review support label ${name} should stay normal-case and restrained: ${JSON.stringify(
          style,
        )}`,
      );
    }
  }

  if (metrics.commentBox === null || metrics.commentBox.height > 50) {
    throw new Error(
      `Compact collapsed comment box should stay short: ${JSON.stringify(
        metrics.commentBox,
      )}`,
    );
  }
  if (metrics.commentEditor !== null || metrics.commentTextarea !== null) {
    throw new Error(
      'Compact review comment editor should be collapsed by default.',
    );
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
    !/Modified\s+1\s+Staged\s+0\s+Untracked\s+1/iu.test(snapshot.reviewText)
  ) {
    throw new Error(
      'Discard confirmation opened after the review counts already changed.',
    );
  }
}

async function assertReviewStageAllResult(fileName) {
  await waitFor(
    'review staged state after Stage All',
    async () =>
      evaluate(`(() => {
        const review = document.querySelector('[data-testid="review-panel"]');
        const gitStatus = document.querySelector(
          '[data-testid="topbar-git-status"]'
        );
        const stats = Object.fromEntries(
          [...(review?.querySelectorAll('.runtime-details-compact div') ?? [])]
            .map((row) => [
              row.querySelector('dt')?.textContent.trim() ?? '',
              row.querySelector('dd')?.textContent.trim() ?? ''
            ])
        );
        return (
          stats.Modified === '0' &&
          stats.Staged === '2' &&
          stats.Untracked === '0' &&
          gitStatus?.textContent.trim() === '+2 -1' &&
          gitStatus?.getAttribute('title')?.includes(
            '0 modified · 2 staged · 0 untracked'
          ) === true &&
          (review?.innerText ?? '').includes('added · 1 hunk')
        );
      })()`),
    10_000,
  );

  const snapshot = await evaluate(`(() => {
    const review = document.querySelector('[data-testid="review-panel"]');
    const gitStatus = document.querySelector('[data-testid="topbar-git-status"]');
    const stats = Object.fromEntries(
      [...(review?.querySelectorAll('.runtime-details-compact div') ?? [])]
        .map((row) => [
          row.querySelector('dt')?.textContent.trim() ?? '',
          row.querySelector('dd')?.textContent.trim() ?? ''
        ])
    );
    return {
      topbarText: gitStatus?.textContent.trim() ?? '',
      topbarTitle: gitStatus?.getAttribute('title') ?? '',
      topbarAriaLabel: gitStatus?.getAttribute('aria-label') ?? '',
      stats,
      reviewText: review?.innerText ?? ''
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    snapshot.stats.Modified !== '0' ||
    snapshot.stats.Staged !== '2' ||
    snapshot.stats.Untracked !== '0'
  ) {
    throw new Error(
      `Stage All did not update review counts: ${JSON.stringify(snapshot)}`,
    );
  }

  if (
    snapshot.topbarText !== '+2 -1' ||
    !snapshot.topbarTitle.includes('0 modified · 2 staged · 0 untracked') ||
    !snapshot.topbarTitle.includes('Diff +2 -1') ||
    !snapshot.topbarAriaLabel.includes('0 modified · 2 staged · 0 untracked')
  ) {
    throw new Error(
      `Stage All did not preserve topbar diff metadata: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (!snapshot.reviewText.includes('added · 1 hunk')) {
    throw new Error(
      `Stage All did not update changed-file states: ${snapshot.reviewText}`,
    );
  }

  if (snapshot.reviewText.includes('ADDED · 1 HUNK')) {
    throw new Error(
      `Stage All retained uppercase changed-file metadata: ${snapshot.reviewText}`,
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
      terminalCommandRow: rectFor('[data-testid="terminal-command-row"]'),
      terminalInputRow: rectFor('.terminal-input-row'),
      terminalActions: rectFor('[data-testid="terminal-actions"]'),
      terminalRunButton: rectFor('[data-testid="terminal-run-button"]'),
      terminalInputButton: rectFor('[data-testid="terminal-input-button"]'),
      terminalExpanded:
        document
          .querySelector('[data-testid="terminal-toggle"]')
          ?.getAttribute('aria-expanded') ?? null,
      terminalControls: (() => {
        const commandRow = document.querySelector(
          '[data-testid="terminal-command-row"]',
        );
        const actions = document.querySelector(
          '[data-testid="terminal-actions"]',
        );
        const runButton = document.querySelector(
          '[data-testid="terminal-run-button"]',
        );
        const inputButton = document.querySelector(
          '[data-testid="terminal-input-button"]',
        );
        return {
          actionsParentTestId:
            actions?.parentElement?.getAttribute('data-testid') ?? null,
          actionsInCommandRow: Boolean(commandRow?.contains(actions)),
          runLabel: runButton?.getAttribute('aria-label') ?? null,
          inputLabel: inputButton?.getAttribute('aria-label') ?? null,
          runTitle: runButton?.getAttribute('title') ?? null,
          inputTitle: inputButton?.getAttribute('title') ?? null,
          runHasIcon: Boolean(runButton?.querySelector('svg')),
          inputHasIcon: Boolean(inputButton?.querySelector('svg')),
          runHasSrOnly: Boolean(runButton?.querySelector('.sr-only')),
          inputHasSrOnly: Boolean(inputButton?.querySelector('.sr-only')),
          standaloneActionsRow: Boolean(
            actions?.parentElement?.classList.contains('terminal-body'),
          )
        };
      })()
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
    'terminalCommandRow',
    'terminalInputRow',
    'terminalActions',
    'terminalRunButton',
    'terminalInputButton',
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

  if (!metrics.terminalControls.actionsInCommandRow) {
    throw new Error('Terminal actions should be grouped with the command row.');
  }

  if (metrics.terminalControls.standaloneActionsRow) {
    throw new Error('Terminal actions should not consume a standalone row.');
  }

  if (
    metrics.terminalControls.runLabel !== 'Run' ||
    metrics.terminalControls.inputLabel !== 'Send Input' ||
    !metrics.terminalControls.runTitle ||
    !metrics.terminalControls.inputTitle ||
    !metrics.terminalControls.runHasIcon ||
    !metrics.terminalControls.inputHasIcon ||
    !metrics.terminalControls.runHasSrOnly ||
    !metrics.terminalControls.inputHasSrOnly
  ) {
    throw new Error(
      `Terminal submit controls are not compact accessible icon buttons: ${JSON.stringify(
        metrics.terminalControls,
      )}`,
    );
  }

  for (const [name, rect] of [
    ['run', metrics.terminalRunButton],
    ['send input', metrics.terminalInputButton],
  ]) {
    if (rect.width > 38 || rect.height > 38) {
      throw new Error(
        `Terminal ${name} button should stay compact: ${JSON.stringify(rect)}`,
      );
    }
  }

  for (const [name, rect] of [
    ['command row', metrics.terminalCommandRow],
    ['input row', metrics.terminalInputRow],
    ['actions', metrics.terminalActions],
  ]) {
    if (
      rect.left < metrics.terminalBody.left - 1 ||
      rect.right > metrics.terminalBody.right + 1
    ) {
      throw new Error(
        `Terminal ${name} overflows the drawer body: ${JSON.stringify(rect)}`,
      );
    }
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

async function assertTerminalControlRowsContained(fileName) {
  const snapshot = await evaluate(`(() => {
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
        height: rect.height,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth
      };
    };
    const command = document.querySelector(
      'input[aria-label="Terminal command"]',
    );

    return {
      terminalBody: rectFor('[data-testid="terminal-body"]'),
      commandRow: rectFor('[data-testid="terminal-command-row"]'),
      inputRow: rectFor('.terminal-input-row'),
      actions: rectFor('[data-testid="terminal-actions"]'),
      commandInput: rectFor('input[aria-label="Terminal command"]'),
      inputButton: rectFor('[data-testid="terminal-input-button"]'),
      commandLength: command?.value.length ?? 0
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  const missing = [
    'terminalBody',
    'commandRow',
    'inputRow',
    'actions',
    'commandInput',
    'inputButton',
  ].filter((key) => snapshot[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing terminal control rects: ${missing.join(', ')}`);
  }

  if (snapshot.commandLength < 80) {
    throw new Error(
      `Terminal long-command check did not receive a long command: ${snapshot.commandLength}`,
    );
  }

  for (const [name, rect] of [
    ['command row', snapshot.commandRow],
    ['stdin row', snapshot.inputRow],
    ['actions', snapshot.actions],
    ['command input', snapshot.commandInput],
    ['stdin send button', snapshot.inputButton],
  ]) {
    if (
      rect.left < snapshot.terminalBody.left - 1 ||
      rect.right > snapshot.terminalBody.right + 1
    ) {
      throw new Error(
        `Terminal ${name} is not contained after long command input: ${JSON.stringify(
          rect,
        )}`,
      );
    }
  }

  for (const [name, rect] of [
    ['command row', snapshot.commandRow],
    ['stdin row', snapshot.inputRow],
    ['actions', snapshot.actions],
  ]) {
    if (rect.scrollWidth > rect.clientWidth + 4) {
      throw new Error(
        `Terminal ${name} has horizontal layout overflow after long command input: ${JSON.stringify(
          rect,
        )}`,
      );
    }
  }
}

async function assertSettingsPageLayout(fileName) {
  await waitFor(
    'settings close button focused',
    async () =>
      evaluate(
        `document.activeElement?.getAttribute('aria-label') === 'Close Settings'`,
      ),
    5_000,
  );

  const metrics = await evaluate(`(() => {
    const rectForElement = (element) => {
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
    const rectFor = (selector) =>
      rectForElement(document.querySelector(selector));

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
      overlay: rectFor('[data-testid="settings-overlay"]'),
      backdrop: rectFor('.settings-overlay-backdrop'),
      settings: rectFor('[data-testid="settings-page"]'),
      settingsNav: rectFor('[data-testid="settings-section-nav"]'),
      settingsSections: rectFor('[data-testid="settings-sections"]'),
      closeButton: rectFor('[data-testid="settings-close-button"]'),
      accountSection: rectFor('[data-testid="settings-account-section"]'),
      modelConfig: rectFor('[data-testid="model-config"]'),
      permissionsConfig: rectFor('[data-testid="permissions-config"]'),
      toolsSection: rectFor('[data-testid="settings-tools-section"]'),
      runtimeDiagnostics: rectFor('[data-testid="runtime-diagnostics"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      activeLabel:
        document.activeElement?.getAttribute('aria-label') ?? '',
      backdropTabIndex:
        document.querySelector('.settings-overlay-backdrop')
          ?.getAttribute('tabindex') ?? null,
      backdropAriaHidden:
        document.querySelector('.settings-overlay-backdrop')
          ?.getAttribute('aria-hidden') ?? null,
      closeButtonLabel:
        document.querySelector('[data-testid="settings-close-button"]')
          ?.getAttribute('aria-label') ?? '',
      closeButtonTitle:
        document.querySelector('[data-testid="settings-close-button"]')
          ?.getAttribute('title') ?? '',
      closeButtonText:
        document.querySelector('[data-testid="settings-close-button"]')
          ?.textContent.trim() ?? '',
      closeButtonHasIcon:
        document.querySelector('[data-testid="settings-close-button"] svg') !==
        null,
      settingsRole:
        document.querySelector('[data-testid="settings-page"]')
          ?.getAttribute('role') ?? '',
      settingsModal:
        document.querySelector('[data-testid="settings-page"]')
          ?.getAttribute('aria-modal') ?? '',
      settingsText:
        document.querySelector('[data-testid="settings-page"]')?.innerText ?? '',
      navLinks: [
        ...document.querySelectorAll('[data-testid="settings-section-nav"] a'),
      ].map((link) => ({
        label: link.textContent.trim(),
        ariaLabel: link.getAttribute('aria-label') ?? '',
        href: link.getAttribute('href') ?? '',
      })),
      sectionRects: [
        ...document.querySelectorAll('[data-testid="settings-sections"] > .settings-section'),
      ].map((section) => ({
        id: section.id,
        testId: section.getAttribute('data-testid') ?? '',
        rect: rectForElement(section)
      })),
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
    'chat',
    'overlay',
    'backdrop',
    'settings',
    'settingsNav',
    'settingsSections',
    'closeButton',
    'accountSection',
    'modelConfig',
    'permissionsConfig',
    'toolsSection',
  ].filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(`Missing settings layout rects: ${missing.join(', ')}`);
  }

  if (metrics.review !== null) {
    throw new Error('Settings should close the review drawer behind it.');
  }

  if (metrics.terminal === null) {
    throw new Error('Settings should keep the terminal strip mounted.');
  }

  if (metrics.document.bodyScrollHeight > metrics.viewport.height + 4) {
    throw new Error(
      `Settings document should fit one viewport; body scrollHeight=${metrics.document.bodyScrollHeight}, viewport=${metrics.viewport.height}`,
    );
  }

  if (
    Math.abs(metrics.overlay.left - metrics.grid.left) > 1 ||
    Math.abs(metrics.overlay.right - metrics.grid.right) > 1 ||
    Math.abs(metrics.overlay.bottom - metrics.terminal.bottom) > 1
  ) {
    throw new Error(
      `Settings overlay is not aligned with the workbench: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (metrics.settings.right < metrics.grid.right - 1) {
    throw new Error('Settings sheet is not right aligned.');
  }

  if (
    metrics.settings.width >= metrics.grid.width - 32 ||
    metrics.settings.width > 640 ||
    metrics.settings.width < 500
  ) {
    throw new Error(
      `Settings sheet width is not drawer-like: ${metrics.settings.width}`,
    );
  }

  if (
    metrics.chat.width < metrics.settings.width ||
    metrics.backdrop.width < 80
  ) {
    throw new Error(
      `Settings overlay no longer preserves visible task context: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (metrics.settingsRole !== 'dialog' || metrics.settingsModal !== 'true') {
    throw new Error(
      `Settings sheet should be a modal dialog: role=${metrics.settingsRole}, modal=${metrics.settingsModal}`,
    );
  }

  if (
    metrics.activeLabel !== 'Close Settings' ||
    metrics.closeButtonLabel !== 'Close Settings' ||
    metrics.closeButtonTitle !== 'Close Settings' ||
    metrics.closeButtonText !== '' ||
    !metrics.closeButtonHasIcon ||
    metrics.closeButton.width > 32 ||
    metrics.closeButton.height > 32
  ) {
    throw new Error(
      `Settings close control is not compact and focused: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (
    metrics.backdropTabIndex !== '-1' ||
    metrics.backdropAriaHidden !== 'true'
  ) {
    throw new Error(
      `Settings backdrop should not become a keyboard stop: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (metrics.modelConfig.width < 250) {
    throw new Error(
      `Settings form is too narrow: ${metrics.modelConfig.width}`,
    );
  }

  const expectedSettingsLinks = [
    ['Account', '#settings-account'],
    ['Model Providers', '#settings-model-providers'],
    ['Permissions', '#settings-permissions'],
    ['Tools & MCP', '#settings-tools'],
    ['Terminal', '#settings-terminal'],
    ['Appearance', '#settings-appearance'],
    ['Advanced', '#settings-advanced'],
  ];
  if (
    metrics.navLinks.length !== expectedSettingsLinks.length ||
    metrics.navLinks.some(
      (link, index) =>
        link.label !== expectedSettingsLinks[index][0] ||
        link.ariaLabel !== `Show ${expectedSettingsLinks[index][0]} settings` ||
        link.href !== expectedSettingsLinks[index][1],
    )
  ) {
    throw new Error(
      `Settings rail links are not complete and accessible: ${JSON.stringify(
        metrics.navLinks,
      )}`,
    );
  }

  if (
    metrics.settingsNav.width > 130 ||
    metrics.settingsNav.right > metrics.modelConfig.left - 6 ||
    metrics.settingsSections.left < metrics.settingsNav.right + 6
  ) {
    throw new Error(
      `Settings section rail is not compact or separated from content: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  const expectedSectionIds = [
    'settings-account',
    'settings-model-providers',
    'settings-permissions',
    'settings-tools',
    'settings-terminal',
    'settings-appearance',
    'settings-advanced',
  ];
  if (
    metrics.sectionRects.length !== expectedSectionIds.length ||
    metrics.sectionRects.some(
      (section, index) => section.id !== expectedSectionIds[index],
    )
  ) {
    throw new Error(
      `Settings sections are not in the expected product order: ${JSON.stringify(
        metrics.sectionRects,
      )}`,
    );
  }

  const contentLeft = metrics.modelConfig.left;
  const contentWidth = metrics.modelConfig.width;
  for (const section of metrics.sectionRects) {
    if (
      Math.abs(section.rect.left - contentLeft) > 1 ||
      Math.abs(section.rect.width - contentWidth) > 1
    ) {
      throw new Error(
        `Settings sections should render as one content column: ${JSON.stringify(
          metrics.sectionRects,
        )}`,
      );
    }
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

async function assertSettingsLabelChromeRestraint(fileName) {
  const snapshot = await evaluate(`(() => {
    const settings = document.querySelector('[data-testid="settings-page"]');
    const readLabel = (element) => {
      const style = window.getComputedStyle(element);
      return {
        text: element.textContent.trim(),
        textTransform: style.textTransform,
        fontWeight: Number.parseFloat(style.fontWeight),
        fontSize: Number.parseFloat(style.fontSize),
        overflows: element.scrollWidth > element.clientWidth + 4
      };
    };
    const formLabels = settings
      ? [...settings.querySelectorAll('.settings-form label > span')].map(
          readLabel,
        )
      : [];
    const keyLabels = settings
      ? [...settings.querySelectorAll('.settings-kv dt')].map(readLabel)
      : [];
    const settingsText = settings?.innerText ?? '';
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      formLabels,
      keyLabels,
      formLabelTexts: formLabels.map((label) => label.text),
      keyLabelTexts: keyLabels.map((label) => label.text),
      hasSecret:
        settingsText.includes('sk-desktop-e2e') ||
        settingsText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(settingsText),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  const missingFormLabels = [
    'Provider',
    'Model',
    'Base URL',
    'API key',
    'Permission mode',
    'Thread model',
  ].filter((label) => !snapshot.formLabelTexts.includes(label));
  if (missingFormLabels.length > 0) {
    throw new Error(
      `Settings form labels are missing: ${missingFormLabels.join(', ')}`,
    );
  }

  const missingKeyLabels = [
    'Auth',
    'API key',
    'Coding Plan key',
    'Commands',
    'Skills',
    'Shell',
    'Output',
    'Theme',
    'Density',
  ].filter((label) => !snapshot.keyLabelTexts.includes(label));
  if (missingKeyLabels.length > 0) {
    throw new Error(
      `Settings key labels are missing: ${missingKeyLabels.join(', ')}`,
    );
  }

  const noisyLabels = [...snapshot.formLabels, ...snapshot.keyLabels].filter(
    (label) =>
      label.textTransform !== 'none' ||
      label.fontWeight > 700 ||
      label.fontSize > 12 ||
      label.overflows,
  );
  if (noisyLabels.length > 0) {
    throw new Error(
      `Settings labels still read as heavy debug chrome: ${JSON.stringify(
        noisyLabels,
      )}`,
    );
  }

  if (
    snapshot.hasSecret ||
    snapshot.hasServerUrl ||
    snapshot.documentOverflow
  ) {
    throw new Error(
      `Settings label snapshot leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function assertSettingsSectionRailNavigation(fileName) {
  const clicked = await evaluate(`(() => {
    const link = document.querySelector(
      '[data-testid="settings-section-nav"] a[href="#settings-permissions"]'
    );
    if (!link) {
      return false;
    }
    link.click();
    return true;
  })()`);

  if (!clicked) {
    throw new Error('Settings Permissions rail link was not found.');
  }

  await waitFor(
    'settings permissions rail navigation',
    async () =>
      evaluate(`(() => {
        const content = document.querySelector('.settings-page-content');
        const permissions = document.querySelector(
          '[data-testid="permissions-config"]'
        );
        if (!content || !permissions) {
          return false;
        }
        const contentRect = content.getBoundingClientRect();
        const permissionsRect = permissions.getBoundingClientRect();
        return (
          content.scrollTop > 0 &&
          permissionsRect.top >= contentRect.top - 1 &&
          permissionsRect.top <= contentRect.bottom - 1
        );
      })()`),
    5_000,
  );

  const metrics = await evaluate(`(() => {
    const rectForElement = (element) => {
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
    const content = document.querySelector('.settings-page-content');
    const permissions = document.querySelector(
      '[data-testid="permissions-config"]'
    );
    const runtimeDiagnostics = document.querySelector(
      '[data-testid="runtime-diagnostics"]'
    );
    const metrics = {
      locationHash: window.location.hash,
      documentScrollTop: document.scrollingElement?.scrollTop ?? 0,
      contentScrollTop: content?.scrollTop ?? null,
      content: rectForElement(content),
      permissions: rectForElement(permissions),
      runtimeDiagnosticsPresent: runtimeDiagnostics !== null,
      settingsText:
        document.querySelector('[data-testid="settings-page"]')?.innerText ?? ''
    };
    if (content) {
      content.scrollTop = 0;
    }
    document.querySelector('[data-testid="settings-close-button"]')?.focus();
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    return metrics;
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  if (
    metrics.contentScrollTop === null ||
    metrics.contentScrollTop <= 0 ||
    metrics.documentScrollTop !== 0
  ) {
    throw new Error(
      `Settings rail should scroll only the drawer content: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (
    !metrics.content ||
    !metrics.permissions ||
    metrics.permissions.top < metrics.content.top - 1 ||
    metrics.permissions.top > metrics.content.bottom - 1
  ) {
    throw new Error(
      `Settings rail did not bring Permissions into view: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (metrics.runtimeDiagnosticsPresent) {
    throw new Error('Settings rail navigation opened runtime diagnostics.');
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
        `Settings rail navigation exposed diagnostic ${hiddenDiagnostic}: ${metrics.settingsText}`,
      );
    }
  }
}

async function assertCompactSettingsOverlayLayout(fileName) {
  await waitFor(
    'compact settings close button focused',
    async () =>
      evaluate(
        `document.activeElement?.getAttribute('aria-label') === 'Close Settings'`,
      ),
    5_000,
  );

  const metrics = await evaluate(`(async () => {
    const rectForElement = (element) => {
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
    const rectFor = (selector) =>
      rectForElement(document.querySelector(selector));
    const settingsContent = document.querySelector('.settings-page-content');
    const permissions = document.querySelector(
      '[data-testid="permissions-config"]'
    );
    const initial = {
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
      overlay: rectFor('[data-testid="settings-overlay"]'),
      backdrop: rectFor('.settings-overlay-backdrop'),
      settings: rectFor('[data-testid="settings-page"]'),
      settingsNav: rectFor('[data-testid="settings-section-nav"]'),
      settingsSections: rectFor('[data-testid="settings-sections"]'),
      settingsContent: rectForElement(settingsContent),
      closeButton: rectFor('[data-testid="settings-close-button"]'),
      modelConfig: rectFor('[data-testid="model-config"]'),
      permissionsConfig: rectForElement(permissions),
      toolsSection: rectFor('[data-testid="settings-tools-section"]'),
      runtimeDiagnostics: rectFor('[data-testid="runtime-diagnostics"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      contentClientHeight: settingsContent?.clientHeight ?? null,
      contentScrollHeight: settingsContent?.scrollHeight ?? null,
      contentScrollTop: settingsContent?.scrollTop ?? null,
      activeLabel:
        document.activeElement?.getAttribute('aria-label') ?? '',
      backdropTabIndex:
        document.querySelector('.settings-overlay-backdrop')
          ?.getAttribute('tabindex') ?? null,
      backdropAriaHidden:
        document.querySelector('.settings-overlay-backdrop')
          ?.getAttribute('aria-hidden') ?? null,
      closeButtonText:
        document.querySelector('[data-testid="settings-close-button"]')
          ?.textContent.trim() ?? '',
      closeButtonHasIcon:
        document.querySelector('[data-testid="settings-close-button"] svg') !==
        null,
      navLinks: [
        ...document.querySelectorAll('[data-testid="settings-section-nav"] a'),
      ].map((link) => ({
        label: link.textContent.trim(),
        ariaLabel: link.getAttribute('aria-label') ?? '',
        href: link.getAttribute('href') ?? '',
      })),
      sectionRects: [
        ...document.querySelectorAll('[data-testid="settings-sections"] > .settings-section'),
      ].map((section) => ({
        id: section.id,
        rect: rectForElement(section)
      })),
      settingsText:
        document.querySelector('[data-testid="settings-page"]')?.innerText ?? ''
    };

    if (settingsContent && permissions) {
      const contentRect = settingsContent.getBoundingClientRect();
      const permissionRect = permissions.getBoundingClientRect();
      const targetScrollTop =
        settingsContent.scrollTop +
        permissionRect.top -
        contentRect.top -
        (contentRect.height - permissionRect.height) / 2;
      const previousScrollBehavior = settingsContent.style.scrollBehavior;
      settingsContent.style.scrollBehavior = 'auto';
      settingsContent.scrollTop = Math.max(
        0,
        Math.min(
          targetScrollTop,
          settingsContent.scrollHeight - settingsContent.clientHeight
        )
      );
      settingsContent.style.scrollBehavior = previousScrollBehavior;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const afterPermissionsScroll = {
      contentScrollTop: settingsContent?.scrollTop ?? null,
      permissionsConfig: rectForElement(permissions),
      settingsContent: rectForElement(settingsContent)
    };
    if (settingsContent) {
      settingsContent.scrollTop = 0;
    }

    return { ...initial, afterPermissionsScroll };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(metrics, null, 2)}\n`,
    'utf8',
  );

  const missing = [
    'grid',
    'chat',
    'overlay',
    'backdrop',
    'settings',
    'settingsNav',
    'settingsSections',
    'settingsContent',
    'closeButton',
    'modelConfig',
    'permissionsConfig',
    'toolsSection',
    'terminal',
  ].filter((key) => metrics[key] === null);
  if (missing.length > 0) {
    throw new Error(
      `Missing compact settings layout rects: ${missing.join(', ')}`,
    );
  }

  if (metrics.viewport.width > 1000 || metrics.viewport.height > 700) {
    throw new Error(
      `Compact settings viewport did not apply: ${JSON.stringify(
        metrics.viewport,
      )}`,
    );
  }

  if (
    metrics.document.bodyScrollWidth > metrics.viewport.width + 4 ||
    metrics.document.bodyScrollHeight > metrics.viewport.height + 4
  ) {
    throw new Error(
      `Compact settings caused document overflow: ${JSON.stringify(metrics)}`,
    );
  }

  if (
    Math.abs(metrics.overlay.left - metrics.grid.left) > 1 ||
    Math.abs(metrics.overlay.right - metrics.grid.right) > 1 ||
    Math.abs(metrics.overlay.bottom - metrics.terminal.bottom) > 1
  ) {
    throw new Error(
      `Compact settings overlay is not aligned with the workbench: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (
    metrics.settings.right < metrics.grid.right - 1 ||
    metrics.settings.width < 500 ||
    metrics.settings.width > metrics.grid.width - 72 ||
    metrics.backdrop.width < 72
  ) {
    throw new Error(
      `Compact settings sheet no longer preserves task context: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (
    metrics.settings.height > metrics.overlay.height + 1 ||
    metrics.settingsContent.right > metrics.settings.right + 1 ||
    metrics.modelConfig.width < 250
  ) {
    throw new Error(
      `Compact settings content is not contained: ${JSON.stringify(metrics)}`,
    );
  }

  if (
    metrics.settings.width > 620 ||
    metrics.settingsNav.width > 120 ||
    metrics.settingsNav.right > metrics.modelConfig.left - 6 ||
    metrics.settingsSections.left < metrics.settingsNav.right + 6
  ) {
    throw new Error(
      `Compact settings rail should stay narrow and preserve content: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  const expectedSettingsLinks = [
    ['Account', '#settings-account'],
    ['Model Providers', '#settings-model-providers'],
    ['Permissions', '#settings-permissions'],
    ['Tools & MCP', '#settings-tools'],
    ['Terminal', '#settings-terminal'],
    ['Appearance', '#settings-appearance'],
    ['Advanced', '#settings-advanced'],
  ];
  if (
    metrics.navLinks.length !== expectedSettingsLinks.length ||
    metrics.navLinks.some(
      (link, index) =>
        link.label !== expectedSettingsLinks[index][0] ||
        link.ariaLabel !== `Show ${expectedSettingsLinks[index][0]} settings` ||
        link.href !== expectedSettingsLinks[index][1],
    )
  ) {
    throw new Error(
      `Compact settings rail links are not complete: ${JSON.stringify(
        metrics.navLinks,
      )}`,
    );
  }

  for (const section of metrics.sectionRects) {
    if (
      Math.abs(section.rect.left - metrics.modelConfig.left) > 1 ||
      Math.abs(section.rect.width - metrics.modelConfig.width) > 1
    ) {
      throw new Error(
        `Compact settings sections are not one content column: ${JSON.stringify(
          metrics.sectionRects,
        )}`,
      );
    }
  }

  if (
    metrics.activeLabel !== 'Close Settings' ||
    metrics.closeButtonText !== '' ||
    !metrics.closeButtonHasIcon ||
    metrics.closeButton.width > 32 ||
    metrics.closeButton.height > 32 ||
    metrics.backdropTabIndex !== '-1' ||
    metrics.backdropAriaHidden !== 'true'
  ) {
    throw new Error(
      `Compact settings controls are not icon-led and keyboard-safe: ${JSON.stringify(
        metrics,
      )}`,
    );
  }

  if (
    metrics.afterPermissionsScroll.contentScrollTop === null ||
    metrics.afterPermissionsScroll.contentScrollTop <= 0 ||
    metrics.afterPermissionsScroll.permissionsConfig.bottom >
      metrics.afterPermissionsScroll.settingsContent.bottom + 1 ||
    metrics.afterPermissionsScroll.permissionsConfig.top <
      metrics.afterPermissionsScroll.settingsContent.top - 1
  ) {
    throw new Error(
      `Compact settings permissions are not reachable by sheet scroll: ${JSON.stringify(
        metrics,
      )}`,
    );
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
        `Compact settings default view exposed diagnostic ${hiddenDiagnostic}: ${metrics.settingsText}`,
      );
    }
  }

  if (/http:\/\/127\.0\.0\.1:/u.test(metrics.settingsText)) {
    throw new Error(
      `Compact settings default view exposed the local server URL: ${metrics.settingsText}`,
    );
  }

  if (metrics.runtimeDiagnostics !== null) {
    throw new Error(
      'Compact settings opened runtime diagnostics before Advanced Diagnostics.',
    );
  }
}

async function assertSettingsValidation(fileName) {
  const snapshots = {};

  await setFieldByAriaLabel('Provider model', '');
  await waitForText('Enter a model name before saving.');
  snapshots.missingModel = await readSettingsValidationSnapshot();

  await setFieldByAriaLabel('Provider model', 'qwen-e2e-cdp');
  await setFieldByAriaLabel('Provider base URL', 'not-a-url');
  await waitForText('Use a valid HTTP(S) base URL.');
  snapshots.invalidBaseUrl = await readSettingsValidationSnapshot();

  await setFieldByAriaLabel('Provider base URL', 'https://example.invalid/v1');
  await setFieldByAriaLabel('Provider API key', '');
  await waitForText('Enter an API key to save this provider.');
  snapshots.missingApiKey = await readSettingsValidationSnapshot();

  await setFieldByAriaLabel('Provider API key', 'sk-desktop-e2e');
  await waitFor(
    'valid settings save enabled',
    async () => {
      const snapshot = await readSettingsValidationSnapshot();
      return (
        snapshot.saveDisabled === false &&
        snapshot.validationText === '' &&
        snapshot.apiKeyLength > 0
      );
    },
    5_000,
  );
  snapshots.valid = await readSettingsValidationSnapshot();

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshots, null, 2)}\n`,
    'utf8',
  );

  if (
    snapshots.missingModel.validationText !==
    'Enter a model name before saving.'
  ) {
    throw new Error(
      `Missing-model validation did not render: ${JSON.stringify(
        snapshots.missingModel,
      )}`,
    );
  }

  if (
    snapshots.invalidBaseUrl.validationText !== 'Use a valid HTTP(S) base URL.'
  ) {
    throw new Error(
      `Invalid-base-URL validation did not render: ${JSON.stringify(
        snapshots.invalidBaseUrl,
      )}`,
    );
  }

  if (
    snapshots.missingApiKey.validationText !==
    'Enter an API key to save this provider.'
  ) {
    throw new Error(
      `Missing-API-key validation did not render: ${JSON.stringify(
        snapshots.missingApiKey,
      )}`,
    );
  }

  for (const [name, snapshot] of Object.entries(snapshots)) {
    const shouldBeDisabled = name !== 'valid';
    if (snapshot.saveDisabled !== shouldBeDisabled) {
      throw new Error(
        `Unexpected Save disabled state for ${name}: ${JSON.stringify(
          snapshot,
        )}`,
      );
    }

    if (snapshot.hasSecretText) {
      throw new Error(
        `Settings validation exposed the fake API key in visible text for ${name}.`,
      );
    }

    if (snapshot.validationOverflow || snapshot.documentOverflow) {
      throw new Error(
        `Settings validation overflowed for ${name}: ${JSON.stringify(
          snapshot,
        )}`,
      );
    }
  }
}

async function readSettingsValidationSnapshot() {
  return evaluate(`(() => {
    const settings = document.querySelector('[data-testid="settings-page"]');
    const modelConfig = document.querySelector('[data-testid="model-config"]');
    const validation = document.querySelector(
      '[data-testid="settings-save-validation"]'
    );
    const saveButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Save'
    );
    const apiKey = [...document.querySelectorAll('label')]
      .find((candidate) =>
        candidate.innerText.trim().toLowerCase().startsWith('api key')
      )
      ?.querySelector('input');
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
    const settingsRect = rectFor(settings);
    const modelConfigRect = rectFor(modelConfig);
    const validationRect = rectFor(validation);
    return {
      validationText: validation?.textContent.trim() ?? '',
      saveDisabled: saveButton?.disabled ?? null,
      saveDescribedBy: saveButton?.getAttribute('aria-describedby') ?? null,
      apiKeyType: apiKey?.getAttribute('type') ?? null,
      apiKeyLength: apiKey?.value.length ?? 0,
      hasSecretText: (settings?.innerText ?? '').includes('sk-desktop-e2e'),
      validationOverflow:
        validationRect !== null &&
        modelConfigRect !== null &&
        (validationRect.left < modelConfigRect.left - 1 ||
          validationRect.right > modelConfigRect.right + 1),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4,
      settingsWidth: settingsRect?.width ?? null,
      modelConfigWidth: modelConfigRect?.width ?? null,
      validationWidth: validationRect?.width ?? null
    };
  })()`);
}

async function assertSettingsProviderKeyGuidanceMissingAndReady(fileName) {
  const snapshots = {};

  await waitFor(
    'initial provider key guidance',
    async () => {
      const snapshot = await readSettingsProviderKeyGuidanceSnapshot();
      return (
        snapshot.providerValue === 'api-key' &&
        snapshot.text === 'API key missing' &&
        snapshot.ariaLabel === 'API key provider · API key missing'
      );
    },
    5_000,
  );
  snapshots.initial = await readSettingsProviderKeyGuidanceSnapshot();

  await setFieldByAriaLabel('Provider API key', 'sk-desktop-e2e');
  await waitFor(
    'provider key guidance ready to save',
    async () => {
      const snapshot = await readSettingsProviderKeyGuidanceSnapshot();
      return (
        snapshot.providerValue === 'api-key' &&
        snapshot.text === 'API key ready to save' &&
        snapshot.ariaLabel === 'API key provider · API key ready to save' &&
        snapshot.apiKeyLength > 0
      );
    },
    5_000,
  );
  snapshots.ready = await readSettingsProviderKeyGuidanceSnapshot();

  await setFieldByAriaLabel('Provider API key', '');
  await waitFor(
    'provider key guidance restored to missing',
    async () => {
      const snapshot = await readSettingsProviderKeyGuidanceSnapshot();
      return (
        snapshot.providerValue === 'api-key' &&
        snapshot.text === 'API key missing' &&
        snapshot.ariaLabel === 'API key provider · API key missing' &&
        snapshot.apiKeyLength === 0
      );
    },
    5_000,
  );
  snapshots.restored = await readSettingsProviderKeyGuidanceSnapshot();

  await writeSettingsProviderKeyGuidanceSnapshots(fileName, snapshots);

  assertSettingsProviderKeyGuidanceSnapshot(snapshots.initial, {
    className: 'settings-provider-key-guidance-missing',
    providerValue: 'api-key',
    text: 'API key missing',
    title: 'API key provider · API key missing',
  });
  assertSettingsProviderKeyGuidanceSnapshot(snapshots.ready, {
    className: 'settings-provider-key-guidance-configured',
    providerValue: 'api-key',
    text: 'API key ready to save',
    title: 'API key provider · API key ready to save',
  });
  assertSettingsProviderKeyGuidanceSnapshot(snapshots.restored, {
    className: 'settings-provider-key-guidance-missing',
    providerValue: 'api-key',
    text: 'API key missing',
    title: 'API key provider · API key missing',
  });
}

async function assertSettingsProviderKeyGuidanceConfigured(fileName, provider) {
  const snapshot = await readSettingsProviderKeyGuidanceSnapshot();
  const expected =
    provider === 'coding-plan'
      ? {
          className: 'settings-provider-key-guidance-configured',
          providerValue: 'coding-plan',
          text: 'Coding Plan API key configured',
          title: 'Coding Plan provider · Coding Plan API key configured',
        }
      : {
          className: 'settings-provider-key-guidance-configured',
          providerValue: 'api-key',
          text: 'API key configured',
          title: 'API key provider · API key configured',
        };

  await appendSettingsProviderKeyGuidanceSnapshot(
    fileName,
    provider === 'coding-plan' ? 'codingPlanConfigured' : 'apiKeyConfigured',
    snapshot,
  );

  assertSettingsProviderKeyGuidanceSnapshot(snapshot, expected);
}

function assertSettingsProviderKeyGuidanceSnapshot(snapshot, expected) {
  if (
    snapshot.providerValue !== expected.providerValue ||
    snapshot.text !== expected.text ||
    snapshot.ariaLabel !== expected.title ||
    snapshot.title !== expected.title ||
    snapshot.role !== 'status' ||
    !snapshot.className.includes(expected.className)
  ) {
    throw new Error(
      `Provider key guidance metadata is incorrect: ${JSON.stringify({
        expected,
        snapshot,
      })}`,
    );
  }

  if (
    !snapshot.dotStyle ||
    snapshot.dotStyle.width > 7 ||
    snapshot.dotStyle.height > 7 ||
    !snapshot.contained ||
    snapshot.guidanceOverflow ||
    snapshot.visibleSecret ||
    snapshot.hasServerUrl ||
    snapshot.documentOverflow
  ) {
    throw new Error(
      `Provider key guidance leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function appendSettingsProviderKeyGuidanceSnapshot(
  fileName,
  stage,
  snapshot,
) {
  let snapshots = {};
  try {
    snapshots = JSON.parse(await readFile(join(artifactDir, fileName), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  snapshots[stage] = snapshot;
  await writeSettingsProviderKeyGuidanceSnapshots(fileName, snapshots);
}

async function writeSettingsProviderKeyGuidanceSnapshots(fileName, snapshots) {
  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshots, null, 2)}\n`,
    'utf8',
  );
}

async function readSettingsProviderKeyGuidanceSnapshot() {
  return evaluate(`(() => {
    const settings = document.querySelector('[data-testid="settings-page"]');
    const modelConfig = document.querySelector('[data-testid="model-config"]');
    const provider = document.querySelector(
      'select[aria-label="Model provider"]'
    );
    const apiKey = document.querySelector(
      'input[aria-label="Provider API key"]'
    );
    const guidance = document.querySelector(
      '[data-testid="settings-provider-key-guidance"]'
    );
    const dot = guidance?.querySelector(
      '.settings-provider-key-guidance-dot'
    );
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        display: style.display,
        backgroundColor: style.backgroundColor,
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        boxShadow: style.boxShadow
      };
    };
    const guidanceRect = rectFor(guidance);
    const modelConfigRect = rectFor(modelConfig);
    const settingsText = settings?.innerText ?? '';
    return {
      providerValue: provider?.value ?? null,
      text: guidance?.textContent.trim() ?? '',
      ariaLabel: guidance?.getAttribute('aria-label') ?? null,
      title: guidance?.getAttribute('title') ?? null,
      role: guidance?.getAttribute('role') ?? null,
      className: guidance?.className ?? '',
      apiKeyLength: apiKey?.value.length ?? 0,
      guidanceRect,
      modelConfigRect,
      dotStyle: styleFor(dot),
      contained:
        Boolean(guidanceRect && modelConfigRect) &&
        guidanceRect.left >= modelConfigRect.left - 1 &&
        guidanceRect.right <= modelConfigRect.right + 1 &&
        guidanceRect.top >= modelConfigRect.top - 1 &&
        guidanceRect.bottom <= modelConfigRect.bottom + 1,
      guidanceOverflow:
        Boolean(guidance) && guidance.scrollWidth > guidance.clientWidth + 4,
      visibleSecret:
        settingsText.includes('sk-desktop-e2e') ||
        settingsText.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(settingsText),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);
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
        (settings?.innerText ?? '').includes('cp-desktop-e2e') ||
        (apiKey?.value ?? '').includes('sk-desktop-e2e') ||
        (apiKey?.value ?? '').includes('cp-desktop-e2e'),
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
    throw new Error(
      'Advanced diagnostics opened before the user requested it.',
    );
  }
}

async function assertSettingsSaveStatusFeedback(fileName) {
  await waitFor(
    'API-key provider saved status',
    async () => {
      const snapshot = await readSettingsSaveStatusSnapshot();
      return (
        snapshot.statusText ===
          'Saved API key provider · qwen-e2e-cdp · API key configured' &&
        snapshot.statusRole === 'status' &&
        snapshot.apiKeyValue === ''
      );
    },
    5_000,
  );

  const saved = await readSettingsSaveStatusSnapshot();

  await setFieldByAriaLabel('Provider model', 'qwen-e2e-cdp-draft');
  await waitFor(
    'saved status clears after model edit',
    async () => {
      const snapshot = await readSettingsSaveStatusSnapshot();
      return (
        snapshot.modelValue === 'qwen-e2e-cdp-draft' &&
        snapshot.statusText === '' &&
        snapshot.saveDescribedBy === null
      );
    },
    5_000,
  );
  const edited = await readSettingsSaveStatusSnapshot();

  await setFieldByAriaLabel('Provider model', 'qwen-e2e-cdp');
  await waitFor(
    'provider model restored after save-status check',
    async () => {
      const snapshot = await readSettingsSaveStatusSnapshot();
      return (
        snapshot.modelValue === 'qwen-e2e-cdp' &&
        snapshot.statusText === '' &&
        snapshot.saveDisabled === false
      );
    },
    5_000,
  );
  const restored = await readSettingsSaveStatusSnapshot();
  const snapshots = { saved, edited, restored };

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshots, null, 2)}\n`,
    'utf8',
  );

  if (
    saved.statusText !==
      'Saved API key provider · qwen-e2e-cdp · API key configured' ||
    saved.statusRole !== 'status' ||
    !saved.statusClass.includes('settings-save-status-saved') ||
    saved.saveDescribedBy !== 'settings-save-status'
  ) {
    throw new Error(
      `API-key save status was not explicit and accessible: ${JSON.stringify(
        saved,
      )}`,
    );
  }

  if (
    saved.apiKeyType !== 'password' ||
    saved.apiKeyValue !== '' ||
    saved.hasAnySecret ||
    saved.hasServerUrl ||
    saved.statusOverflow ||
    saved.documentOverflow
  ) {
    throw new Error(
      `API-key save status exposed secrets, diagnostics, or overflow: ${JSON.stringify(
        saved,
      )}`,
    );
  }

  if (
    edited.statusText !== '' ||
    edited.statusRole !== null ||
    edited.saveDescribedBy !== null ||
    edited.hasAnySecret ||
    edited.documentOverflow
  ) {
    throw new Error(
      `Editing provider fields should clear stale save status safely: ${JSON.stringify(
        edited,
      )}`,
    );
  }

  if (
    restored.modelValue !== 'qwen-e2e-cdp' ||
    restored.statusText !== '' ||
    restored.saveDisabled !== false ||
    restored.hasAnySecret ||
    restored.documentOverflow
  ) {
    throw new Error(
      `Provider form was not restored after save-status check: ${JSON.stringify(
        restored,
      )}`,
    );
  }
}

async function readSettingsSaveStatusSnapshot() {
  return evaluate(`(() => {
    const settings = document.querySelector('[data-testid="settings-page"]');
    const modelConfig = document.querySelector('[data-testid="model-config"]');
    const status = document.querySelector(
      '[data-testid="settings-save-status"]'
    );
    const saveButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Save'
    );
    const model = document.querySelector(
      'input[aria-label="Provider model"]'
    );
    const apiKey = document.querySelector(
      'input[aria-label="Provider API key"]'
    );
    const settingsText = settings?.innerText ?? '';
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
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
    const statusRect = rectFor(status);
    const modelConfigRect = rectFor(modelConfig);
    return {
      statusText: status?.textContent.trim() ?? '',
      statusRole: status?.getAttribute('role') ?? null,
      statusClass: status?.className ?? '',
      statusRect,
      saveDisabled: saveButton?.disabled ?? null,
      saveDescribedBy: saveButton?.getAttribute('aria-describedby') ?? null,
      modelValue: model?.value ?? null,
      apiKeyType: apiKey?.getAttribute('type') ?? null,
      apiKeyValue: apiKey?.value ?? '',
      hasAnySecret:
        settingsText.includes('sk-desktop-e2e') ||
        settingsText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(settingsText),
      statusOverflow:
        Boolean(status && status.scrollWidth > status.clientWidth + 4) ||
        Boolean(
          statusRect &&
            modelConfigRect &&
            (statusRect.left < modelConfigRect.left - 1 ||
              statusRect.right > modelConfigRect.right + 1)
        ),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);
}

async function assertSettingsCodingPlanWorkflow(fileName) {
  const snapshots = {};

  snapshots.focus = await focusFieldByAriaLabel('Model provider');
  await setFieldByAriaLabel('Model provider', 'coding-plan');
  await waitForText('Enter a Coding Plan API key to save this provider.');
  snapshots.validation = await readSettingsCodingPlanSnapshot();

  await setFieldByAriaLabel('Coding Plan region', 'global');
  await setFieldByAriaLabel('Provider API key', 'cp-desktop-e2e');
  await waitFor(
    'Coding Plan save enabled',
    async () => {
      const snapshot = await readSettingsCodingPlanSnapshot();
      return (
        snapshot.providerValue === 'coding-plan' &&
        snapshot.regionValue === 'global' &&
        snapshot.apiKeyLength > 0 &&
        snapshot.saveDisabled === false &&
        snapshot.validationText === ''
      );
    },
    5_000,
  );
  snapshots.ready = await readSettingsCodingPlanSnapshot();

  await clickButton('Save');
  await waitFor(
    'Coding Plan provider saved',
    async () => {
      const snapshot = await readSettingsCodingPlanSnapshot();
      return (
        snapshot.providerValue === 'coding-plan' &&
        snapshot.regionValue === 'global' &&
        snapshot.apiKeyLength === 0 &&
        snapshot.codingPlanConfigured &&
        snapshot.settingsProviderText.includes('Coding Plan')
      );
    },
    15_000,
  );
  snapshots.saved = await readSettingsCodingPlanSnapshot();

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshots, null, 2)}\n`,
    'utf8',
  );

  if (snapshots.focus.activeLabel !== 'Model provider') {
    throw new Error(
      `Model provider field did not receive focus: ${JSON.stringify(
        snapshots.focus,
      )}`,
    );
  }

  if (
    snapshots.validation.validationText !==
    'Enter a Coding Plan API key to save this provider.'
  ) {
    throw new Error(
      `Coding Plan validation did not render: ${JSON.stringify(
        snapshots.validation,
      )}`,
    );
  }

  if (
    snapshots.validation.hasModelField ||
    snapshots.validation.hasBaseUrlField ||
    !snapshots.validation.hasRegionField
  ) {
    throw new Error(
      `Coding Plan provider fields are incorrect: ${JSON.stringify(
        snapshots.validation,
      )}`,
    );
  }

  if (snapshots.validation.saveDisabled !== true) {
    throw new Error('Coding Plan save should be disabled without an API key.');
  }

  if (
    snapshots.ready.saveDisabled !== false ||
    snapshots.ready.regionValue !== 'global'
  ) {
    throw new Error(
      `Coding Plan save did not become ready: ${JSON.stringify(
        snapshots.ready,
      )}`,
    );
  }

  if (
    snapshots.saved.apiKeyLength !== 0 ||
    !snapshots.saved.codingPlanConfigured ||
    snapshots.saved.hasAnySecret
  ) {
    throw new Error(
      `Saved Coding Plan state is unsafe: ${JSON.stringify(snapshots.saved)}`,
    );
  }

  if (
    snapshots.saved.saveStatusText !==
      'Saved Coding Plan provider · Global · API key configured' ||
    snapshots.saved.saveStatusRole !== 'status' ||
    !snapshots.saved.saveStatusClass.includes('settings-save-status-saved') ||
    snapshots.saved.saveDescribedBy !== 'settings-save-status'
  ) {
    throw new Error(
      `Saved Coding Plan status is not explicit and accessible: ${JSON.stringify(
        snapshots.saved,
      )}`,
    );
  }

  if (
    snapshots.validation.saveStatusText !== '' ||
    snapshots.ready.saveStatusText !== ''
  ) {
    throw new Error(
      `Coding Plan edits should clear stale save status before saving: ${JSON.stringify(
        snapshots,
      )}`,
    );
  }

  for (const [name, snapshot] of Object.entries(snapshots)) {
    if (snapshot.visibleSecret || snapshot.documentOverflow) {
      throw new Error(
        `Coding Plan workflow leaked visible data or overflowed for ${name}: ${JSON.stringify(
          snapshot,
        )}`,
      );
    }
  }
}

async function readSettingsCodingPlanSnapshot() {
  return evaluate(`(() => {
    const settings = document.querySelector('[data-testid="settings-page"]');
    const provider = document.querySelector(
      'select[aria-label="Model provider"]'
    );
    const region = document.querySelector(
      'select[aria-label="Coding Plan region"]'
    );
    const model = document.querySelector(
      'input[aria-label="Provider model"]'
    );
    const baseUrl = document.querySelector(
      'input[aria-label="Provider base URL"]'
    );
    const apiKey = document.querySelector(
      'input[aria-label="Provider API key"]'
    );
    const validation = document.querySelector(
      '[data-testid="settings-save-validation"]'
    );
    const saveStatus = document.querySelector(
      '[data-testid="settings-save-status"]'
    );
    const saveButton = [...document.querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Save'
    );
    const settingsText = settings?.innerText ?? '';
    const codingPlanStatus = [...document.querySelectorAll('.settings-kv div')]
      .find((row) =>
        row.querySelector('dt')?.textContent.trim() === 'Coding Plan key'
      )
      ?.querySelector('dd')
      ?.textContent.trim() ?? '';
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    const visibleSecret =
      settingsText.includes('sk-desktop-e2e') ||
      settingsText.includes('cp-desktop-e2e');
    const hasAnySecret =
      visibleSecret ||
      fieldValues.includes('sk-desktop-e2e') ||
      fieldValues.includes('cp-desktop-e2e');
    return {
      providerLabel: provider?.getAttribute('aria-label') ?? null,
      providerValue: provider?.value ?? null,
      providerFocused: document.activeElement === provider,
      hasRegionField: region !== null,
      regionValue: region?.value ?? null,
      hasModelField: model !== null,
      hasBaseUrlField: baseUrl !== null,
      apiKeyType: apiKey?.getAttribute('type') ?? null,
      apiKeyLength: apiKey?.value.length ?? 0,
      validationText: validation?.textContent.trim() ?? '',
      saveStatusText: saveStatus?.textContent.trim() ?? '',
      saveStatusRole: saveStatus?.getAttribute('role') ?? null,
      saveStatusClass: saveStatus?.className ?? '',
      saveDisabled: saveButton?.disabled ?? null,
      saveDescribedBy: saveButton?.getAttribute('aria-describedby') ?? null,
      settingsProviderText: settingsText,
      codingPlanStatus,
      codingPlanConfigured: codingPlanStatus === 'Configured',
      visibleSecret,
      hasAnySecret,
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);
}

async function assertSettingsPermissionsModelLabelRestraint(fileName) {
  const clicked = await evaluate(`(() => {
    const link = document.querySelector(
      '[data-testid="settings-section-nav"] a[href="#settings-permissions"]'
    );
    link?.click();
    return link !== null;
  })()`);

  if (!clicked) {
    throw new Error('Settings Permissions rail link was not found.');
  }

  await waitFor(
    'settings permissions thread model labels',
    async () =>
      evaluate(`(() => {
        const permissions = document.querySelector(
          '[data-testid="permissions-config"]'
        );
        const select = permissions?.querySelector(
          'select[aria-label="Thread model"]'
        );
        return Boolean(
          select &&
          !select.disabled &&
          [...select.options].some((option) =>
            option.value === 'qwen3.5-plus' ||
            option.value === 'qwen3-coder-next'
          )
        );
      })()`),
    10_000,
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
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const settings = document.querySelector('[data-testid="settings-page"]');
    const content = document.querySelector(
      '[data-testid="settings-sections"]'
    );
    const permissions = document.querySelector(
      '[data-testid="permissions-config"]'
    );
    const select = permissions?.querySelector(
      'select[aria-label="Thread model"]'
    );
    const bodyText = document.body.innerText;
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    const options = select
      ? [...select.options].map((option) => ({
          value: option.value,
          text: option.textContent.trim(),
          title: option.getAttribute('title') ?? '',
          selected: option.selected,
          textLength: option.textContent.trim().length
        }))
      : [];
    const groups = select
      ? [...select.querySelectorAll('optgroup')].map((group) => ({
          label: group.label,
          values: [...group.querySelectorAll('option')].map(
            (option) => option.value
          ),
          texts: [...group.querySelectorAll('option')].map((option) =>
            option.textContent.trim()
          )
        }))
      : [];
    return {
      disabled: select?.disabled ?? null,
      value: select?.value ?? null,
      title: select?.getAttribute('title') ?? null,
      options,
      groups,
      codingPlanOptions: options.filter(
        (option) =>
          option.value === 'qwen3.5-plus' ||
          option.value === 'qwen3-coder-next' ||
          option.value === 'qwen3-coder-plus' ||
          option.value.startsWith('glm') ||
          option.value.startsWith('MiniMax') ||
          option.value.startsWith('kimi')
      ),
      hasRawVisibleCodingPlanLabel: options.some((option) =>
        option.text.includes('ModelStudio Coding Plan')
      ),
      hasCodingPlanTitle: options.some((option) =>
        option.title.includes('ModelStudio Coding Plan')
      ),
      hasCompactCodingPlanLabel: options.some(
        (option) =>
          option.value === 'qwen3.5-plus' && option.text === 'qwen3.5-plus'
      ),
      visibleSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e'),
      hasAnySecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      settingsRect: rectFor(settings),
      contentRect: rectFor(content),
      permissionsRect: rectFor(permissions),
      selectRect: rectFor(select),
      selectOverflow: overflows(select),
      permissionsOverflow: overflows(permissions),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.disabled !== false) {
    throw new Error(
      `Settings thread model selector should be enabled: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.hasCompactCodingPlanLabel ||
    snapshot.hasRawVisibleCodingPlanLabel ||
    !snapshot.hasCodingPlanTitle ||
    snapshot.codingPlanOptions.length === 0
  ) {
    throw new Error(
      `Settings permissions exposed raw or missing Coding Plan labels: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  const savedProviderGroup = snapshot.groups.find(
    (group) => group.label === 'Saved providers',
  );
  const codingPlanGroup = snapshot.groups.find(
    (group) => group.label === 'Coding Plan',
  );
  if (
    !savedProviderGroup?.values.includes('qwen-e2e-cdp') ||
    !codingPlanGroup ||
    !codingPlanGroup.values.some(
      (value) => value === 'qwen3.5-plus' || value === 'qwen3-coder-next',
    ) ||
    snapshot.groups.some((group) =>
      group.label.includes('ModelStudio Coding Plan'),
    )
  ) {
    throw new Error(
      `Settings permissions model groups are not provider-scoped: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.codingPlanOptions.some(
      (option) =>
        option.text.includes('ModelStudio Coding Plan') ||
        option.textLength > 32,
    )
  ) {
    throw new Error(
      `Settings permissions Coding Plan labels are not compact: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.visibleSecret ||
    snapshot.hasAnySecret ||
    snapshot.hasServerUrl ||
    snapshot.documentOverflow ||
    snapshot.permissionsOverflow ||
    snapshot.selectOverflow
  ) {
    throw new Error(
      `Settings permissions model labels leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.settingsRect ||
    !snapshot.permissionsRect ||
    !snapshot.selectRect ||
    snapshot.permissionsRect.left < snapshot.settingsRect.left ||
    snapshot.permissionsRect.right > snapshot.settingsRect.right + 1 ||
    snapshot.selectRect.right > snapshot.permissionsRect.right + 1
  ) {
    throw new Error(
      `Settings permissions model label geometry regressed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function assertSettingsPermissionsProviderHealth(fileName, modelId) {
  const expectedStatus = 'Saved API key provider · API key configured';
  const expectedTitle = `${modelId} · ${expectedStatus}`;

  await setFieldByAriaLabel('Thread model', modelId);
  await waitFor(
    'settings permissions provider health',
    async () =>
      evaluate(`(() => {
        const control = document.querySelector(
          '[data-testid="settings-thread-model-control"]'
        );
        const select = control?.querySelector(
          'select[aria-label="Thread model"]'
        );
        const dot = control?.querySelector(
          '[data-testid="settings-thread-model-provider-status"]'
        );
        const selected = select
          ? [...select.options].find((option) => option.selected)
          : null;
        return Boolean(
          control &&
          select &&
          dot &&
          select.value === ${JSON.stringify(modelId)} &&
          control.getAttribute('title') === ${JSON.stringify(expectedTitle)} &&
          select.getAttribute('title') === ${JSON.stringify(expectedTitle)} &&
          selected?.getAttribute('title') === ${JSON.stringify(expectedTitle)} &&
          dot.getAttribute('aria-label') === ${JSON.stringify(expectedStatus)}
        );
      })()`),
    10_000,
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        display: style.display,
        backgroundColor: style.backgroundColor,
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        boxShadow: style.boxShadow
      };
    };
    const settings = document.querySelector('[data-testid="settings-page"]');
    const permissions = document.querySelector(
      '[data-testid="permissions-config"]'
    );
    const control = document.querySelector(
      '[data-testid="settings-thread-model-control"]'
    );
    const shell = control?.querySelector('.settings-thread-model-shell');
    const select = control?.querySelector(
      'select[aria-label="Thread model"]'
    );
    const dot = control?.querySelector(
      '[data-testid="settings-thread-model-provider-status"]'
    );
    const selected = select
      ? [...select.options].find((option) => option.selected)
      : null;
    const bodyText = settings?.innerText ?? '';
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      controlTitle: control?.getAttribute('title') ?? null,
      controlClass: control?.className ?? '',
      shellRect: rectFor(shell),
      selectTitle: select?.getAttribute('title') ?? null,
      selectValue: select?.value ?? null,
      selectedText: selected?.textContent.trim() ?? null,
      selectedTitle: selected?.getAttribute('title') ?? null,
      selectedTextLength: selected?.textContent.trim().length ?? 0,
      dotAriaLabel: dot?.getAttribute('aria-label') ?? null,
      dotTitle: dot?.getAttribute('title') ?? null,
      dotClass: dot?.className ?? '',
      dotStyle: styleFor(dot),
      settingsRect: rectFor(settings),
      permissionsRect: rectFor(permissions),
      controlRect: rectFor(control),
      selectRect: rectFor(select),
      dotRect: rectFor(dot),
      controlOverflow:
        Boolean(control) && control.scrollWidth > control.clientWidth + 4,
      shellOverflow:
        Boolean(shell) && shell.scrollWidth > shell.clientWidth + 4,
      selectOverflow:
        Boolean(select) && select.scrollWidth > select.clientWidth + 4,
      visibleSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e'),
      hasAnySecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      hasRawCodingPlanLabel:
        bodyText.includes('ModelStudio Coding Plan') ||
        (selected?.textContent ?? '').includes('ModelStudio Coding Plan'),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    snapshot.controlTitle !== expectedTitle ||
    snapshot.selectTitle !== expectedTitle ||
    snapshot.selectedTitle !== expectedTitle ||
    snapshot.selectValue !== modelId ||
    snapshot.dotAriaLabel !== expectedStatus ||
    snapshot.dotTitle !== expectedStatus
  ) {
    throw new Error(
      `Settings permissions provider health metadata is missing: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.controlClass.includes(
      'settings-thread-model-label-with-status',
    ) ||
    !snapshot.dotClass.includes('settings-thread-model-status-configured') ||
    !snapshot.dotStyle ||
    snapshot.dotStyle.width > 7 ||
    snapshot.dotStyle.height > 7
  ) {
    throw new Error(
      `Settings permissions provider health indicator is not compact: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.settingsRect ||
    !snapshot.permissionsRect ||
    !snapshot.controlRect ||
    !snapshot.shellRect ||
    !snapshot.selectRect ||
    !snapshot.dotRect ||
    snapshot.permissionsRect.left < snapshot.settingsRect.left ||
    snapshot.permissionsRect.right > snapshot.settingsRect.right + 1 ||
    snapshot.controlRect.left < snapshot.permissionsRect.left - 1 ||
    snapshot.controlRect.right > snapshot.permissionsRect.right + 1 ||
    snapshot.selectRect.right > snapshot.controlRect.right + 1 ||
    snapshot.dotRect.left < snapshot.shellRect.left ||
    snapshot.dotRect.right > snapshot.shellRect.right + 1 ||
    snapshot.dotRect.top < snapshot.shellRect.top ||
    snapshot.dotRect.bottom > snapshot.shellRect.bottom + 1
  ) {
    throw new Error(
      `Settings permissions provider health geometry regressed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.selectedTextLength > 32 ||
    snapshot.visibleSecret ||
    snapshot.hasAnySecret ||
    snapshot.hasServerUrl ||
    snapshot.hasRawCodingPlanLabel ||
    snapshot.controlOverflow ||
    snapshot.shellOverflow ||
    snapshot.selectOverflow ||
    snapshot.documentOverflow
  ) {
    throw new Error(
      `Settings permissions provider health leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
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
    const readLabel = (element) => {
      const style = window.getComputedStyle(element);
      return {
        text: element.textContent.trim(),
        textTransform: style.textTransform,
        fontWeight: Number.parseFloat(style.fontWeight),
        fontSize: Number.parseFloat(style.fontSize),
        overflows: element.scrollWidth > element.clientWidth + 4
      };
    };
    const diagnosticLabels = advanced
      ? [...advanced.querySelectorAll('.runtime-details dt')].map(readLabel)
      : [];
    return {
      text: advanced?.innerText ?? '',
      runtimeText: runtime?.innerText ?? '',
      expanded: toggle?.getAttribute('aria-expanded') ?? null,
      diagnosticLabels,
      diagnosticLabelTexts: diagnosticLabels.map((label) => label.text),
      hasSecret:
        (advanced?.innerText ?? '').includes('sk-desktop-e2e') ||
        (advanced?.innerText ?? '').includes('cp-desktop-e2e') ||
        [...document.querySelectorAll('input')].some((input) =>
          input.value.includes('sk-desktop-e2e') ||
          input.value.includes('cp-desktop-e2e')
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

  const expectedDiagnosticLabels = [
    'Active',
    'Commands',
    'Skills',
    'Tokens',
    'Settings path',
    'Server',
    'Desktop',
    'Platform',
    'Node',
    'ACP',
    'Health',
  ];
  const missingDiagnosticLabels = expectedDiagnosticLabels.filter(
    (label) => !snapshot.diagnosticLabelTexts.includes(label),
  );
  if (missingDiagnosticLabels.length > 0) {
    throw new Error(
      `Advanced diagnostics labels are missing: ${missingDiagnosticLabels.join(
        ', ',
      )}`,
    );
  }

  const noisyDiagnosticLabels = snapshot.diagnosticLabels.filter(
    (label) =>
      label.textTransform !== 'none' ||
      label.fontWeight > 700 ||
      label.fontSize > 12 ||
      label.overflows,
  );
  if (noisyDiagnosticLabels.length > 0) {
    throw new Error(
      `Advanced diagnostics labels still read as debug chrome: ${JSON.stringify(
        noisyDiagnosticLabels,
      )}`,
    );
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

async function assertDraftComposerSavedModelState(fileName, savedModelId) {
  await waitFor(
    'draft composer configured model options',
    async () =>
      evaluate(`(() => {
        const select = document.querySelector('select[aria-label="Model"]');
        const permission = document.querySelector(
          'select[aria-label="Permission mode"]'
        );
        return Boolean(
          select &&
          permission &&
          !select.disabled &&
          !permission.disabled &&
          [...select.options].length > 0 &&
          [...select.options].some(
            (option) => option.value === ${JSON.stringify(savedModelId)}
          )
        );
      })()`),
    10_000,
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
    const overflows = (element) =>
      Boolean(element && element.scrollWidth > element.clientWidth + 4);
    const select = document.querySelector('select[aria-label="Model"]');
    const permission = document.querySelector(
      'select[aria-label="Permission mode"]'
    );
    const composer = document.querySelector('[data-testid="message-composer"]');
    const chat = document.querySelector('[data-testid="chat-thread"]');
    const modelControl = document.querySelector(
      '[data-testid="composer-model-control"]'
    );
    const bodyText = document.body.innerText;
    const options = select
      ? [...select.options].map((option) => ({
          value: option.value,
          text: option.textContent.trim(),
          title: option.getAttribute('title') ?? '',
          selected: option.selected
        }))
      : [];
    const groups = select
      ? [...select.querySelectorAll('optgroup')].map((group) => ({
          label: group.label,
          values: [...group.querySelectorAll('option')].map(
            (option) => option.value
          ),
          texts: [...group.querySelectorAll('option')].map((option) =>
            option.textContent.trim()
          )
        }))
      : [];
    const selected = options.find((option) => option.selected) ?? null;
    return {
      disabled: select?.disabled ?? null,
      permissionDisabled: permission?.disabled ?? null,
      value: select?.value ?? null,
      title: select?.getAttribute('title') ?? null,
      options,
      groups,
      selected,
      hasSavedModel: options.some(
        (option) => option.value === ${JSON.stringify(savedModelId)}
      ),
      hasDefaultModel:
        (select?.value ?? '') === 'default' ||
        options.some((option) => option.text === 'Default model'),
      hasRawCodingPlanLabel: options.some((option) =>
        option.text.includes('ModelStudio Coding Plan')
      ),
      hasNewThreadNotice: bodyText.includes('New thread'),
      hasSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        [...document.querySelectorAll('input, textarea')].some((field) =>
          field.value.includes('sk-desktop-e2e') ||
          field.value.includes('cp-desktop-e2e')
        ),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      composerRect: rectFor(composer),
      chatRect: rectFor(chat),
      modelControlRect: rectFor(modelControl),
      selectRect: rectFor(select),
      composerOverflow: overflows(composer),
      modelControlOverflow: overflows(modelControl),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.disabled !== false || snapshot.permissionDisabled !== false) {
    throw new Error(
      `Draft composer runtime selectors should be enabled: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.hasSavedModel ||
    snapshot.hasDefaultModel ||
    !snapshot.selected ||
    snapshot.selected.value === 'default'
  ) {
    throw new Error(
      `Draft composer did not show saved configured models: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (snapshot.hasRawCodingPlanLabel) {
    throw new Error(
      `Draft composer exposed raw Coding Plan labels: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  const savedProviderGroup = snapshot.groups.find(
    (group) => group.label === 'Saved providers',
  );
  const codingPlanGroup = snapshot.groups.find(
    (group) => group.label === 'Coding Plan',
  );
  if (
    !savedProviderGroup?.values.includes(savedModelId) ||
    !codingPlanGroup?.values.some((value) => value === 'qwen3.5-plus') ||
    snapshot.groups.some((group) =>
      group.label.includes('ModelStudio Coding Plan'),
    )
  ) {
    throw new Error(
      `Draft composer model groups are not provider-scoped: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (!snapshot.hasNewThreadNotice) {
    throw new Error(
      'Draft composer should keep the New thread notice visible.',
    );
  }

  if (
    snapshot.hasSecret ||
    snapshot.hasServerUrl ||
    snapshot.documentOverflow ||
    snapshot.composerOverflow ||
    snapshot.modelControlOverflow
  ) {
    throw new Error(
      `Draft composer saved model state leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.composerRect ||
    !snapshot.chatRect ||
    snapshot.composerRect.bottom > snapshot.chatRect.bottom + 1 ||
    !snapshot.modelControlRect ||
    !snapshot.selectRect ||
    snapshot.modelControlRect.width > 128 ||
    snapshot.modelControlRect.height > 25 ||
    snapshot.selectRect.height > 25
  ) {
    throw new Error(
      `Draft composer saved model geometry regressed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }
}

async function clickFirstThreadRow() {
  await waitFor(
    'saved thread row',
    async () =>
      evaluate(`document.querySelector('[data-testid="thread-row"]') !== null`),
    10_000,
  );

  await evaluate(`(() => {
    const row = document.querySelector('[data-testid="thread-row"]');
    row?.click();
    return true;
  })()`);
}

async function assertComposerModelSwitch(fileName, modelId) {
  await waitFor(
    'configured composer model option',
    async () =>
      evaluate(`(() => {
        const select = document.querySelector('select[aria-label="Model"]');
        return Boolean(
          select &&
          !select.disabled &&
          [...select.options].some(
            (option) => option.value === ${JSON.stringify(modelId)}
          )
        );
      })()`),
    15_000,
  );

  await setFieldByAriaLabel('Model', modelId);
  await waitFor(
    'composer model switch',
    async () =>
      evaluate(`(() => {
        const select = document.querySelector('select[aria-label="Model"]');
        return Boolean(select && select.value === ${JSON.stringify(modelId)});
      })()`),
    15_000,
  );

  const snapshot = await evaluate(`(() => {
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
    const select = document.querySelector('select[aria-label="Model"]');
    const options = select
      ? [...select.options].map((option) => ({
          value: option.value,
          text: option.textContent.trim(),
          selected: option.selected
        }))
      : [];
    const groups = select
      ? [...select.querySelectorAll('optgroup')].map((group) => ({
          label: group.label,
          values: [...group.querySelectorAll('option')].map(
            (option) => option.value
          ),
          texts: [...group.querySelectorAll('option')].map((option) =>
            option.textContent.trim()
          )
        }))
      : [];
    const selected = options.find((option) => option.selected) ?? null;
    const bodyText = document.body.innerText;
    return {
      composer: rectFor('[data-testid="message-composer"]'),
      chat: rectFor('[data-testid="chat-thread"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      disabled: select?.disabled ?? null,
      value: select?.value ?? null,
      options,
      groups,
      selected,
      hasRawCodingPlanLabel: options.some((option) =>
        option.text.includes('ModelStudio Coding Plan')
      ),
      codingPlanOptions: options
        .filter(
          (option) =>
            option.value.startsWith('qwen3') ||
            option.value.startsWith('glm') ||
            option.value.startsWith('MiniMax') ||
            option.value.startsWith('kimi')
        )
        .map((option) => ({
          value: option.value,
          text: option.text,
          textLength: option.text.length
        })),
      hasSavedModel: options.some(
        (option) => option.value === ${JSON.stringify(modelId)}
      ),
      hasSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        [...document.querySelectorAll('input, textarea')].some((field) =>
          field.value.includes('sk-desktop-e2e') ||
          field.value.includes('cp-desktop-e2e')
        ),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      composerOverflow:
        Boolean(
          document.querySelector('[data-testid="message-composer"]') &&
          document.querySelector('[data-testid="message-composer"]').scrollWidth >
            document.querySelector('[data-testid="message-composer"]').clientWidth + 4
        )
    };
  })()`);

  const longCodingPlanModelId = 'qwen3-coder-next';
  if (
    snapshot.options.some((option) => option.value === longCodingPlanModelId)
  ) {
    await setFieldByAriaLabel('Model', longCodingPlanModelId);
    await waitFor(
      'composer long Coding Plan model switch',
      async () =>
        evaluate(`(() => {
          const select = document.querySelector('select[aria-label="Model"]');
          return Boolean(select && select.value === ${JSON.stringify(
            longCodingPlanModelId,
          )});
        })()`),
      15_000,
    );
    snapshot.longCodingPlanSelection = await evaluate(`(() => {
      const select = document.querySelector('select[aria-label="Model"]');
      const selected = select
        ? [...select.options].find((option) => option.selected)
        : null;
      const composer = document.querySelector('[data-testid="message-composer"]');
      const chat = document.querySelector('[data-testid="chat-thread"]');
      return {
        value: select?.value ?? null,
        selectTitle: select?.getAttribute('title') ?? null,
        selectedText: selected?.textContent.trim() ?? null,
        selectedTitle: selected?.getAttribute('title') ?? null,
        contained:
          Boolean(composer && chat) &&
          composer.getBoundingClientRect().bottom <=
            chat.getBoundingClientRect().bottom + 1,
        composerOverflow:
          Boolean(composer) && composer.scrollWidth > composer.clientWidth + 4
      };
    })()`);
    await setFieldByAriaLabel('Model', modelId);
    await waitFor(
      'composer configured model restored',
      async () =>
        evaluate(`(() => {
          const select = document.querySelector('select[aria-label="Model"]');
          return Boolean(select && select.value === ${JSON.stringify(modelId)});
        })()`),
      15_000,
    );
    snapshot.restoredValue = await evaluate(
      `document.querySelector('select[aria-label="Model"]')?.value ?? null`,
    );
  } else {
    snapshot.longCodingPlanSelection = null;
    snapshot.restoredValue = snapshot.value;
  }

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (snapshot.disabled !== false) {
    throw new Error(
      'Composer model picker should be enabled for active thread.',
    );
  }

  if (!snapshot.hasSavedModel || snapshot.value !== modelId) {
    throw new Error(
      `Composer did not switch to configured model: ${JSON.stringify(snapshot)}`,
    );
  }

  if (snapshot.hasRawCodingPlanLabel) {
    throw new Error(
      `Composer exposed raw Coding Plan labels: ${JSON.stringify(snapshot)}`,
    );
  }

  const activeGroup = snapshot.groups.find(
    (group) => group.label === 'Active session',
  );
  const savedProviderGroup = snapshot.groups.find(
    (group) => group.label === 'Saved providers',
  );
  const codingPlanGroup = snapshot.groups.find(
    (group) => group.label === 'Coding Plan',
  );
  if (
    !activeGroup?.values.includes('e2e/qwen-code') ||
    !savedProviderGroup?.values.includes(modelId) ||
    !codingPlanGroup?.values.includes(longCodingPlanModelId) ||
    snapshot.groups.some((group) =>
      group.label.includes('ModelStudio Coding Plan'),
    )
  ) {
    throw new Error(
      `Composer model groups are not provider-scoped: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (!snapshot.longCodingPlanSelection) {
    throw new Error(
      `Composer did not expose the long Coding Plan model option: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.longCodingPlanSelection.value !== longCodingPlanModelId ||
    typeof snapshot.longCodingPlanSelection.selectedText !== 'string' ||
    snapshot.longCodingPlanSelection.selectedText.includes(
      'ModelStudio Coding Plan',
    ) ||
    typeof snapshot.longCodingPlanSelection.selectedTitle !== 'string' ||
    !snapshot.longCodingPlanSelection.selectedTitle.includes(
      'ModelStudio Coding Plan',
    ) ||
    !snapshot.longCodingPlanSelection.contained ||
    snapshot.longCodingPlanSelection.composerOverflow ||
    snapshot.restoredValue !== modelId
  ) {
    throw new Error(
      `Composer long Coding Plan model switch failed: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (snapshot.hasSecret) {
    throw new Error('Composer model workflow exposed the fake API key.');
  }

  if (snapshot.hasServerUrl) {
    throw new Error('Conversation view exposed the local server URL.');
  }

  if (
    !snapshot.composer ||
    !snapshot.chat ||
    snapshot.composer.bottom > snapshot.chat.bottom + 1
  ) {
    throw new Error('Composer model picker is not contained in chat panel.');
  }

  if (snapshot.composerOverflow) {
    throw new Error('Composer overflows after model switch.');
  }
}

async function assertComposerModelProviderHealth(fileName, modelId) {
  const expectedStatus = 'Saved API key provider · API key configured';
  const expectedTitle = `${modelId} · ${expectedStatus}`;

  await waitFor(
    'composer model provider health',
    async () =>
      evaluate(`(() => {
        const control = document.querySelector(
          '[data-testid="composer-model-control"]'
        );
        const select = control?.querySelector('select[aria-label="Model"]');
        const dot = control?.querySelector(
          '[data-testid="composer-model-provider-status"]'
        );
        const selected = select
          ? [...select.options].find((option) => option.selected)
          : null;
        return Boolean(
          control &&
          select &&
          dot &&
          select.value === ${JSON.stringify(modelId)} &&
          select.getAttribute('title') === ${JSON.stringify(expectedTitle)} &&
          selected?.getAttribute('title') === ${JSON.stringify(expectedTitle)} &&
          dot.getAttribute('aria-label') === ${JSON.stringify(expectedStatus)}
        );
      })()`),
    10_000,
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
    const styleFor = (element) => {
      if (!element) {
        return null;
      }
      const style = window.getComputedStyle(element);
      return {
        display: style.display,
        backgroundColor: style.backgroundColor,
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        boxShadow: style.boxShadow
      };
    };
    const control = document.querySelector(
      '[data-testid="composer-model-control"]'
    );
    const select = control?.querySelector('select[aria-label="Model"]');
    const dot = control?.querySelector(
      '[data-testid="composer-model-provider-status"]'
    );
    const selected = select
      ? [...select.options].find((option) => option.selected)
      : null;
    const bodyText = document.body.innerText;
    const fieldValues = [...document.querySelectorAll('input, textarea')]
      .map((field) => field.value ?? '')
      .join('\\n');
    return {
      controlTitle: control?.getAttribute('title') ?? null,
      controlClass: control?.className ?? '',
      selectTitle: select?.getAttribute('title') ?? null,
      selectValue: select?.value ?? null,
      selectedText: selected?.textContent.trim() ?? null,
      selectedTitle: selected?.getAttribute('title') ?? null,
      selectedTextLength: selected?.textContent.trim().length ?? 0,
      dotAriaLabel: dot?.getAttribute('aria-label') ?? null,
      dotTitle: dot?.getAttribute('title') ?? null,
      dotClass: dot?.className ?? '',
      dotStyle: styleFor(dot),
      controlRect: rectFor(control),
      selectRect: rectFor(select),
      dotRect: rectFor(dot),
      controlOverflow:
        Boolean(control) && control.scrollWidth > control.clientWidth + 4,
      selectOverflow:
        Boolean(select) && select.scrollWidth > select.clientWidth + 4,
      hasRawCodingPlanLabel:
        (selected?.textContent ?? '').includes('ModelStudio Coding Plan'),
      hasSecret:
        bodyText.includes('sk-desktop-e2e') ||
        bodyText.includes('cp-desktop-e2e') ||
        fieldValues.includes('sk-desktop-e2e') ||
        fieldValues.includes('cp-desktop-e2e'),
      hasServerUrl: /http:\\/\\/127\\.0\\.0\\.1:/u.test(bodyText),
      documentOverflow:
        document.body.scrollWidth > window.innerWidth + 4 ||
        document.body.scrollHeight > window.innerHeight + 4
    };
  })()`);

  await writeFile(
    join(artifactDir, fileName),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    'utf8',
  );

  if (
    snapshot.controlTitle !== expectedTitle ||
    snapshot.selectTitle !== expectedTitle ||
    snapshot.selectedTitle !== expectedTitle ||
    snapshot.selectValue !== modelId ||
    snapshot.dotAriaLabel !== expectedStatus ||
    snapshot.dotTitle !== expectedStatus
  ) {
    throw new Error(
      `Composer model provider health metadata is missing: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.controlClass.includes('composer-select-label-with-status') ||
    !snapshot.dotClass.includes('composer-model-status-configured') ||
    !snapshot.dotStyle ||
    snapshot.dotStyle.width > 7 ||
    snapshot.dotStyle.height > 7
  ) {
    throw new Error(
      `Composer model provider health indicator is not compact: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    !snapshot.controlRect ||
    !snapshot.selectRect ||
    !snapshot.dotRect ||
    snapshot.controlRect.width > 128 ||
    snapshot.selectRect.width > snapshot.controlRect.width + 1 ||
    snapshot.dotRect.left < snapshot.controlRect.left ||
    snapshot.dotRect.right > snapshot.controlRect.right + 1 ||
    snapshot.dotRect.top < snapshot.controlRect.top ||
    snapshot.dotRect.bottom > snapshot.controlRect.bottom + 1
  ) {
    throw new Error(
      `Composer model provider health indicator escaped the model control: ${JSON.stringify(
        snapshot,
      )}`,
    );
  }

  if (
    snapshot.selectedTextLength > 32 ||
    snapshot.hasRawCodingPlanLabel ||
    snapshot.hasSecret ||
    snapshot.hasServerUrl ||
    snapshot.controlOverflow ||
    snapshot.selectOverflow ||
    snapshot.documentOverflow
  ) {
    throw new Error(
      `Composer model provider health leaked data or overflowed: ${JSON.stringify(
        snapshot,
      )}`,
    );
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

async function pressKey(key) {
  const code = key === 'Escape' ? 'Escape' : key;
  const windowsVirtualKeyCode = key === 'Escape' ? 27 : 0;

  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode,
    });
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

async function focusFieldByAriaLabel(label) {
  const snapshot = await evaluate(`(() => {
    const field = document.querySelector('[aria-label="${escapeSelector(
      label,
    )}"]');
    if (!field) {
      return null;
    }
    field.focus();
    const rect = field.getBoundingClientRect();
    return {
      active: document.activeElement === field,
      activeLabel:
        document.activeElement?.getAttribute('aria-label') ?? null,
      tagName: field.tagName,
      value: field.value ?? null,
      rect: {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height
      }
    };
  })()`);

  if (!snapshot?.active) {
    throw new Error(`Field did not receive focus: ${label}`);
  }

  return snapshot;
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

  if (cleanWorkspaceDir) {
    await writeCommandOutput('git-status-clean.txt', 'git', [
      '-C',
      cleanWorkspaceDir,
      'status',
      '--porcelain=v1',
      '--branch',
    ]);
    await writeCommandOutput('git-diff-clean.txt', 'git', [
      '-C',
      cleanWorkspaceDir,
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

function isRectContained(child, parent, tolerance = 1) {
  return Boolean(
    child &&
      parent &&
      child.left >= parent.left - tolerance &&
      child.right <= parent.right + tolerance &&
      child.top >= parent.top - tolerance &&
      child.bottom <= parent.bottom + tolerance,
  );
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
