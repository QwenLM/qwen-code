#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Build first, then: node packages/browser-use/scripts/concurrent-sessions.mjs [core]
// Core cross-process regression only; lifecycle edge cases live in unit tests.
// Requires macOS/Linux, lsof and Chrome for Testing/Chromium. The existing
// managed-Chrome helper supports QWEN_BROWSER_USE_CHROME and disposable profiles.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchManagedChrome } from '../dist/scripts/managed-chrome.js';

const self = fileURLToPath(import.meta.url);
const sdkUrl = new URL('../dist/index.js', import.meta.url).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const errorInfo = ({ message, code, stack }) => ({ message, code, stack });
const marker = (text, path) => assert(text.includes('Marker ' + path), text);
async function until(read, label) {
  const deadline = Date.now() + 15000;
  do {
    const value = await read();
    if (value) return value;
    await pause(100);
  } while (Date.now() < deadline);
  assert.fail(label + ' timed out');
}

if (process.argv[2] === 'child') {
  const { setupBrowserRuntime, closeBrowserRuntime } = await import(sdkUrl);
  let browser;
  const tabs = new Map();
  const remember = async (tab, key) => {
    tabs.set(key, tab);
    return { id: tab.id, snapshot: await tab.playwright.domSnapshot() };
  };
  const commands = {
    async init({ name }) {
      browser = await (await setupBrowserRuntime()).browsers.get('chrome');
      await browser.nameSession(name);
    },
    async new({ url, key = 'main' }) {
      const tab = await browser.tabs.new();
      await tab.goto(url);
      return remember(tab, key);
    },
    snapshot: (_, tab) => tab.playwright.domSnapshot(),
    list: () => browser.tabs.list(),
    openTabs: () => browser.user.openTabs(),
    async claim({ url, key = 'borrowed' }) {
      const candidate = (await browser.user.openTabs()).find(
        (tab) => tab.url === url,
      );
      assert(candidate, 'User tab missing: ' + url);
      return remember(await browser.user.claimTab(candidate), key);
    },
    async navigate({ url }, tab) {
      if (url) await tab.goto(url);
      else
        await tab.playwright.expectNavigation(
          () => tab.playwright.getByRole('link', { name: 'Next' }).click(),
          { url: '**/next/*' },
        );
      return tab.playwright.domSnapshot();
    },
    release: (_, tab) =>
      browser.tabs.finalize({ keep: [{ tab, status: 'deliverable' }] }),
    close: () => closeBrowserRuntime(),
  };
  process.on('message', async ({ id, method, args = {} }) => {
    try {
      const result = await commands[method](args, tabs.get(args.key ?? 'main'));
      process.send({ id, result });
    } catch (error) {
      process.send({ id, error: errorInfo(error) });
    }
  });
} else {
  assert(['darwin', 'linux'].includes(process.platform), 'Unix/lsof required');
  await main();
}

