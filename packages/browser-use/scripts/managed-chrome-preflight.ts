#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'node:http';
import { ChromeExtensionTransport } from '../src/bridge/index.js';
import { PlaywrightRuntime } from '../src/playwright/playwright-runtime.js';
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
} from '../src/bridge/protocol.js';
import { withManagedChrome } from './managed-chrome.js';

const fixture = await startFixture();
try {
  await withManagedChrome('preflight', async (chrome) => {
    const transport = new ChromeExtensionTransport({
      socketPath: chrome.socketPath,
    });
    const runtime = new PlaywrightRuntime({ bridge: transport });
    try {
      const ping = asRecord(await transport.request('ping', {}, 20_000));
      assert(
        ping['extensionId'] === CHROME_EXTENSION_ID &&
          ping['protocolVersion'] === CHROME_BRIDGE_PROTOCOL_VERSION,
        'Chrome extension identity did not match',
      );
      await runtime.dispatch('browsers.get', { id: 'chrome' });
      const created = asRecord(
        await runtime.dispatch('tabs.new', { browserId: 'chrome' }),
      );
      await runtime.dispatch('tab.goto', {
        tabId: created['id'],
        url: fixture.origin + '/',
      });
      const openTabs = await runtime.dispatch('browser.user.openTabs', {
        browserId: 'chrome',
      });
      assert(
        Array.isArray(openTabs) && openTabs.length === 1,
        'Tab discovery failed',
      );
      const claimed = asRecord(
        await runtime.dispatch('browser.user.claimTab', {
          browserId: 'chrome',
          tab: asRecord(openTabs[0]),
        }),
      );
      const snapshot = await runtime.dispatch('playwright.domSnapshot', {
        tabId: claimed['id'],
      });
      assert(
        typeof snapshot === 'string' && snapshot.includes('Username'),
        'Fixture DOM snapshot was not observed: ' + String(snapshot),
      );
      const usernameRef =
        typeof snapshot === 'string'
          ? /textbox "Username".*\[ref=([^\]]+)\]/.exec(snapshot)?.[1]
          : undefined;
      assert(
        usernameRef !== undefined,
        'Username ref was not present in the AI snapshot: ' + String(snapshot),
      );
      const scrollY = await runtime.dispatch('playwright.evaluate', {
        tabId: claimed['id'],
        script:
          'document.body.style.minHeight = "2400px"; scrollTo(0, 900); return window.scrollY;',
      });
      assert(
        typeof scrollY === 'number' && scrollY >= 800,
        'Fixture did not reach the screenshot scroll position',
      );
      const screenshot = asRecord(
        await runtime.dispatch('tab.screenshot', {
          tabId: claimed['id'],
          clip: { x: 0, y: 0, width: 100, height: 50 },
        }),
      );
      const screenshotBytes = Buffer.from(
        String(screenshot['base64']),
        'base64',
      );
      assert(
        screenshotBytes.subarray(1, 4).toString('ascii') === 'PNG' &&
          screenshotBytes.readUInt32BE(16) === 100 &&
          screenshotBytes.readUInt32BE(20) === 50,
        'Screenshot did not preserve the CSS-pixel clip contract',
      );
      await runtime.dispatch('playwright.evaluate', {
        tabId: claimed['id'],
        script: `
        for (const type of ['pointerdown', 'click', 'keydown', 'input']) {
          sessionStorage.removeItem('__qbu_' + type);
          document.addEventListener(type, (event) => {
            sessionStorage.setItem('__qbu_' + type, String(event.isTrusted));
          }, { capture: true });
        }
        return true;`,
      });
      await runtime.dispatch('dom_cua.click', {
        tabId: claimed['id'],
        node_id: usernameRef,
      });
      const focusedId = await runtime.dispatch('playwright.evaluate', {
        tabId: claimed['id'],
        script: 'return document.activeElement?.id;',
      });
      assert(
        focusedId === 'user-name',
        'Snapshot ref did not focus the username input',
      );
      await runtime.dispatch('locator.type', {
        tabId: claimed['id'],
        steps: [{ kind: 'locator', selector: '#user-name' }],
        value: 'qwen',
      });
      await runtime.dispatch('locator.type', {
        tabId: claimed['id'],
        steps: [{ kind: 'locator', selector: '#password' }],
        value: 'browser-use',
      });
      const trusted = asRecord(
        await runtime.dispatch('playwright.evaluate', {
          tabId: claimed['id'],
          script: `return ({
          pointer: sessionStorage.getItem('__qbu_pointerdown'),
          click: sessionStorage.getItem('__qbu_click'),
          keydown: sessionStorage.getItem('__qbu_keydown'),
          input: sessionStorage.getItem('__qbu_input'),
          username: document.querySelector('#user-name')?.value,
          password: document.querySelector('#password')?.value,
        });`,
        }),
      );
      assert(
        trusted['pointer'] === 'true' &&
          trusted['click'] === 'true' &&
          trusted['keydown'] === 'true' &&
          trusted['input'] === 'true',
        'CDP input did not produce trusted page events: ' +
          JSON.stringify(trusted),
      );
      assert(
        trusted['username'] === 'qwen' && trusted['password'] === 'browser-use',
        'CDP input did not set the requested values',
      );
      await runtime.dispatch('locator.click', {
        tabId: claimed['id'],
        steps: [{ kind: 'locator', selector: '#login-button' }],
      });
      await runtime.dispatch('playwright.waitForURL', {
        tabId: claimed['id'],
        url: fixture.origin + '/inventory.html',
      });
      const inventory = await runtime.dispatch('locator.innerText', {
        tabId: claimed['id'],
        steps: [{ kind: 'locator', selector: 'h1' }],
      });
      assert(inventory === 'Inventory', 'Fixture navigation was not observed');
      const mediaDownload = runtime.dispatch('playwright.waitForEvent', {
        tabId: claimed['id'],
        event: 'download',
        timeoutMs: 5_000,
      });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      await runtime.dispatch('locator.downloadMedia', {
        tabId: claimed['id'],
        steps: [{ kind: 'locator', selector: '#download-link' }],
        timeoutMs: 5_000,
      });
      await mediaDownload;
      const history = await runtime.dispatch('browser.user.history', {
        browserId: 'chrome',
        options: { queries: ['inventory'], limit: 10 },
      });
      assert(
        Array.isArray(history),
        'Required History permission did not return a result list',
      );
      await runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep: [{ tabId: claimed['id'], status: 'deliverable' }],
      });
      const deliveredTabs = await runtime.dispatch('browser.user.openTabs', {
        browserId: 'chrome',
      });
      assert(
        Array.isArray(deliveredTabs),
        'Deliverable tab discovery returned an invalid result',
      );
      const delivered = deliveredTabs.find(
        (tab) =>
          typeof tab === 'object' &&
          tab !== null &&
          'url' in tab &&
          tab.url === fixture.origin + '/inventory.html',
      );
      assert(delivered, 'Finalization did not leave the deliverable tab open');
      const reclaimed = asRecord(
        await runtime.dispatch('browser.user.claimTab', {
          browserId: 'chrome',
          tab: delivered,
        }),
      );
      assert(
        (await runtime.dispatch('tab.url', { tabId: reclaimed['id'] })) ===
          fixture.origin + '/inventory.html',
        'Finalized deliverable tab could not be reclaimed',
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 65_000));
      const titleAfterIdle = await runtime.dispatch('tab.title', {
        tabId: reclaimed['id'],
      });
      assert(
        titleAfterIdle === 'Inventory',
        'Browser Use did not survive 65 seconds without traffic',
      );
      await runtime.dispatch('tabs.finalize', {
        browserId: 'chrome',
        keep: [],
      });
      process.stdout.write(
        JSON.stringify({
          ok: true,
          chromeVersion: chrome.chromeVersion,
          extensionId: ping['extensionId'],
          mv3IdleKeepaliveObserved: true,
          snapshotObserved: true,
          snapshotRefActionObserved: true,
          screenshotObserved: true,
          scrolledClipObserved: true,
          trustedPointerObserved: true,
          trustedKeyboardObserved: true,
          trustedInputObserved: true,
          historyPermissionAvailable: true,
          fixtureNavigationObserved: true,
          downloadObserved: true,
          finalizationObserved: true,
        }) + '\n',
      );
    } finally {
      await runtime.stop();
    }
  });
} finally {
  await fixture.close();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}

async function startFixture(): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url === '/fixture.txt') {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.setHeader(
        'content-disposition',
        'attachment; filename="fixture.txt"',
      );
      response.end('browser-use download fixture');
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(
      request.url === '/inventory.html'
        ? [
            '<!doctype html><title>Inventory</title><h1>Inventory</h1>',
            '<a id="download-link" href="/fixture.txt" download>Download</a>',
          ].join('')
        : [
            '<!doctype html><title>Browser Use fixture</title>',
            '<form id="login">',
            '<label>Username <input id="user-name"></label>',
            '<label>Password <input id="password" type="password"></label>',
            '<button id="login-button" type="submit">Login</button>',
            '</form>',
            '<script>login.addEventListener("submit", event => {',
            'event.preventDefault(); location.href = "/inventory.html";',
            '});</script>',
          ].join(''),
    );
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Fixture did not start');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) =>
          error ? rejectPromise(error) : resolvePromise(),
        );
      }),
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
