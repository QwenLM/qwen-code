/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';

const endpoint = process.env.WS || 'ws://127.0.0.1:4170/cdp';
const fixtureUrl = process.env.FIXTURE_URL || 'http://127.0.0.1:4180';
const command = process.env.QWEN_CDP_MCP_COMMAND;
if (!command) {
  console.error('Set QWEN_CDP_MCP_COMMAND to an external adapter binary.');
  process.exit(2);
}

const child = spawn(command, ['--wsEndpoint', endpoint], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
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
const call = async (name, args = {}) => {
  const result = await request('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(`${name}: ${textOf(result)}`);
  return result;
};
const waitUntil = async (read, predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return value;
};

const checks = {};
let originalUrl;
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
  originalUrl = process.env.RESTORE_URL || pages.match(/0:\s+(\S+)/)?.[1];
  checks.originalUrl = originalUrl;
  await call('navigate_page', { type: 'url', url: fixtureUrl });

  const snapshot = textOf(await call('take_snapshot'));
  const buttonUid = snapshot.match(
    /uid=([^\s]+).*button "Run fixture action"/,
  )?.[1];
  const linkUid = snapshot.match(
    /uid=([^\s]+).*link "Open fixture target"/,
  )?.[1];
  checks.snapshot = snapshot.includes('Qwen CDP Fixture');
  checks.buttonFound = Boolean(buttonUid);
  checks.linkFound = Boolean(linkUid);

  if (buttonUid) await call('click', { uid: buttonUid });
  const afterClick = await waitUntil(
    async () => textOf(await call('take_snapshot')),
    (text) => text.includes('clicked'),
  );
  const freshLinkUid = afterClick.match(
    /uid=([^\s]+).*link "Open fixture target"/,
  )?.[1];
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
      checks.restoredOriginalUrl = true;
    } catch (error) {
      checks.restoreError = error.message;
    }
  }
  child.kill('SIGTERM');
}

const passed =
  checks.toolCount >= 20 &&
  checks.snapshot &&
  checks.buttonFound &&
  checks.linkFound &&
  checks.buttonClick &&
  checks.console &&
  checks.network &&
  checks.linkNavigation &&
  checks.restoredOriginalUrl &&
  !checks.error &&
  !checks.restoreError;

console.log(JSON.stringify(checks, null, 2));
console.log(`FULL-CDP-SMOKE: ${passed ? 'PASS' : 'FAIL'}`);
process.exitCode = passed ? 0 : 1;
