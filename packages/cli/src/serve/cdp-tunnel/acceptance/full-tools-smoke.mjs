/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import {
  cdpEndpoint,
  parseSelectedPageUrl,
  stopChild,
} from './acceptance-helpers.mjs';

const endpoint = cdpEndpoint();
const fixtureUrl = process.env.FIXTURE_URL || 'http://127.0.0.1:4180';
const command = process.env.QWEN_CDP_MCP_COMMAND;
if (!command) {
  console.error('Set QWEN_CDP_MCP_COMMAND to an external adapter binary.');
  process.exit(2);
}

const child = spawn(command, ['--wsEndpoint', endpoint], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.on('error', () => {});
let stderr = '';
let buffer = '';
let nextId = 1;
const responses = new Map();
child.stderr.on('data', (chunk) => (stderr += chunk));
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id != null) responses.set(message.id, message);
    } catch {
      // Adapter logs may share stdout; only JSON-RPC responses matter here.
    }
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const waitFor = async (id, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timeout id=${id}; stderr=${stderr.slice(-500)}`);
};
const request = async (method, params = {}) => {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  const response = await waitFor(id);
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.result;
};
const textOf = (result) =>
  (result?.content || []).map((part) => part.text || '').join('\n');
// chrome-devtools-mcp emits each node as `- role "label" [uid=...]`, so the
// uid trails the label; find the labelled line, then pull the trailing uid.
const uidFor = (snapshotText, label) =>
  snapshotText
    .split('\n')
    .find((line) => line.includes(label))
    ?.match(/\[uid=([^\]]+)\]/)?.[1];
const call = async (name, args = {}) => {
  const result = await request('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(`${name}: ${textOf(result)}`);
  return result;
};
const waitUntil = async (read, predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  let value;
  let lastError;
  while (Date.now() < deadline) {
    try {
      value = await read();
      if (predicate(value)) return value;
    } catch (error) {
      // Transient CDP errors (page navigating, target destroyed) are expected
      // while polling; retry until the deadline instead of failing the run.
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (value === undefined) {
    throw new Error(`waitUntil: read never succeeded: ${lastError?.message}`);
  }
  if (!predicate(value)) {
    throw new Error(
      `waitUntil: timed out after ${timeoutMs}ms without matching predicate`,
    );
  }
  return value;
};
const verifyCurrentPage = async (expectedUrl) => {
  const verifier = spawn(command, ['--wsEndpoint', endpoint], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  verifier.stdin.on('error', () => {});
  let verifierBuffer = '';
  let verifierStderr = '';
  const verifierResponses = new Map();
  verifier.stderr.on('data', (chunk) => (verifierStderr += chunk));
  verifier.stdout.on('data', (chunk) => {
    verifierBuffer += chunk;
    let newline;
    while ((newline = verifierBuffer.indexOf('\n')) >= 0) {
      const line = verifierBuffer.slice(0, newline).trim();
      verifierBuffer = verifierBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id != null) verifierResponses.set(message.id, message);
      } catch {
        // Adapter logs may share stdout; only JSON-RPC responses matter here.
      }
    }
  });
  const verifierRequest = async (id, method, params = {}) => {
    verifier.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = verifierResponses.get(id);
      if (response) {
        if (response.error) throw new Error(JSON.stringify(response.error));
        return response.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `verification timeout; stderr=${verifierStderr.slice(-500)}`,
    );
  };
  try {
    await verifierRequest(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'qwen-cdp-restore-verifier', version: '1' },
    });
    verifier.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const pages = textOf(
      await verifierRequest(2, 'tools/call', {
        name: 'list_pages',
        arguments: {},
      }),
    );
    return parseSelectedPageUrl(pages) === new URL(expectedUrl).href;
  } finally {
    await stopChild(verifier);
  }
};

const checks = {};
let originalUrl;
let verifyRestoredPage = false;
try {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'qwen-cdp-full-smoke', version: '1' },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tools = await request('tools/list');
  checks.toolCount = tools.tools?.length || 0;

  const pages = textOf(await call('list_pages'));
  originalUrl = process.env.RESTORE_URL || parseSelectedPageUrl(pages);
  if (!originalUrl) {
    throw new Error('Cannot capture a restorable URL for the selected page');
  }
  checks.originalUrlCaptured = true;
  await call('navigate_page', { type: 'url', url: fixtureUrl });

  const snapshot = textOf(await call('take_snapshot'));
  const buttonUid = uidFor(snapshot, 'button "Run fixture action"');
  const linkUid = uidFor(snapshot, 'link "Open fixture target"');
  checks.snapshot = snapshot.includes('Qwen CDP Fixture');
  checks.buttonFound = Boolean(buttonUid);
  checks.linkFound = Boolean(linkUid);

  if (buttonUid) {
    try {
      await call('click', { uid: buttonUid });
      checks.clickReturned = true;
    } catch (error) {
      checks.clickError = error.message;
    }
  }
  const afterClick = await waitUntil(
    async () => textOf(await call('take_snapshot')),
    (text) => text.includes('clicked'),
  );
  const freshLinkUid = uidFor(afterClick, 'link "Open fixture target"');
  checks.linkAppeared = Boolean(freshLinkUid);
  checks.buttonClick = afterClick.includes('clicked');

  const consoleMessages = await waitUntil(
    async () => textOf(await call('list_console_messages')),
    (text) => text.includes('qwen-fixture-clicked'),
  );
  checks.console = consoleMessages.includes('qwen-fixture-clicked');
  const networkRequests = await waitUntil(
    async () => textOf(await call('list_network_requests')),
    (text) => text.includes('/api/click'),
  );
  checks.network = networkRequests.includes('/api/click');
  checks.networkExactlyOnce =
    (networkRequests.match(/\/api\/click/g) || []).length === 1;

  if (freshLinkUid) await call('click', { uid: freshLinkUid });
  const targetSnapshot = await waitUntil(
    async () => textOf(await call('take_snapshot')),
    (text) => text.includes('Target reached'),
  );
  checks.linkNavigation = targetSnapshot.includes('Target reached');
} catch (error) {
  checks.error = error.message;
} finally {
  if (originalUrl) {
    try {
      await call('navigate_page', { type: 'url', url: originalUrl });
    } catch {
      checks.restoreCommandFailed = true;
    }
    verifyRestoredPage = true;
  }
  await stopChild(child);
  if (verifyRestoredPage) {
    try {
      checks.restoredOriginalUrl = await verifyCurrentPage(originalUrl);
    } catch {
      checks.restoreVerificationFailed = true;
    }
  }
}

const passed =
  checks.toolCount >= 20 &&
  checks.snapshot &&
  checks.buttonFound &&
  checks.linkFound &&
  checks.clickReturned &&
  checks.buttonClick &&
  checks.console &&
  checks.network &&
  checks.linkAppeared &&
  checks.linkNavigation &&
  checks.networkExactlyOnce &&
  checks.restoredOriginalUrl &&
  !checks.error &&
  !checks.restoreCommandFailed &&
  !checks.restoreVerificationFailed;

console.log(JSON.stringify(checks, null, 2));
console.log(`FULL-CDP-SMOKE: ${passed ? 'PASS' : 'FAIL'}`);
process.exitCode = passed ? 0 : 1;
