/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  assertPortFree,
  stopChild,
  waitForJson,
} from './acceptance-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../../..');
const cli = resolve(repoRoot, 'packages/cli/dist/index.js');
const extension = resolve(repoRoot, 'packages/chrome-extension/dist/extension');
const fixture = resolve(here, 'fixture-server.mjs');
const extensionId = 'idkijaaipeeinemigojbjkmfmabokbdk';
const port = Number(process.env.PORT || 4170);
const fixturePort = Number(process.env.FIXTURE_PORT || 4180);
const debugPort = Number(process.env.CHROME_DEBUG_PORT || 9223);
const baseUrl = `http://127.0.0.1:${port}`;
const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
const webBridgeToken = 'webbridge-e2e-token';

await Promise.all([
  access(cli),
  access(resolve(extension, 'manifest.json')),
]).catch(() => {
  console.error('Run "npm run build" and build the Chrome extension first.');
  process.exit(2);
});

const chromeBinary = process.env.CHROME_PATH;
if (!chromeBinary) {
  console.error(
    'Set CHROME_PATH to Chrome for Testing, Chromium, or Edge (Chrome 137+ ignores --load-extension).',
  );
  process.exit(2);
}
await access(chromeBinary).catch(() => {
  console.error(`Chrome not found: ${chromeBinary}`);
  process.exit(2);
});

