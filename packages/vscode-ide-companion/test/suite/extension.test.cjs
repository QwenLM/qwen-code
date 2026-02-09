/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const assert = require('node:assert');
const path = require('node:path');
const vscode = require('vscode');

const CHAT_VIEW_TYPES = new Set([
  'mainThreadWebview-qwenCode.chat',
  'qwenCode.chat',
]);

function isWebviewInput(input) {
  return !!input && typeof input === 'object' && 'viewType' in input;
}

function isDiffInput(input) {
  return !!input && typeof input === 'object' && 'modified' in input;
}

function getAllTabs() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function getChatTabs() {
  return getAllTabs().filter((tab) => {
    const input = tab.input;
    return isWebviewInput(input) && CHAT_VIEW_TYPES.has(input.viewType);
  });
}

function getQwenDiffTabs() {
  return getAllTabs().filter((tab) => {
    const input = tab.input;
    if (!isDiffInput(input)) {
      return false;
    }
    const original = input.original;
    const modified = input.modified;
    return (
      (original && original.scheme === 'qwen-diff') ||
      (modified && modified.scheme === 'qwen-diff')
    );
  });
}

async function waitFor(condition, timeoutMs = 5000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition.');
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`[integration] ${name}: OK`);
  } catch (error) {
    console.error(`[integration] ${name}: FAILED`);
    throw error;
  }
}

async function activateExtension() {
  const extension = vscode.extensions.getExtension(
    'qwenlm.qwen-code-vscode-ide-companion',
  );
  assert.ok(extension, 'Extension not found.');
  await extension.activate();
}

function getExtensionTestApi() {
  const extension = vscode.extensions.getExtension(
    'qwenlm.qwen-code-vscode-ide-companion',
  );
  return extension?.exports;
}

async function ensureChatOpen() {
  await vscode.commands.executeCommand('qwen-code.openChat');
  await waitFor(() => getChatTabs().length > 0);
}

async function testOpenChatReusesPanel() {
  await ensureChatOpen();
  const before = getChatTabs().length;

  await vscode.commands.executeCommand('qwen-code.openChat');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const after = getChatTabs().length;
  assert.strictEqual(
    after,
    before,
    'openChat should reuse the existing webview panel.',
  );
}

async function testOpenNewChatTabCreatesPanel() {
  await ensureChatOpen();
  const before = getChatTabs().length;

  await vscode.commands.executeCommand('qwenCode.openNewChatTab');
  await waitFor(() => getChatTabs().length === before + 1);
}

async function testShowDiffOpensDiffTab() {
  await ensureChatOpen();
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspace, 'Workspace folder not found.');

  const samplePath = path.join(workspace.uri.fsPath, 'sample.txt');

  await vscode.commands.executeCommand('qwenCode.showDiff', {
    path: samplePath,
    oldText: 'before',
    newText: 'after',
  });

  await waitFor(() => getQwenDiffTabs().length > 0);
}

async function testAgentLoginSuccess() {
  await ensureChatOpen();

  const api = getExtensionTestApi();
  assert.ok(
    api && typeof api.getLastWebviewProvider === 'function',
    'Extension test API not available. Set QWEN_CODE_TEST=1.',
  );

  const provider = api.getLastWebviewProvider();
  assert.ok(provider, 'No WebViewProvider available after opening chat.');

  await waitFor(
    () => {
      if (typeof provider.getAgentConnectionStateForTest !== 'function') {
        return false;
      }
      const state = provider.getAgentConnectionStateForTest();
      return (
        state &&
        state.agentInitialized &&
        state.isConnected &&
        Boolean(state.currentSessionId) &&
        state.authState === true
      );
    },
    20000,
    200,
  );
}

async function cleanupEditors() {
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } catch {
    // Best effort cleanup; ignore failures.
  }
}

async function runExtensionTests() {
  await activateExtension();

  await runTest('openChat reuses an existing webview', testOpenChatReusesPanel);
  await runTest('openNewChatTab opens a new webview', testOpenNewChatTabCreatesPanel);
  await runTest('showDiff opens a qwen-diff editor', testShowDiffOpensDiffTab);
  await runTest('agent connects and login succeeds', testAgentLoginSuccess);

  await cleanupEditors();
}

module.exports = { runExtensionTests };
