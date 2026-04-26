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
const longPromptToken =
  'desktopE2ELongPromptSegment_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' +
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const commandApprovalPrompt = 'Please exercise command approval.';
const questionPrompt = `Please ask a user question. ${longPromptToken}`;
const compactThreadTitle = 'Review README.md after the failing test';
const noisyThreadTitleLeaks = [
  '/tmp/',
  '127.0.0.1',
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
  await setFieldByAriaLabel('Message', commandApprovalPrompt);
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
  await setFieldByAriaLabel('Message', questionPrompt);
  await clickButton('Send');
  await waitForText('Pick the next review focus');
  await assertInlineQuestionCard('inline-question-card.json');
  await saveScreenshot('inline-question-card.png');
  await clickButton('Submit Question');
  await waitForText('E2E fake ACP question response recorded');
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
          gitStatus?.textContent.trim() === '2 dirty' &&
          gitStatus?.getAttribute('title') ===
            'Git status: 1 modified · 0 staged · 1 untracked'
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
  await waitForText('2 staged');
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
  await setElectronWindowBounds(target.id, compactWindowBounds);
  await assertCompactSettingsOverlayLayout('compact-settings-overlay.json');
  await saveScreenshot('compact-settings-overlay.png');
  await setElectronWindowBounds(target.id, defaultWindowBounds);
  await assertSettingsValidation('settings-validation.json');
  await clickButton('Save');
  await waitForText('qwen-e2e-cdp');
  await assertSettingsProductState('settings-product-state.json');
  await assertSettingsCodingPlanWorkflow('settings-coding-plan-provider.json');
  await saveScreenshot('settings-coding-plan-state.png');
  await clickButton('Advanced Diagnostics');
  await waitForSelector('[data-testid="runtime-diagnostics"]');
  await assertSettingsAdvancedDiagnostics('settings-advanced-diagnostics.json');

  await clickButton('Conversation');
  await waitForSelector('[data-testid="terminal-drawer"]');
  await assertComposerModelSwitch('composer-model-switch.json', 'qwen-e2e-cdp');
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

  if (snapshot.permissionDisabled !== true || snapshot.modelDisabled !== true) {
    throw new Error(
      'Project composer runtime selectors should stay disabled before a session exists.',
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
      throw new Error(
        `Composer chip scale regressed: ${JSON.stringify(chip)}`,
      );
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
    const overflows = (selector) => {
      const element = document.querySelector(selector);
      return Boolean(element && element.scrollWidth > element.clientWidth + 4);
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
      terminalProject: rectFor('[data-testid="terminal-strip-project"]'),
      terminalStatus: rectFor('[data-testid="terminal-strip-status"]'),
      terminalPreview: rectFor('[data-testid="terminal-strip-preview"]'),
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
        lineHeight: Number.parseFloat(style.lineHeight)
      };
    };
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
      projectRows,
      headingStyles,
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

  const oversizedHeadings = metrics.headingStyles.filter(
    (style) => style && style.fontSize > 9.75,
  );
  if (oversizedHeadings.length > 0) {
    throw new Error(
      `Sidebar heading typography regressed: ${JSON.stringify(
        oversizedHeadings,
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
    activeProjectRow.dirtyTitle !==
      '1 modified · 0 staged · 1 untracked'
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
        borderTopAlpha: alphaFromColor(style.borderTopColor),
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseFloat(style.fontWeight),
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
    metrics.gitStatus.text !== '2 dirty' ||
    !metrics.gitStatus.title.includes('1 modified · 0 staged · 1 untracked') ||
    !metrics.gitStatus.ariaLabel.includes('1 modified · 0 staged · 1 untracked')
  ) {
    throw new Error(
      `Topbar Git status should be compact but preserve details: ${JSON.stringify(
        metrics.gitStatus,
      )}`,
    );
  }

  if (!metrics.topbarText.includes(compactThreadTitle)) {
    throw new Error(
      `Topbar did not expose the compact thread title: ${metrics.topbarText}`,
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

  if (
    metrics.runtimeStatus.height > 29 ||
    metrics.runtimeStatus.width > 72 ||
    metrics.runtimeStatusStyle.fontSize > 10.75
  ) {
    throw new Error(
      `Runtime status should stay compact: ${JSON.stringify(
        {
          rect: metrics.runtimeStatus,
          style: metrics.runtimeStatusStyle,
        },
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
    snapshot.ui.gitStatusText !== '2 dirty' ||
    !snapshot.ui.gitStatusTitle.includes('1 modified · 0 staged · 1 untracked')
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
    snapshot.ui.gitStatusText !== '2 dirty' ||
    !snapshot.ui.gitStatusTitle.includes('1 modified · 0 staged · 1 untracked')
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
      `Messages should not render role-label text nodes: ${JSON.stringify(
        {
          assistant: snapshot.assistant,
          user: snapshot.user,
        },
      )}`,
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

  if (snapshot.composer.rect.width > 840 || snapshot.composer.rect.height > 94) {
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
        lineHeight: numberFromPixel(style.lineHeight),
        overflowWrap: style.overflowWrap,
        position: style.position,
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
      overlay: rectFor('[data-testid="settings-overlay"]'),
      backdrop: rectFor('.settings-overlay-backdrop'),
      settings: rectFor('[data-testid="settings-page"]'),
      closeButton: rectFor('[data-testid="settings-close-button"]'),
      modelConfig: rectFor('[data-testid="model-config"]'),
      permissionsConfig: rectFor('[data-testid="permissions-config"]'),
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
    'closeButton',
    'modelConfig',
    'permissionsConfig',
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
    metrics.settings.width > 820 ||
    metrics.settings.width < 520
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

async function assertCompactSettingsOverlayLayout(fileName) {
  await waitFor(
    'compact settings close button focused',
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
      settingsContent: rectForElement(settingsContent),
      closeButton: rectFor('[data-testid="settings-close-button"]'),
      modelConfig: rectFor('[data-testid="model-config"]'),
      permissionsConfig: rectForElement(permissions),
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
      settingsText:
        document.querySelector('[data-testid="settings-page"]')?.innerText ?? ''
    };

    permissions?.scrollIntoView({ block: 'center' });
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
    'settingsContent',
    'closeButton',
    'modelConfig',
    'permissionsConfig',
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
    snapshots.invalidBaseUrl.validationText !==
    'Use a valid HTTP(S) base URL.'
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
    throw new Error('Advanced diagnostics opened before the user requested it.');
  }
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
      saveDisabled: saveButton?.disabled ?? null,
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

  if (!/http:\/\/127\.0\.0\.1:/u.test(snapshot.runtimeText)) {
    throw new Error(
      `Advanced diagnostics did not show the local server URL: ${snapshot.runtimeText}`,
    );
  }

  if (snapshot.hasSecret) {
    throw new Error('Advanced diagnostics exposed the fake API key.');
  }
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
    const selected = options.find((option) => option.selected) ?? null;
    const bodyText = document.body.innerText;
    return {
      composer: rectFor('[data-testid="message-composer"]'),
      chat: rectFor('[data-testid="chat-thread"]'),
      terminal: rectFor('[data-testid="terminal-drawer"]'),
      disabled: select?.disabled ?? null,
      value: select?.value ?? null,
      options,
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
    snapshot.options.some(
      (option) => option.value === longCodingPlanModelId,
    )
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
    throw new Error('Composer model picker should be enabled for active thread.');
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