async function main() {
  const artifacts = await mkdtemp('/tmp/qbu-concurrent-');
  const evidence = { artifacts, sdkUrl, clients: [], checks: [] };
  const children = [];
  const held = new Map();
  const fixture = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const send = () => {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        `<h1>Marker ${path}</h1><a href="/next/${path.split('/').at(-1)}">Next</a>`,
      );
    };
    if (path.startsWith('/slow/')) held.set(path, send);
    else send();
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const check = (name) => {
    evidence.checks.push(name);
    console.log(JSON.stringify({ check: name }));
  };
  let chrome;
  function client(name) {
    const child = fork(self, ['child'], {
      env: { ...process.env, QWEN_BROWSER_USE_SOCKET_PATH: chrome.socketPath },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    const log = { name, pid: child.pid, output: '', requests: [] };
    evidence.clients.push(log);
    child.stdout.on('data', (data) => (log.output += data));
    child.stderr.on('data', (data) => (log.output += data));
    let sequence = 0;
    const pending = new Map();
    function settle(id, result, error) {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      Object.assign(request.log, error ? { error } : { result });
      if (error) request.reject(Object.assign(new Error(error.message), error));
      else request.resolve(result);
    }
    child.on('message', ({ id, result, error }) => settle(id, result, error));
    child.once('exit', (code, signal) => {
      log.exit = { code, signal };
      for (const id of pending.keys())
        settle(id, undefined, { message: `${name} exited ${code}/${signal}` });
    });
    return {
      child,
      call(method, args = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const record = { method, args };
          log.requests.push(record);
          const timer = setTimeout(
            () =>
              settle(id, undefined, {
                message: name + '.' + method + ' timeout',
              }),
            40000,
          );
          pending.set(id, { resolve, reject, timer, log: record });
          child.send({ id, method, args });
        });
      },
      async crash() {
        child.kill('SIGKILL');
        if (!exited(child)) await once(child, 'exit');
      },
    };
  }
  try {
    chrome = await launchManagedChrome('concurrent');
    evidence.chrome = {
      root: chrome.root,
      socketPath: chrome.socketPath,
      version: chrome.chromeVersion,
    };
    const a = client('A'),
      b = client('B');
    await Promise.all([
      a.call('init', { name: 'A' }),
      b.call('init', { name: 'B' }),
    ]);
    const [ta, tb] = await Promise.all([
      a.call('new', { url: origin + '/A' }),
      b.call('new', { url: origin + '/B' }),
    ]);
    marker(ta.snapshot, '/A');
    marker(tb.snapshot, '/B');
    assert.notEqual(ta.id, tb.id);
    for (const [sdk, tab] of [
      [a, ta],
      [b, tb],
    ])
      assert.deepEqual(
        (await sdk.call('list')).map((tab) => tab.id),
        [tab.id],
      );
    const navigated = await Promise.all([
      a.call('navigate'),
      b.call('navigate'),
    ]);
    for (const [index, name] of ['A', 'B'].entries())
      marker(navigated[index], '/next/' + name);
    const open = await b.call('openTabs');
    for (const name of ['A', 'B'])
      assert.equal(
        open.find((tab) => tab.url === origin + '/next/' + name)?.tabGroup,
        name,
      );
    check('two SDK processes: isolated tabs/groups and concurrent navigation');

    const rows = execFileSync('lsof', ['-nP', '-U'], {
      encoding: 'utf8',
      maxBuffer: 10e6,
    })
      .split('\n')
      .filter((line) => line.includes(chrome.socketPath));
    const hostPids = [
      ...new Set(rows.map((line) => Number(line.trim().split(/\s+/)[1]))),
    ];
    assert.equal(hostPids.length, 1, 'Expected one socket-owning Host');
    const [hostPid] = hostPids;
    assert(!children.some((child) => child.pid === hostPid));
    evidence.socket = {
      hostPid,
      rows,
      scope: 'Socket FD ownership; LISTEN state/client count not asserted.',
    };

    await assert.rejects(b.call('claim', { url: origin + '/next/A' }), {
      code: 'TAB_OWNERSHIP_CONFLICT',
    });
    marker(await a.call('snapshot'), '/next/A');
    await a.call('release');
    marker(
      (await b.call('claim', { url: origin + '/next/A' })).snapshot,
      '/next/A',
    );
    check('claim conflicts while owned; explicit release permits transfer');

    for (const reason of ['close', 'crash']) {
      const victim = reason === 'close' ? a : client('A-crash');
      if (reason === 'crash') await victim.call('init', { name: 'A-crash' });
      const path = '/victim-' + reason;
      await victim.call('new', { url: origin + path });
      const slow = '/slow/' + reason;
      const navigation = b.call('navigate', { url: origin + slow });
      navigation.catch(() => undefined);
      await until(() => held.has(slow), 'survivor navigation started');
      if (reason === 'close') await victim.call('close');
      else await victim.crash();
      held.get(slow)();
      held.delete(slow);
      marker(await navigation, slow);
      await until(async () => {
        const tab = (await b.call('openTabs')).find(
          (tab) => tab.url === origin + path,
        );
        return reason === 'close' ? !tab : tab && !tab.tabGroup;
      }, 'victim cleanup');
      if (reason === 'crash')
        marker(
          (await b.call('claim', { url: origin + path, key: 'crashed' }))
            .snapshot,
          path,
        );
      marker(await b.call('snapshot', { key: 'borrowed' }), '/next/A');
      assert.equal(
        (await b.call('openTabs')).find((tab) => tab.url === origin + slow)
          ?.tabGroup,
        'B',
      );
      process.kill(hostPid, 0);
      check(reason + ': victim cleanup, surviving navigation and shared Host');
    }
    await b.call('close');
    process.kill(hostPid, 0);
    check('Host survives all SDK connections closing');
    evidence.status = 'PASS';
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.error = errorInfo(error);
    process.exitCode = 1;
    console.error(error.stack);
  } finally {
    for (const release of held.values()) release();
    for (const child of children) if (!exited(child)) child.kill('SIGKILL');
    await chrome?.stop();
    await new Promise((resolve) => fixture.close(resolve));
    await writeFile(
      join(artifacts, 'result.json'),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify({ status: evidence.status, artifacts }));
  }
}