const children = new Set();
const spawnChild = (command, args, options = {}) => {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
};
const outputOf = (child) => {
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  return () => output;
};
const command = async (action, args, session = 'webbridge-e2e') => {
  const response = await fetch(`${baseUrl}/command`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${webBridgeToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, args, session }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${action}: ${JSON.stringify(body)}`);
  return body;
};
const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for browser result');
};
const findRef = (value, role, name) => {
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findRef(child, role, name);
      if (match) return match;
    }
  } else if (value && typeof value === 'object') {
    if (
      value.role === role &&
      (name === undefined || value.name === name) &&
      value.ref
    )
      return value.ref;
    return findRef(value.children, role, name);
  }
  return undefined;
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const cdpCall = (endpoint, method, params = {}) =>
  new Promise((resolveCall, rejectCall) => {
    const ws = new WebSocket(endpoint);
    ws.once('error', rejectCall);
    ws.once('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
      ws.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (message.id !== 1) return;
        ws.close();
        if (message.error) rejectCall(new Error(JSON.stringify(message.error)));
        else resolveCall(message.result);
      });
    });
  });

const qwenHome = await mkdtemp(resolve(tmpdir(), 'qwen-webbridge-home-'));
const chromeProfile = await mkdtemp(
  resolve(tmpdir(), 'qwen-webbridge-chrome-'),
);
const artifacts = await mkdtemp(resolve(tmpdir(), 'qwen-webbridge-artifacts-'));
await writeFile(resolve(qwenHome, 'settings.json'), '{}\n');
const uploadPath = resolve(artifacts, 'upload.txt');
await writeFile(uploadPath, 'webbridge upload');
let daemon;
let fixtureServer;
let chromeProcess;
let daemonOutput = () => '';
let chromeOutput = () => '';
try {
  await assertPortFree(port);
  await assertPortFree(fixturePort);
  await assertPortFree(debugPort);

  fixtureServer = spawnChild(process.execPath, [fixture], {
    env: { ...process.env, FIXTURE_PORT: String(fixturePort) },
  });
  await waitForJson(
    `${fixtureUrl}/health`,
    (value) => value.status === 'ok',
    10_000,
  );

  daemon = spawnChild(
    process.execPath,
    [
      cli,
      'serve',
      '--port',
      String(port),
      '--allow-origin',
      `chrome-extension://${extensionId}`,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        QWEN_HOME: qwenHome,
        QWEN_WEBBRIDGE_TOKEN: webBridgeToken,
      },
    },
  );
  daemonOutput = outputOf(daemon);
  await waitForJson(`${baseUrl}/health`, (value) => value.status === 'ok');

  const chromeArgs = [
    `--user-data-dir=${chromeProfile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--ip-address-space-overrides=127.0.0.1=public',
    '--enable-logging=stderr',
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ];
  chromeProcess = spawnChild(chromeBinary, chromeArgs);
  chromeOutput = outputOf(chromeProcess);
  let browser = await waitForJson(
    `http://127.0.0.1:${debugPort}/json/version`,
    (value) => typeof value.webSocketDebuggerUrl === 'string',
  );
  if (port !== 4170) {
    const configUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const { targetId } = await cdpCall(
      browser.webSocketDebuggerUrl,
      'Target.createTarget',
      { url: configUrl },
    );
    const targets = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/list`,
      (value) =>
        Array.isArray(value) &&
        value.some(
          (target) =>
            target.id === targetId &&
            target.url === configUrl &&
            typeof target.webSocketDebuggerUrl === 'string',
        ),
    );
    const configPage = targets.find((target) => target.id === targetId);
    await waitFor(async () => {
      const ready = await cdpCall(
        configPage.webSocketDebuggerUrl,
        'Runtime.evaluate',
        {
          expression: 'Boolean(globalThis.chrome?.storage?.local)',
          returnByValue: true,
        },
      ).catch(() => undefined);
      return ready?.result?.value === true;
    });
    const configured = await cdpCall(
      configPage.webSocketDebuggerUrl,
      'Runtime.evaluate',
      {
        expression: `chrome.storage.local.set({'qwen.daemon':{baseUrl:${JSON.stringify(baseUrl)}}}).then(() => chrome.storage.local.get('qwen.daemon'))`,
        awaitPromise: true,
        returnByValue: true,
      },
    );
    assert(
      configured.result?.value?.['qwen.daemon']?.baseUrl === baseUrl,
      `failed to configure extension daemon URL: ${JSON.stringify(configured)}`,
    );
    await cdpCall(browser.webSocketDebuggerUrl, 'Target.closeTarget', {
      targetId,
    });
    await stopChild(chromeProcess);
    chromeProcess = spawnChild(chromeBinary, chromeArgs);
    chromeOutput = outputOf(chromeProcess);
    browser = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/version`,
      (value) => typeof value.webSocketDebuggerUrl === 'string',
    );
  }
  for (const name of [
    'local-network-access',
    'local-network',
    'loopback-network',
  ]) {
    await cdpCall(browser.webSocketDebuggerUrl, 'Browser.setPermission', {
      permission: { name },
      setting: 'granted',
    }).catch(() => {});
  }
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/status`, {
      headers: { authorization: `Bearer ${webBridgeToken}` },
    });
    return response.ok && (await response.json()).extension_connected === true;
  }, 30_000).catch(async (error) => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      .then((response) => response.json())
      .catch((targetError) => ({ error: String(targetError) }));
    const relevantChromeOutput = chromeOutput()
      .split('\n')
      .filter((line) =>
        /ServiceWorker|CONSOLE|ERROR|WebSocket|DevTools|remote debugging|local network|idkijaaipeeinemigojbjkmfmabokbdk/i.test(
          line,
        ),
      )
      .join('\n');
    throw new Error(
      `${error.message}\nDaemon:\n${daemonOutput()}\nChrome targets:\n${JSON.stringify(targets, null, 2)}\nChrome diagnostics:\n${relevantChromeOutput}`,
    );
  });

  const opened = await command('navigate', {
    url: fixtureUrl,
    newTab: true,
    group_title: 'WebBridge E2E',
  });
  assert(typeof opened.tabId === 'number', 'navigate returned no tabId');
  const tabs = await command('list_tabs', {});
  assert(tabs.tabs.length === 1, 'list_tabs did not return the opened tab');
  await command('navigate', { url: `${fixtureUrl}/target`, newTab: true });
  const found = await command('find_tab', { url: fixtureUrl });
  assert(
    found.tabId === opened.tabId,
    'find_tab selected the wrong same-host tab',
  );
  const reusedUrl = `${fixtureUrl}/?generation=2`;
  const reused = await command('navigate', { url: reusedUrl });
  assert(
    reused.tabId === opened.tabId && reused.url === reusedUrl,
    'navigate did not wait for the reused tab to load',
  );
  const reloaded = await command('navigate', { url: reusedUrl });
  assert(
    reloaded.tabId === opened.tabId && reloaded.url === reusedUrl,
    'navigate did not wait for the same-URL reload',
  );

  const firstSnapshot = await command('snapshot', {});
  const buttonRef = findRef(firstSnapshot.tree, 'button', 'Run fixture action');
  assert(buttonRef, 'snapshot returned no button ref');

  await command('network', { cmd: 'start' });
  await command('click', { selector: buttonRef });
  await waitFor(async () => {
    const result = await command('evaluate', {
      code: "document.querySelector('#status').textContent",
    });
    return result.value === 'clicked';
  });
  const requests = await command('network', {
    cmd: 'list',
    filter: '/api/click',
  });
  assert(requests.count === 1, 'network did not capture the click request');
  const detail = await command('network', {
    cmd: 'detail',
    requestId: requests.requests[0].requestId,
  });
  assert(detail.body === 'clicked', 'network detail returned the wrong body');
  await command('network', { cmd: 'stop' });

  await command('evaluate', {
    code: "document.body.insertAdjacentHTML('beforeend','<input id=agent-input><textarea id=agent-notes></textarea><input id=file-input type=file>')",
  });
  const secondSnapshot = await command('snapshot', {});
  const inputRef = findRef(secondSnapshot.tree, 'textbox');
  assert(inputRef, 'snapshot returned no textbox ref');
  await command('fill', { selector: inputRef, value: 'filled' });
  await command('fill', { selector: '#agent-notes', value: 'notes' });
  await command('evaluate', {
    code: "document.querySelector('#agent-input').focus()",
  });
  const sentKeys = await command('send_keys', { keys: 'Mod+A' });
  await command('key_type', { text: 'typed' });
  const inputValue = await command('evaluate', {
    code: "await Promise.resolve({input: document.querySelector('#agent-input').value, notes: document.querySelector('#agent-notes').value})",
  });
  assert(
    inputValue.value.input === 'typed' && inputValue.value.notes === 'notes',
    `keyboard input did not update the field: ${JSON.stringify({ sentKeys, inputValue })}`,
  );

  await command('evaluate', {
    code: "document.querySelector('#status').textContent = 'idle'",
  });
  await command('mouse_click', { selector: '#action' });
  await waitFor(async () => {
    const result = await command('evaluate', {
      code: "document.querySelector('#status').textContent",
    });
    return result.value === 'clicked';
  });
  const cdp = await command('cdp', {
    method: 'Runtime.evaluate',
    params: { expression: 'document.title', returnByValue: true },
  });
  assert(
    cdp.result.value === 'Qwen CDP Fixture',
    'raw CDP returned wrong title',
  );
  await command('upload', {
    selector: '#file-input',
    files: [uploadPath],
  });
  const uploaded = await command('evaluate', {
    code: "document.querySelector('#file-input').files[0]?.name",
  });
  assert(uploaded.value === 'upload.txt', 'upload did not set the FileList');

  const imagePath = resolve(artifacts, 'page.png');
  const pdfPath = resolve(artifacts, 'page.pdf');
  const image = await command('screenshot', { path: imagePath });
  const pdf = await command('save_as_pdf', { path: pdfPath });
  assert(image.path !== imagePath && image.sizeBytes > 0, 'screenshot failed');
  assert(pdf.path !== pdfPath && pdf.sizeBytes > 0, 'PDF failed');
  await Promise.all([access(image.path), access(pdf.path)]);

  const closedTab = await command('close_tab', {});
  assert(closedTab.closed === true, 'close_tab did not close the current tab');
  const closedSession = await command('close_session', {});
  assert(
    closedSession.closed === 1,
    'close_session did not close the first tab',
  );
  console.log('QWEN-WEBBRIDGE-17-ACTIONS: PASS');
  console.log('QWEN-WEBBRIDGE-REAL-CHROME: PASS');
} finally {
  await stopChild(chromeProcess);
  await stopChild(daemon);
  await stopChild(fixtureServer);
  for (const child of children) await stopChild(child);
  await rm(qwenHome, { recursive: true, force: true });
  await rm(chromeProfile, { recursive: true, force: true });
  await rm(artifacts, { recursive: true, force: true });
}
