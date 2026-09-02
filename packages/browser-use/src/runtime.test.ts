/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test } from 'vitest';

import type { BridgeEvent } from './bridge/index.js';

import { BrowserRuntimeError, ChromeRuntime } from './core/index.js';
import { urlMatches } from './core/chrome-runtime.js';
import { modifierName } from './core/input.js';
import { FakeBridge } from './core/fake-chrome-bridge.test-helper.js';

test('portable keyboard shortcuts resolve to Command on macOS and Control elsewhere', () => {
  assert.equal(modifierName('ControlOrMeta', 'darwin'), 'Meta');
  assert.equal(modifierName('ControlOrMeta', 'linux'), 'Control');
  assert.equal(modifierName('ControlOrMeta', 'win32'), 'Control');
  assert.equal(modifierName('Control', 'darwin'), 'Control');
  assert.equal(modifierName('Meta', 'linux'), 'Meta');
});

test('session names are forwarded to the extension for agent-owned tab groups', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());

  await runtime.dispatch('browser.nameSession', {
    browserId: 'user-chrome',
    name: 'Research run',
  });
  assert.deepEqual(
    bridge.calls.find((call) => call.method === 'session.name'),
    {
      method: 'session.name',
      params: { name: 'Research run' },
    },
  );
  assert.equal(
    (
      (await runtime.dispatch('browsers.get', { id: 'user-chrome' })) as {
        name: string;
      }
    ).name,
    'User Chrome · Research run',
  );
});

async function claimedTab(runtime: ChromeRuntime): Promise<string> {
  const [candidate] = (await runtime.dispatch('browser.user.openTabs', {
    browserId: 'user-chrome',
  })) as Array<Record<string, unknown>>;
  const tab = (await runtime.dispatch('browser.user.claimTab', {
    browserId: 'user-chrome',
    tab: candidate,
  })) as { id: string };
  return tab.id;
}

function cdpCalls(
  bridge: FakeBridge,
  method: string,
): Array<Record<string, unknown>> {
  return bridge.calls
    .filter(
      (call) => call.method === 'cdp.send' && call.params.method === method,
    )
    .map((call) => call.params.params as Record<string, unknown>);
}

test('Chrome runtime discovers open user tabs and claims an exact snapshot', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());

  assert.deepEqual(await runtime.dispatch('browsers.list', {}), [
    {
      id: 'user-chrome',
      name: 'User Chrome',
      type: 'extension',
      family: 'chrome',
    },
  ]);
  const open = await runtime.dispatch('browser.user.openTabs', {
    browserId: 'user-chrome',
  });
  assert.ok(Array.isArray(open));
  const candidate = open[0] as { id: string; title: string; url: string };
  assert.equal('providerTabId' in candidate, false);
  assert.equal(candidate.title, 'Inbox');

  const claimed = (await runtime.dispatch('browser.user.claimTab', {
    browserId: 'user-chrome',
    tab: candidate,
  })) as { id: string; url: string };
  assert.match(claimed.id, /^tab-/);
  assert.equal(claimed.url, 'https://mail.example/inbox');
  assert.ok(
    bridge.calls.some(
      (call) => call.method === 'tabs.attach' && call.params.tabId === 41,
    ),
  );
});

test('Chrome runtime fails closed when a discovered tab changes', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const open = (await runtime.dispatch('browser.user.openTabs', {
    browserId: 'user-chrome',
  })) as Array<Record<string, unknown>>;
  bridge.current = { ...bridge.current, url: 'https://mail.example/compose' };

  await assert.rejects(
    runtime.dispatch('browser.user.claimTab', {
      browserId: 'user-chrome',
      tab: open[0],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'STALE_TAB',
  );
  assert.equal(
    bridge.calls.some((call) => call.method === 'tabs.attach'),
    false,
  );
});

test('browser history validates filters before querying Chrome', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());

  assert.deepEqual(
    await runtime.dispatch('browser.user.history', {
      browserId: 'user-chrome',
      options: {
        queries: ['invoice'],
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: '2026-08-24T00:00:00.000Z',
        limit: 20,
      },
    }),
    bridge.historyEntries,
  );
  assert.deepEqual(
    bridge.calls.find((call) => call.method === 'history.query'),
    {
      method: 'history.query',
      params: {
        queries: ['invoice'],
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-24T00:00:00.000Z',
        limit: 20,
      },
    },
  );

  for (const options of [
    { queries: [] },
    { queries: [' '] },
    { from: 'not-a-date' },
    { from: Number.POSITIVE_INFINITY },
    { from: 1e100 },
  ]) {
    await assert.rejects(
      runtime.dispatch('browser.user.history', {
        browserId: 'user-chrome',
        options,
      }),
      (error: unknown) =>
        error instanceof BrowserRuntimeError &&
        error.code === 'INVALID_ARGUMENT',
    );
  }
  assert.equal(
    bridge.calls.filter((call) => call.method === 'history.query').length,
    1,
  );
});

test('semantic SDK commands remain backend primitives over the Chrome bridge', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  await runtime.dispatch('tab.goto', {
    tabId,
    url: 'https://mail.example/archive',
    waitUntil: 'load',
  });
  assert.equal(
    await runtime.dispatch('tab.url', { tabId }),
    'https://mail.example/archive',
  );
  assert.equal(
    await runtime.dispatch('playwright.domSnapshot', { tabId }),
    '- heading "Inbox"',
  );
  assert.equal(
    await runtime.dispatch('locator.count', {
      tabId,
      steps: [{ kind: 'getByRole', role: 'button', name: 'Archive' }],
    }),
    3,
  );
  await runtime.dispatch('locator.click', {
    tabId,
    steps: [{ kind: 'getByRole', role: 'button', name: 'Archive' }],
  });

  const calls = bridge.calls.filter((call) => call.method === 'cdp.send');
  assert.ok(calls.some((call) => call.params.method === 'Page.navigate'));
  assert.ok(calls.some((call) => call.params.method === 'Runtime.evaluate'));
  assert.equal(
    calls.some((call) => 'providerTabId' in call.params),
    false,
  );
});

test('versioned snapshots guard document-scoped refs without changing the legacy snapshot result', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  assert.equal(
    await runtime.executePrimitive('snapshot.capture', { tabId }),
    '- heading "Inbox"',
  );
  const first = await runtime.executePrimitive('snapshot.captureWithMetadata', {
    tabId,
  });
  assert.equal(first.text, '- heading "Inbox"');
  assert.match(first.documentId, /^document-/);

  bridge.emit('Page.navigatedWithinDocument', {
    frameId: 'main',
    url: 'https://mail.example/inbox#today',
  });
  const sameDocument = await runtime.executePrimitive(
    'snapshot.captureWithMetadata',
    { tabId },
  );
  assert.equal(sameDocument.documentId, first.documentId);

  bridge.emit('Page.frameNavigated', {
    frame: { id: 'child', parentId: 'main', url: 'https://mail.example/frame' },
  });
  const next = await runtime.executePrimitive('snapshot.captureWithMetadata', {
    tabId,
  });
  assert.notEqual(next.documentId, first.documentId);

  await assert.rejects(
    runtime.executePrimitive('element.clickByRef', {
      tabId,
      ref: 'n3',
      expectedDocumentId: first.documentId,
    }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRuntimeError);
      assert.equal(error.code, 'INVALID_LOCATOR');
      assert.match(error.message, /document is stale/);
      return true;
    },
  );
  await assert.rejects(
    runtime.executePrimitive('element.fill', {
      tabId,
      steps: [{ kind: 'ref', ref: 'n3' }],
      value: 'stale value',
      expectedDocumentId: first.documentId,
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_LOCATOR',
  );

  await runtime.executePrimitive('element.clickByRef', {
    tabId,
    ref: 'n3',
    expectedDocumentId: next.documentId,
  });
  const guardedResolver = [...cdpCalls(bridge, 'Runtime.evaluate')]
    .reverse()
    .find((params) => params.returnByValue === false);
  assert.match(
    String(guardedResolver?.expression),
    new RegExp(next.documentId),
  );
});

test('commit navigation returns after the new document identity is observable', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const before = await runtime.executePrimitive(
    'snapshot.captureWithMetadata',
    { tabId },
  );

  bridge.navigationEventDelayMs = 20;
  await runtime.dispatch('tab.goto', {
    tabId,
    url: 'https://mail.example/archive',
    waitUntil: 'commit',
    timeoutMs: 1_000,
  });

  const after = await runtime.executePrimitive('snapshot.captureWithMetadata', {
    tabId,
  });
  assert.notEqual(after.documentId, before.documentId);
});

test('recursive frame snapshots keep the expected document guard', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const snapshot = await runtime.executePrimitive(
    'snapshot.captureWithMetadata',
    { tabId },
  );

  bridge.emit('Runtime.executionContextCreated', {
    context: { id: 7, auxData: { frameId: 'F-same', isDefault: true } },
  });
  bridge.domSnapshotText = '- iframe "Checkout" [n5] <<frame:n5>>';
  await runtime.executePrimitive('snapshot.captureByRef', {
    tabId,
    rootRef: 'n1',
    expectedDocumentId: snapshot.documentId,
  });

  const frameResolver = cdpCalls(bridge, 'Runtime.evaluate').find(
    (params) =>
      params.returnByValue === false &&
      String(params.expression).includes('"ref":"n5"'),
  );
  assert.match(
    String(frameResolver?.expression),
    new RegExp(snapshot.documentId),
  );
});

test('versioned snapshots fail when the document graph changes during capture', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  bridge.onDomSnapshot = () => {
    bridge.emit('Page.frameNavigated', {
      frame: { id: 'main', url: 'https://mail.example/next' },
    });
  };

  await assert.rejects(
    runtime.executePrimitive('snapshot.captureWithMetadata', { tabId }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_LOCATOR',
  );
});

test('evaluate executes page, locator and locator-all scripts in the claimed tab', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  assert.equal(
    await runtime.dispatch('playwright.evaluate', {
      tabId,
      script: 'return 6 * 7;',
      timeoutMs: 1_234,
    }),
    42,
  );
  assert.equal(
    await runtime.dispatch('locator.evaluate', {
      tabId,
      steps: [{ kind: 'locator', selector: '#submit' }],
      script: 'return element.id;',
    }),
    'submit',
  );
  assert.equal(
    await runtime.dispatch('locator.evaluateAll', {
      tabId,
      steps: [{ kind: 'locator', selector: '.item' }],
      script: 'return elements.length;',
    }),
    3,
  );

  const evaluations = cdpCalls(bridge, 'Runtime.evaluate').slice(-3);
  assert.match(
    String(evaluations[0]?.expression),
    /^\(async \(\) => \{\nreturn 6 \* 7;/,
  );
  assert.equal(evaluations[0]?.timeout, 1_234);
  assert.match(String(evaluations[1]?.expression), /"operation":"resolve"/);
  assert.match(String(evaluations[1]?.expression), /const element = await/);
  assert.match(String(evaluations[2]?.expression), /"operation":"resolveAll"/);
  assert.match(String(evaluations[2]?.expression), /const elements = await/);

  await assert.rejects(
    runtime.dispatch('playwright.evaluate', { tabId, script: '' }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_ARGUMENT',
  );
});

test('goto tolerates URL normalisation and redirects instead of waiting for an exact address', async () => {
  const bridge = new FakeBridge();
  bridge.redirects['https://mail.example/old'] =
    'https://mail.example/new?from=old';
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  const started = Date.now();
  await runtime.dispatch('tab.goto', {
    tabId,
    url: 'https://mail.example',
    timeoutMs: 2_000,
  });
  assert.equal(
    await runtime.dispatch('tab.url', { tabId }),
    'https://mail.example/',
  );
  await runtime.dispatch('tab.goto', {
    tabId,
    url: 'https://mail.example/old',
    timeoutMs: 2_000,
  });
  assert.equal(
    await runtime.dispatch('tab.url', { tabId }),
    'https://mail.example/new?from=old',
  );
  assert.ok(
    Date.now() - started < 1_500,
    'goto must not wait for the URL to match literally',
  );
});

test('waitForURL compares normalised addresses and supports globs', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  await runtime.dispatch('tab.goto', {
    tabId,
    url: 'https://mail.example/inbox/',
    timeoutMs: 2_000,
  });

  await runtime.dispatch('playwright.waitForURL', {
    tabId,
    url: 'https://mail.example/inbox/',
    timeoutMs: 1_000,
  });
  await runtime.dispatch('playwright.waitForURL', {
    tabId,
    url: 'https://mail.example/inbox',
    timeoutMs: 1_000,
  });
  await runtime.dispatch('playwright.waitForURL', {
    tabId,
    url: '*inbox*',
    timeoutMs: 1_000,
  });
  await runtime.dispatch('playwright.waitForURL', {
    tabId,
    url: 'https://mail.example/*',
    timeoutMs: 1_000,
  });
  await assert.rejects(
    runtime.dispatch('playwright.waitForURL', {
      tabId,
      url: 'https://mail.example/outbox',
      timeoutMs: 300,
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'OPERATION_TIMEOUT' &&
      /current URL is https:\/\/mail\.example\/inbox\//.test(error.message),
  );

  assert.equal(urlMatches('https://a.example/', 'https://a.example'), true);
  assert.equal(
    urlMatches('https://a.example/x/y?z=1', 'https://a.example/x/*'),
    true,
  );
  assert.equal(urlMatches('https://a.example/x', 'https://b.example/x'), false);
});

test('locator.press focuses the element in the page and then sends real key events', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const steps = [{ kind: 'getByLabel', text: 'Search' }];

  await runtime.dispatch('locator.press', { tabId, steps, value: 'Control+a' });
  assert.ok(
    cdpCalls(bridge, 'Runtime.evaluate').some((params) =>
      String(params.expression).includes('"operation":"focus"'),
    ),
  );
  const keys = cdpCalls(bridge, 'Input.dispatchKeyEvent').map(
    (params) =>
      `${params.type}:${params.key}:${params.modifiers}:${params.text ?? ''}`,
  );
  assert.deepEqual(keys, [
    'rawKeyDown:Control:2:',
    'rawKeyDown:a:2:',
    'keyUp:a:2:',
    'keyUp:Control:0:',
  ]);

  bridge.calls.length = 0;
  await runtime.dispatch('locator.press', { tabId, steps, value: 'Enter' });
  const enter = cdpCalls(bridge, 'Input.dispatchKeyEvent');
  assert.equal(enter[0]?.type, 'keyDown');
  assert.equal(enter[0]?.text, '\r');
  assert.equal(enter[1]?.type, 'keyUp');

  await assert.rejects(
    runtime.dispatch('locator.press', { tabId, steps, value: 'NotAKey' }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_ARGUMENT',
  );
});

test('locator.type sends one real key event pair per character', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  await runtime.dispatch('locator.type', {
    tabId,
    steps: [{ kind: 'locator', selector: '#q' }],
    value: 'a1 中',
  });
  const keys = cdpCalls(bridge, 'Input.dispatchKeyEvent').map(
    (params) => `${params.type}:${params.text ?? ''}`,
  );
  assert.deepEqual(keys, [
    'keyDown:a',
    'keyUp:',
    'keyDown:1',
    'keyUp:',
    'keyDown: ',
    'keyUp:',
  ]);
  assert.deepEqual(cdpCalls(bridge, 'Input.insertText'), [{ text: '中' }]);
});

test('locator.scroll observes nested scroll state and falls back only when wheel input has no effect', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const steps = [{ kind: 'locator', selector: '#scroller' }];

  bridge.wheelScrolls = false;
  await runtime.dispatch('locator.scroll', {
    tabId,
    steps,
    scrollX: 0,
    scrollY: 240,
  });
  assert.equal(bridge.scrollTop, 240);
  assert.equal(bridge.scrollFallbackCalls, 1);

  bridge.scrollTop = 0;
  bridge.wheelScrolls = true;
  await runtime.dispatch('locator.scroll', {
    tabId,
    steps,
    scrollX: 0,
    scrollY: 240,
  });
  assert.equal(bridge.scrollTop, 240);
  assert.equal(
    bridge.scrollFallbackCalls,
    1,
    'a successful wheel must not be followed by a programmatic scroll',
  );
});

test('keyboard actions fail before dispatch when the target is not focused or editable', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const steps = [{ kind: 'locator', selector: '#target' }];

  bridge.calls.length = 0;
  bridge.focusResult = { focused: false, ref: 'n1', editable: true };
  await assert.rejects(
    runtime.dispatch('locator.press', { tabId, steps, value: 'Enter' }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'OPERATION_FAILED' &&
      /could not be focused/.test(error.message),
  );
  assert.equal(cdpCalls(bridge, 'Input.dispatchKeyEvent').length, 0);

  bridge.calls.length = 0;
  bridge.focusResult = { focused: true, ref: 'n1', editable: false };
  await assert.rejects(
    runtime.dispatch('locator.type', { tabId, steps, value: 'wrong target' }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'INVALID_LOCATOR' &&
      /editable/.test(error.message),
  );
  assert.equal(cdpCalls(bridge, 'Input.dispatchKeyEvent').length, 0);
  assert.equal(cdpCalls(bridge, 'Input.insertText').length, 0);
});

test('screenshots are captured in CSS pixels and report the viewport contract', async () => {
  const bridge = new FakeBridge();
  bridge.devicePixelRatio = 2;
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  const shot = (await runtime.dispatch('tab.screenshot', { tabId })) as Record<
    string,
    unknown
  >;
  assert.equal(shot.kind, 'image');
  assert.equal(shot.coordinateSpace, 'css-pixels');
  assert.equal(shot.devicePixelRatio, 2);
  assert.deepEqual(shot.viewport, { width: 1_280, height: 800 });
  assert.equal(shot.width, 1);
  assert.equal(shot.height, 1);
  const [capture] = cdpCalls(bridge, 'Page.captureScreenshot');
  assert.deepEqual(capture?.clip, {
    x: 0,
    y: 0,
    width: 1_280,
    height: 800,
    scale: 0.5,
  });
  assert.equal(capture?.captureBeyondViewport, false);

  await runtime.dispatch('tab.screenshot', {
    tabId,
    clip: { x: 10, y: 20, width: 100, height: 50 },
  });
  const [, clipped] = cdpCalls(bridge, 'Page.captureScreenshot');
  assert.deepEqual(clipped?.clip, {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    scale: 0.5,
  });

  await runtime.dispatch('tab.screenshot', { tabId, fullPage: true });
  const [, , full] = cdpCalls(bridge, 'Page.captureScreenshot');
  assert.deepEqual(full?.clip, {
    x: 0,
    y: 0,
    width: 1_280,
    height: 1_600,
    scale: 0.5,
  });
  assert.equal(full?.captureBeyondViewport, true);
});

test('smoke: oversized full-page screenshots fail before Chrome encodes image data', async () => {
  const bridge = new FakeBridge();
  bridge.contentSize = { width: 1_920, height: 10_000 };
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  bridge.calls.length = 0;
  await assert.rejects(
    runtime.dispatch('tab.screenshot', { tabId, fullPage: true }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'INVALID_ARGUMENT' &&
      /capture budget/.test(error.message),
  );
  assert.equal(cdpCalls(bridge, 'Page.captureScreenshot').length, 0);
});

test('tabs.list auto-claims only popup tabs derived from a claimed opener', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const parentId = await claimedTab(runtime);
  bridge.extraOpenTabs.push(
    {
      providerTabId: 42,
      derivedFromProviderTabId: 41,
      title: 'OAuth popup',
      url: 'https://auth.example/',
      active: true,
      windowId: 2,
    },
    {
      providerTabId: 43,
      title: 'Unrelated user tab',
      url: 'https://unrelated.example/',
      active: false,
      windowId: 2,
    },
  );

  const listed = (await runtime.dispatch('tabs.list', {
    browserId: 'user-chrome',
  })) as Array<{ id: string; title: string }>;
  assert.equal(listed.length, 2);
  assert.ok(listed.some((tab) => tab.id === parentId));
  assert.ok(listed.some((tab) => tab.title === 'OAuth popup'));
  assert.ok(!listed.some((tab) => tab.title === 'Unrelated user tab'));
  assert.ok(
    bridge.calls.some(
      (call) =>
        call.method === 'cdp.send' &&
        call.params.tabId === 42 &&
        call.params.method === 'Target.setAutoAttach',
    ),
  );
});

test('tabs.list drops a claimed tab that has moved to an unsupported URL', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  await claimedTab(runtime);
  bridge.unsupportedTabIds.add(41);

  assert.deepEqual(
    await runtime.dispatch('tabs.list', { browserId: 'user-chrome' }),
    [],
  );
});

test('optional origin policy constrains explicit navigation', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({
    bridge,
    allowedOrigins: ['https://mail.example'],
  });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  await assert.rejects(
    runtime.dispatch('tab.goto', { tabId, url: 'https://evil.example/' }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'NAVIGATION_BLOCKED',
  );
  assert.equal(
    bridge.calls.some(
      (call) =>
        call.method === 'cdp.send' && call.params.method === 'Page.navigate',
    ),
    false,
  );
});

test('optional origin policy blocks content access after an indirect navigation', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({
    bridge,
    allowedOrigins: ['https://mail.example'],
  });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  bridge.onEvaluation = () => {
    bridge.current = {
      ...bridge.current,
      url: 'https://outside.example/private',
    };
    bridge.onEvaluation = undefined;
  };

  await assert.rejects(
    runtime.dispatch('playwright.evaluate', {
      tabId,
      script: 'location.href = "https://outside.example/private"; return null;',
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'NAVIGATION_BLOCKED',
  );
  await assert.rejects(
    runtime.dispatch('tab.title', { tabId }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'NAVIGATION_BLOCKED',
  );

  await runtime.dispatch('tab.goto', {
    tabId,
    url: 'https://mail.example/recovered',
  });
  assert.equal(
    await runtime.dispatch('tab.url', { tabId }),
    'https://mail.example/recovered',
  );

  bridge.current = {
    ...bridge.current,
    url: 'https://outside.example/private',
  };
  await runtime.dispatch('tab.close', { tabId });
  assert.ok(bridge.calls.some((call) => call.method === 'tabs.close'));
});

test('browser discovery returns empty when the extension is disconnected', async () => {
  const bridge = new FakeBridge();
  bridge.connected = false;
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  assert.deepEqual(await runtime.dispatch('browsers.list', {}), []);
});

test('locator.click resolves an element handle and sends real mouse events at its centre', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const steps = [{ kind: 'getByRole', role: 'button', name: 'Archive' }];

  await runtime.dispatch('locator.click', { tabId, steps });
  assert.ok(
    cdpCalls(bridge, 'Runtime.evaluate').some(
      (params) =>
        params.returnByValue === false &&
        String(params.expression).includes('"operation":"resolve"'),
    ),
  );
  assert.equal(cdpCalls(bridge, 'DOM.scrollIntoViewIfNeeded').length, 1);
  const mouse = cdpCalls(bridge, 'Input.dispatchMouseEvent').map(
    (params) =>
      `${params.type}:${params.x},${params.y}:${params.button ?? '-'}:${params.clickCount ?? '-'}:${params.modifiers}`,
  );
  assert.deepEqual(mouse, [
    'mouseMoved:60,40:-:-:0',
    'mousePressed:60,40:left:1:0',
    'mouseReleased:60,40:left:1:0',
  ]);
  assert.equal(cdpCalls(bridge, 'Runtime.releaseObject').length, 1);

  bridge.calls.length = 0;
  await runtime.dispatch('locator.dblclick', {
    tabId,
    steps,
    button: 'right',
    modifiers: ['Shift'],
  });
  const double = cdpCalls(bridge, 'Input.dispatchMouseEvent').map(
    (params) =>
      `${params.type}:${params.button ?? '-'}:${params.clickCount ?? '-'}:${params.modifiers}`,
  );
  assert.deepEqual(double, [
    'mouseMoved:-:-:8',
    'mousePressed:right:1:8',
    'mouseReleased:right:1:8',
    'mousePressed:right:2:8',
    'mouseReleased:right:2:8',
  ]);

  bridge.calls.length = 0;
  await runtime.dispatch('locator.hover', { tabId, steps });
  assert.deepEqual(
    cdpCalls(bridge, 'Input.dispatchMouseEvent').map((params) => params.type),
    ['mouseMoved'],
  );
});

test('DOM CUA commands lower snapshot refs to locator primitives', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  assert.equal(
    await runtime.dispatch('dom_cua.get_visible_dom', { tabId }),
    '- heading "Inbox"',
  );
  bridge.calls.length = 0;
  await runtime.dispatch('dom_cua.click', { tabId, nodeId: 'n3' });

  const resolver = cdpCalls(bridge, 'Runtime.evaluate').find(
    (params) => params.returnByValue === false,
  );
  assert.match(String(resolver?.expression), /"kind":"ref","ref":"n3"/);
  assert.equal(
    cdpCalls(bridge, 'Input.dispatchMouseEvent').filter(
      (params) => params.type === 'mousePressed',
    ).length,
    1,
  );
});

test('a covered element is reported instead of clicked, unless force is set', async () => {
  const bridge = new FakeBridge();
  bridge.hitTarget = 'div#overlay';
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const steps = [{ kind: 'locator', selector: '#covered' }];

  await assert.rejects(
    runtime.dispatch('locator.click', { tabId, steps, timeoutMs: 300 }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserRuntimeError);
      assert.equal(error.code, 'OPERATION_TIMEOUT');
      assert.match(error.message, /covered by div#overlay/);
      assert.deepEqual(error.details, {
        kind: 'intercepted',
        action: 'click',
        matchCount: 1,
        visibleCount: 1,
        blocker: 'div#overlay',
      });
      return true;
    },
  );
  assert.equal(cdpCalls(bridge, 'Input.dispatchMouseEvent').length, 0);

  await runtime.dispatch('locator.click', { tabId, steps, force: true });
  assert.equal(
    cdpCalls(bridge, 'Input.dispatchMouseEvent').filter(
      (params) => params.type === 'mousePressed',
    ).length,
    1,
  );
});

test('check toggles through a real click only when the state differs', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const steps = [{ kind: 'locator', selector: '#agree' }];

  await runtime.dispatch('locator.check', { tabId, steps });
  assert.equal(bridge.checked, true);
  assert.equal(
    cdpCalls(bridge, 'Input.dispatchMouseEvent').filter(
      (params) => params.type === 'mousePressed',
    ).length,
    1,
  );
  await runtime.dispatch('locator.check', { tabId, steps });
  assert.equal(
    cdpCalls(bridge, 'Input.dispatchMouseEvent').filter(
      (params) => params.type === 'mousePressed',
    ).length,
    1,
    'already checked: no click',
  );
  await runtime.dispatch('locator.setChecked', {
    tabId,
    steps,
    checked: false,
  });
  assert.equal(bridge.checked, false);
});

test('setInputFiles enforces the upload directory policy before touching the page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-upload-'));
  const allowed = join(root, 'allowed');
  await rm(allowed, { recursive: true, force: true });
  await (await import('node:fs/promises')).mkdir(allowed, { recursive: true });
  const file = join(allowed, 'report.txt');
  await writeFile(file, 'hello');
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'nope');
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const steps = [{ kind: 'locator', selector: '#file' }];

  const closed = new ChromeRuntime({ bridge: new FakeBridge() });
  onTestFinished(async () => await closed.stop());
  const closedTab = await claimedTab(closed);
  await assert.rejects(
    closed.dispatch('locator.setInputFiles', {
      tabId: closedTab,
      steps,
      paths: [file],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'UPLOAD_BLOCKED',
  );

  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge, uploadRoots: [allowed] });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  await runtime.dispatch('locator.setInputFiles', {
    tabId,
    steps,
    paths: [file],
  });
  const [upload] = cdpCalls(bridge, 'DOM.setFileInputFiles');
  assert.deepEqual(upload?.files, [await realpath(file)]);
  assert.equal(upload?.objectId, 'node-1');

  await assert.rejects(
    runtime.dispatch('locator.setInputFiles', {
      tabId,
      steps,
      paths: [outside],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'UPLOAD_BLOCKED',
  );
  await assert.rejects(
    runtime.dispatch('locator.setInputFiles', {
      tabId,
      steps,
      paths: [join(allowed, 'missing.txt')],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    runtime.dispatch('locator.setInputFiles', {
      tabId,
      steps,
      paths: ['relative.txt'],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_ARGUMENT',
  );
  assert.equal(cdpCalls(bridge, 'DOM.setFileInputFiles').length, 1);
});

test('filechooser waiters return a browser handle and set files by backend node id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-chooser-'));
  const file = join(root, 'report.txt');
  await writeFile(file, 'hello');
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));

  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge, uploadRoots: [root] });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  const waiting = runtime.dispatch('playwright.waitForEvent', {
    tabId,
    event: 'filechooser',
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  bridge.emit('Page.fileChooserOpened', {
    frameId: 'main',
    mode: 'selectMultiple',
    backendNodeId: 77,
  });
  const chooser = (await waiting) as { chooserId: string; multiple: boolean };
  assert.equal(chooser.multiple, true);
  await runtime.dispatch('fileChooser.setFiles', {
    tabId,
    chooserId: chooser.chooserId,
    files: [file],
  });

  assert.deepEqual(
    cdpCalls(bridge, 'Page.setInterceptFileChooserDialog').map(
      (params) => params.enabled,
    ),
    [true, false],
  );
  const [setFiles] = cdpCalls(bridge, 'DOM.setFileInputFiles');
  assert.equal(setFiles?.backendNodeId, 77);
  assert.deepEqual(setFiles?.files, [await realpath(file)]);
});

test('download waiters resolve at start and path waits for completion', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  const waiting = runtime.dispatch('playwright.waitForEvent', {
    tabId,
    event: 'download',
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  bridge.emit('Page.downloadWillBegin', {
    frameId: 'main',
    guid: 'guid-1',
    url: 'https://mail.example/report.txt',
    suggestedFilename: 'report.txt',
  });
  const download = (await waiting) as { downloadId: string };
  assert.deepEqual(
    await runtime.dispatch('download.events', { tabId, clear: false }),
    [
      {
        type: 'started',
        downloadId: download.downloadId,
        url: 'https://mail.example/report.txt',
        suggestedFilename: 'report.txt',
      },
    ],
  );
  const path = runtime.dispatch('download.path', {
    tabId,
    downloadId: download.downloadId,
    timeoutMs: 1_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  bridge.emit('Page.downloadProgress', {
    guid: 'guid-1',
    state: 'completed',
    receivedBytes: 5,
    totalBytes: 5,
    filePath: '/tmp/report.txt',
  });
  assert.equal(await path, '/tmp/report.txt');
  // Browser and Page domains may duplicate or reorder terminal progress
  // events; a completed download must not regress and emit twice.
  bridge.emit('Page.downloadProgress', {
    guid: 'guid-1',
    state: 'inProgress',
    receivedBytes: 5,
    totalBytes: 5,
  });
  bridge.emit('Page.downloadProgress', {
    guid: 'guid-1',
    state: 'completed',
    receivedBytes: 5,
    totalBytes: 5,
  });
  assert.deepEqual(
    await runtime.dispatch('download.events', { tabId, clear: true }),
    [
      {
        type: 'started',
        downloadId: download.downloadId,
        url: 'https://mail.example/report.txt',
        suggestedFilename: 'report.txt',
      },
      {
        type: 'completed',
        downloadId: download.downloadId,
        url: 'https://mail.example/report.txt',
        suggestedFilename: 'report.txt',
        path: '/tmp/report.txt',
        sizeBytes: 5,
      },
    ],
  );
  bridge.emit('Page.downloadProgress', { guid: 'guid-1', state: 'canceled' });
  assert.deepEqual(
    await runtime.dispatch('download.events', { tabId, clear: true }),
    [],
  );

  bridge.emit('Page.downloadWillBegin', {
    frameId: 'main',
    guid: 'guid-2',
    url: 'https://mail.example/canceled.txt',
    suggestedFilename: 'canceled.txt',
  });
  bridge.emit('Page.downloadProgress', { guid: 'guid-2', state: 'canceled' });
  bridge.emit('Browser.downloadProgress', {
    guid: 'guid-2',
    state: 'completed',
    receivedBytes: 10,
  });
  const canceled = (await runtime.dispatch('download.events', {
    tabId,
    clear: true,
  })) as Array<Record<string, unknown>>;
  assert.deepEqual(
    canceled.map((event) => event.type),
    ['started', 'failed'],
  );
});

test('download lifecycle buffering is opt-in and does not discard events at the wire batch size', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  bridge.emit('Page.downloadWillBegin', {
    frameId: 'main',
    guid: 'before-subscription',
    url: 'https://example.com/before.txt',
    suggestedFilename: 'before.txt',
  });
  assert.deepEqual(
    await runtime.dispatch('download.events', { tabId, clear: true }),
    [],
  );

  for (let index = 0; index < 201; index += 1) {
    bridge.emit('Page.downloadWillBegin', {
      frameId: 'main',
      guid: `guid-${index}`,
      url: `https://example.com/${index}.txt`,
      suggestedFilename: `${index}.txt`,
    });
  }
  const events = (await runtime.dispatch('download.events', {
    tabId,
    clear: true,
  })) as Array<Record<string, unknown>>;
  assert.equal(events.length, 201);
  assert.equal(events[0]?.url, 'https://example.com/0.txt');
  assert.equal(events.at(-1)?.url, 'https://example.com/200.txt');

  bridge.emit('Page.downloadProgress', {
    guid: 'guid-0',
    state: 'completed',
    receivedBytes: 10,
    totalBytes: 10,
  });
  const completed = (await runtime.dispatch('download.events', {
    tabId,
    clear: true,
  })) as Array<Record<string, unknown>>;
  assert.deepEqual(
    completed.map((event) => [event.type, event.url]),
    [['completed', 'https://example.com/0.txt']],
  );
});

test('console and network events pushed by the extension are buffered per tab', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  assert.ok(
    cdpCalls(bridge, 'Runtime.enable').length === 1 &&
      cdpCalls(bridge, 'Network.enable').length === 1 &&
      cdpCalls(bridge, 'Page.enable').length === 1,
  );

  bridge.emit('Runtime.consoleAPICalled', {
    type: 'log',
    timestamp: 1_700_000_000_000,
    args: [
      { type: 'string', value: 'hello' },
      { type: 'object', value: { a: 1 } },
    ],
    stackTrace: {
      callFrames: [
        { url: 'https://mail.example/app.js', lineNumber: 7, columnNumber: 3 },
      ],
    },
  });
  bridge.emit('Runtime.consoleAPICalled', {
    type: 'warning',
    timestamp: 1_700_000_000_001,
    args: [{ type: 'string', value: 'careful' }],
  });
  bridge.emit('Runtime.exceptionThrown', {
    timestamp: 1_700_000_000_002,
    exceptionDetails: {
      text: 'Uncaught',
      url: 'https://mail.example/app.js',
      lineNumber: 12,
      columnNumber: 8,
      exception: { description: 'Error: boom\n    at x' },
    },
  });
  bridge.emit(
    'Runtime.consoleAPICalled',
    { type: 'log', timestamp: 1, args: [] },
    999,
  ); // unknown tab: ignored

  const logs = (await runtime.dispatch('dev.logs', { tabId })) as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    logs.map((entry) => [entry.level, entry.message, entry.url]),
    [
      ['log', 'hello {"a":1}', 'https://mail.example/app.js'],
      ['warn', 'careful', undefined],
      ['error', 'Error: boom', 'https://mail.example/app.js'],
    ],
  );
  assert.equal(logs[0]?.timestamp, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(
    { lineNumber: logs[0]?.lineNumber, columnNumber: logs[0]?.columnNumber },
    { lineNumber: 7, columnNumber: 3 },
  );
  assert.deepEqual(
    {
      lineNumber: logs[2]?.lineNumber,
      columnNumber: logs[2]?.columnNumber,
      stack: logs[2]?.stack,
    },
    { lineNumber: 12, columnNumber: 8, stack: 'at x' },
  );
  const errors = (await runtime.dispatch('dev.logs', {
    tabId,
    levels: ['error'],
  })) as unknown[];
  assert.equal(errors.length, 1);
  const filtered = (await runtime.dispatch('dev.logs', {
    tabId,
    filter: 'HELLO',
    clear: true,
  })) as unknown[];
  assert.equal(filtered.length, 1);
  assert.deepEqual(await runtime.dispatch('dev.logs', { tabId }), []);

  bridge.emit('Network.requestWillBeSent', {
    requestId: 'r1',
    type: 'Fetch',
    wallTime: 1_700_000_000,
    request: { url: 'https://mail.example/api/data', method: 'POST' },
  });
  bridge.emit('Network.responseReceived', {
    requestId: 'r1',
    response: {
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
    },
  });
  bridge.emit('Network.requestWillBeSent', {
    requestId: 'r2',
    type: 'Image',
    wallTime: 1_700_000_001,
    request: { url: 'https://cdn.example/logo.png', method: 'GET' },
  });
  bridge.emit('Network.loadingFailed', {
    requestId: 'r2',
    errorText: 'net::ERR_FAILED',
  });
  let network = (await runtime.dispatch('dev.network', { tabId })) as Array<
    Record<string, unknown>
  >;
  assert.equal(network.length, 2);
  assert.equal(network[0]?.finished, false);
  bridge.emit('Network.loadingFinished', {
    requestId: 'r1',
    encodedDataLength: 321,
  });
  network = (await runtime.dispatch('dev.network', {
    tabId,
    urlPattern: '/api/',
  })) as Array<Record<string, unknown>>;
  assert.deepEqual(
    network.map((entry) => [
      entry.method,
      entry.status,
      entry.mimeType,
      entry.finished,
      entry.encodedDataLength,
    ]),
    [['POST', 201, 'application/json', true, 321]],
  );
  const failed = (await runtime.dispatch('dev.network', {
    tabId,
    urlPattern: 'logo',
  })) as Array<Record<string, unknown>>;
  assert.equal(failed[0]?.failed, 'net::ERR_FAILED');

  // A cross-origin main-frame navigation clears the buffers.
  bridge.emit('Page.frameNavigated', {
    frame: { id: 'main', url: 'https://other.example/' },
  });
  assert.deepEqual(await runtime.dispatch('dev.network', { tabId }), []);
});

test('network trace captures JSON XHR response bodies before shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-browser-use-har-body-'));
  onTestFinished(async () => await rm(root, { recursive: true, force: true }));
  const harPath = join(root, 'network.har');
  const bridge = new FakeBridge();
  bridge.networkResponseBodyDelayMs = 20;
  bridge.networkResponseBodies.set('xhr-json', { body: '{"star_count":56}' });
  const runtime = new ChromeRuntime({ bridge, networkTracePath: harPath });
  await claimedTab(runtime);

  bridge.emit('Network.requestWillBeSent', {
    requestId: 'xhr-json',
    wallTime: 1_700_000_000,
    timestamp: 10,
    request: {
      method: 'POST',
      url: 'https://mail.example/toggle_star.json',
      headers: {},
    },
  });
  bridge.emit('Network.responseReceived', {
    requestId: 'xhr-json',
    timestamp: 10.1,
    type: 'XHR',
    response: {
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      headers: {},
    },
  });
  bridge.emit('Network.loadingFinished', {
    requestId: 'xhr-json',
    timestamp: 10.2,
    encodedDataLength: 24,
  });
  bridge.emit('Network.requestWillBeSent', {
    requestId: 'image',
    wallTime: 1_700_000_001,
    timestamp: 11,
    request: {
      method: 'GET',
      url: 'https://mail.example/logo.png',
      headers: {},
    },
  });
  bridge.emit('Network.responseReceived', {
    requestId: 'image',
    timestamp: 11.1,
    type: 'Image',
    response: {
      status: 200,
      statusText: 'OK',
      mimeType: 'image/png',
      headers: {},
    },
  });
  bridge.emit('Network.loadingFinished', {
    requestId: 'image',
    timestamp: 11.2,
    encodedDataLength: 100,
  });

  await runtime.stop();
  assert.deepEqual(cdpCalls(bridge, 'Network.getResponseBody'), [
    { requestId: 'xhr-json' },
  ]);
  const har = JSON.parse(await readFile(harPath, 'utf8')) as {
    log: {
      entries: Array<{
        request: { url: string };
        response: { content: { text?: string } };
      }>;
    };
  };
  assert.equal(
    har.log.entries.find((entry) =>
      entry.request.url.endsWith('toggle_star.json'),
    )?.response.content.text,
    '{"star_count":56}',
  );
  assert.equal(
    har.log.entries.find((entry) => entry.request.url.endsWith('logo.png'))
      ?.response.content.text,
    undefined,
  );
});

test('an open JavaScript dialog fails page commands immediately and can be handled', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  assert.equal(await runtime.dispatch('tab.getJsDialog', { tabId }), null);
  bridge.emit('Page.javascriptDialogOpening', {
    type: 'confirm',
    message: 'Delete everything?',
    defaultPrompt: '',
    url: 'https://mail.example/',
  });
  const started = Date.now();
  await assert.rejects(
    runtime.dispatch('locator.count', {
      tabId,
      steps: [{ kind: 'locator', selector: 'body' }],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'DIALOG_OPEN' &&
      error.message ===
        'A JavaScript confirm dialog is open on this tab ("Delete everything?") and is blocking further page operations.' &&
      !/getJsDialog/.test(error.message),
  );
  assert.ok(Date.now() - started < 500, 'must not wait for the CDP timeout');
  assert.deepEqual(await runtime.dispatch('tab.getJsDialog', { tabId }), {
    type: 'confirm',
    message: 'Delete everything?',
    defaultPrompt: '',
  });

  await runtime.dispatch('tab.dialog.accept', { tabId, promptText: 'yes' });
  const [handled] = cdpCalls(bridge, 'Page.handleJavaScriptDialog');
  assert.deepEqual(handled, { accept: true, promptText: 'yes' });
  assert.equal(await runtime.dispatch('tab.getJsDialog', { tabId }), null);
  assert.equal(
    await runtime.dispatch('locator.count', {
      tabId,
      steps: [{ kind: 'locator', selector: 'body' }],
    }),
    3,
  );
  await assert.rejects(
    runtime.dispatch('tab.dialog.dismiss', { tabId }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'NOT_FOUND',
  );
});

test('a dialog opening during a command rejects that command instead of hanging', async () => {
  const bridge = new FakeBridge();
  const original = bridge.request.bind(bridge);
  bridge.request = async (method, params = {}) => {
    if (
      method === 'cdp.send' &&
      params.method === 'Input.dispatchMouseEvent' &&
      (params.params as Record<string, unknown>).type === 'mouseReleased'
    ) {
      // The click handler opened an alert: Chrome only acknowledges the event
      // once the dialog closes. Simulate by emitting the dialog and never resolving.
      setTimeout(
        () =>
          bridge.emit('Page.javascriptDialogOpening', {
            type: 'alert',
            message: 'hi',
            defaultPrompt: '',
            url: '',
          }),
        20,
      );
      return await new Promise(() => undefined);
    }
    return await original(method, params);
  };
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const started = Date.now();
  await assert.rejects(
    runtime.dispatch('locator.click', {
      tabId,
      steps: [{ kind: 'locator', selector: '#alert' }],
      timeoutMs: 10_000,
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'DIALOG_OPEN',
  );
  assert.ok(Date.now() - started < 2_000);
});

test('a dialog reported just after mouse release is caught by the input completion barrier', async () => {
  const bridge = new FakeBridge();
  const original = bridge.request.bind(bridge);
  bridge.request = async (method, params = {}) => {
    if (
      method === 'cdp.send' &&
      params.method === 'Input.dispatchMouseEvent' &&
      (params.params as Record<string, unknown>).type === 'mouseReleased'
    ) {
      const result = await original(method, params);
      setTimeout(
        () =>
          bridge.emit('Page.javascriptDialogOpening', {
            type: 'alert',
            message: 'late',
            defaultPrompt: '',
            url: '',
          }),
        0,
      );
      return result;
    }
    return await original(method, params);
  };
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  await assert.rejects(
    runtime.dispatch('locator.click', {
      tabId,
      steps: [{ kind: 'locator', selector: '#alert' }],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'DIALOG_OPEN' &&
      /late/.test(error.message),
  );
});

test('a closed, crashed or detached tab reports STALE_TAB on the next command', async () => {
  for (const [method, params, pattern] of [
    ['qwenBrowser.tabRemoved', {}, /closed/],
    ['Inspector.targetCrashed', {}, /crashed/],
    [
      'qwenBrowser.detached',
      { reason: 'canceled_by_user' },
      /canceled_by_user/,
    ],
  ] as const) {
    const bridge = new FakeBridge();
    const runtime = new ChromeRuntime({ bridge });
    onTestFinished(async () => await runtime.stop());
    const tabId = await claimedTab(runtime);
    bridge.emit(method, params);
    await assert.rejects(
      runtime.dispatch('tab.url', { tabId }),
      (error: unknown) =>
        error instanceof BrowserRuntimeError &&
        error.code === 'STALE_TAB' &&
        pattern.test(error.message),
    );
    assert.deepEqual(
      await runtime.dispatch('tabs.list', { browserId: 'user-chrome' }),
      [],
    );
  }
});

test('connection loss clears discontinuous event state and resynchronizes the existing claim', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  bridge.emit('Runtime.consoleAPICalled', {
    type: 'log',
    timestamp: 1,
    args: [{ type: 'string', value: 'before-gap' }],
  });
  bridge.emit('Network.requestWillBeSent', {
    requestId: 'before-gap',
    type: 'Fetch',
    wallTime: 1,
    request: { url: 'https://mail.example/gap', method: 'GET' },
  });
  const enablesBefore = bridge.calls.filter(
    (call) =>
      call.method === 'cdp.send' &&
      String(call.params.method).endsWith('.enable'),
  ).length;

  bridge.setConnected(false);
  bridge.setConnected(true);
  assert.equal(
    await runtime.dispatch('tab.url', { tabId }),
    bridge.current.url,
  );
  assert.deepEqual(await runtime.dispatch('dev.logs', { tabId }), []);
  assert.deepEqual(await runtime.dispatch('dev.network', { tabId }), []);
  const enablesAfter = bridge.calls.filter(
    (call) =>
      call.method === 'cdp.send' &&
      String(call.params.method).endsWith('.enable'),
  ).length;
  assert.equal(
    enablesAfter - enablesBefore,
    3,
    'Page, Runtime and Network domains must be re-enabled after reconnect',
  );
  assert.ok(bridge.calls.some((call) => call.method === 'tabs.attach'));
});

test('claim fails and detaches when required CDP event domains cannot be enabled', async () => {
  const bridge = new FakeBridge();
  bridge.failCdpMethods.add('Network.enable');
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());

  await assert.rejects(
    claimedTab(runtime),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'OPERATION_FAILED' &&
      /Network.enable failed/.test(error.message),
  );
  assert.ok(bridge.calls.some((call) => call.method === 'tabs.detach'));
  assert.deepEqual(
    await runtime.dispatch('tabs.list', { browserId: 'user-chrome' }),
    [],
  );
});

test('networkidle waits for in-flight requests reported by the extension', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  bridge.emit('Network.requestWillBeSent', {
    requestId: 'slow',
    type: 'XHR',
    wallTime: 1,
    request: { url: 'https://mail.example/slow', method: 'GET' },
  });
  const started = Date.now();
  const waiting = runtime.dispatch('playwright.waitForLoadState', {
    tabId,
    state: 'networkidle',
    timeoutMs: 5_000,
  });
  assert.equal(
    (
      (await runtime.dispatch('dev.network', {
        tabId,
        clear: true,
      })) as unknown[]
    ).length,
    1,
  );
  assert.deepEqual(await runtime.dispatch('dev.network', { tabId }), []);
  setTimeout(
    () => bridge.emit('Network.loadingFinished', { requestId: 'slow' }),
    400,
  );
  await waiting;
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= 850 && elapsed < 3_000,
    `networkidle should resolve ~500ms after the last request finished (took ${elapsed}ms)`,
  );
});

test('expectNavigation retains a fast navigation event until the action has returned', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  const waiterId = await runtime.dispatch('playwright.expectNavigation.begin', {
    tabId,
    url: '**/landing.html',
    waitUntil: 'load',
    timeoutMs: 5_000,
  });
  assert.equal(typeof waiterId, 'string');

  // This is the race expectNavigation exists to cover: the click-triggered
  // navigation and load can both finish before the action promise returns and
  // the SDK sends its hidden `.wait` command.
  bridge.emit('Page.frameNavigated', {
    frame: { id: 'main', url: 'https://mail.example/landing.html' },
  });
  bridge.emit('Page.loadEventFired', {});

  await runtime.dispatch('playwright.expectNavigation.wait', {
    tabId,
    waiterId,
  });
});

test('coordinate CUA maps all seven public primitives to fixed CDP Input commands', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  bridge.calls.length = 0;

  await runtime.dispatch('cua.click', {
    tabId,
    x: 100,
    y: 200,
    button: 3,
    keypress: ['Shift'],
  });
  await runtime.dispatch('cua.double_click', { tabId, x: 110, y: 210 });
  await runtime.dispatch('cua.move', { tabId, x: 120, y: 220, keys: ['Alt'] });
  await runtime.dispatch('cua.scroll', {
    tabId,
    x: 130,
    y: 230,
    scrollX: -5,
    scrollY: 600,
    keypress: ['Control'],
  });
  await runtime.dispatch('cua.drag', {
    tabId,
    path: [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ],
  });
  await runtime.dispatch('cua.keypress', { tabId, keys: ['Control', 'A'] });
  await runtime.dispatch('cua.type', { tabId, text: 'hello' });

  const cdp = bridge.calls
    .filter((call) => call.method === 'cdp.send')
    .map((call) => ({
      method: call.params.method,
      params: call.params.params as Record<string, unknown>,
    }));
  const input = cdp.filter((call) => String(call.method).startsWith('Input.'));
  assert.deepEqual(input.slice(0, 3), [
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 100, y: 200, modifiers: 8 },
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mousePressed',
        x: 100,
        y: 200,
        button: 'right',
        buttons: 2,
        clickCount: 1,
        modifiers: 8,
      },
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        x: 100,
        y: 200,
        button: 'right',
        buttons: 0,
        clickCount: 1,
        modifiers: 8,
      },
    },
  ]);
  const doubleClickEvents = input
    .slice(3, 8)
    .map((call) => call.params.clickCount)
    .filter((value) => value !== undefined);
  assert.deepEqual(doubleClickEvents, [1, 1, 2, 2]);
  assert.ok(
    cdp.some(
      (call) =>
        call.params.type === 'mouseWheel' &&
        call.params.deltaY === 600 &&
        call.params.modifiers === 2,
    ),
  );
  assert.ok(
    cdp.some(
      (call) =>
        call.params.type === 'mouseReleased' &&
        call.params.x === 50 &&
        call.params.y === 60,
    ),
  );
  assert.ok(
    cdp.some(
      (call) =>
        call.method === 'Input.dispatchKeyEvent' &&
        call.params.code === 'KeyA' &&
        call.params.modifiers === 2,
    ),
  );
  const typed = input
    .slice(-10)
    .map((call) => `${call.params.type}:${call.params.text ?? ''}`);
  assert.deepEqual(typed, [
    'keyDown:h',
    'keyUp:',
    'keyDown:e',
    'keyUp:',
    'keyDown:l',
    'keyUp:',
    'keyDown:l',
    'keyUp:',
    'keyDown:o',
    'keyUp:',
  ]);

  await assert.rejects(
    runtime.dispatch('tab.screenshot', {
      tabId,
      fullPage: true,
      clip: { x: 0, y: 0, width: 100, height: 100 },
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_ARGUMENT',
  );
});

test('model-neutral primitives expose activation and split input events', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());

  const [candidate] = await runtime.executePrimitive('tab.discover', {
    browserId: 'user-chrome',
  });
  assert.ok(candidate);
  const tab = await runtime.executePrimitive('tab.claim', {
    browserId: 'user-chrome',
    tab: candidate,
  });
  bridge.calls.length = 0;

  await runtime.executePrimitive('tab.activate', { tabId: tab.id });
  await runtime.executePrimitive('pointer.down', {
    tabId: tab.id,
    x: 10,
    y: 20,
    modifiers: ['Shift'],
  });
  await assert.rejects(
    runtime.executePrimitive('pointer.click', { tabId: tab.id, x: 20, y: 30 }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'CONCURRENT_TAB_OPERATION',
  );
  await runtime.executePrimitive('pointer.move', {
    tabId: tab.id,
    x: 25,
    y: 35,
    modifiers: ['Shift'],
  });
  await runtime.executePrimitive('pointer.up', {
    tabId: tab.id,
    x: 30,
    y: 40,
    modifiers: ['Shift'],
  });
  await runtime.executePrimitive('pointer.click', {
    tabId: tab.id,
    x: 50,
    y: 60,
    button: 'right',
    modifiers: ['Shift'],
  });
  await runtime.executePrimitive('keyboard.down', {
    tabId: tab.id,
    key: 'Control',
  });
  await runtime.executePrimitive('keyboard.up', {
    tabId: tab.id,
    key: 'Control',
  });
  await runtime.executePrimitive('keyboard.hold', {
    tabId: tab.id,
    keys: ['Shift'],
    durationMs: 0,
  });
  await runtime.executePrimitive('keyboard.press', {
    tabId: tab.id,
    keys: ['ControlOrMeta', 'a'],
  });

  assert.deepEqual(
    bridge.calls.find((call) => call.method === 'tabs.activate'),
    {
      method: 'tabs.activate',
      params: { tabId: 41 },
    },
  );
  const mouse = cdpCalls(bridge, 'Input.dispatchMouseEvent');
  assert.ok(
    mouse.some(
      (params) =>
        params.type === 'mousePressed' &&
        params.buttons === 1 &&
        params.modifiers === 8,
    ),
  );
  assert.ok(
    mouse.some(
      (params) =>
        params.type === 'mouseMoved' && params.buttons === 1 && params.x === 25,
    ),
  );
  assert.ok(
    mouse.some(
      (params) =>
        params.type === 'mouseReleased' &&
        params.buttons === 0 &&
        params.x === 30,
    ),
  );
  assert.ok(
    mouse.some(
      (params) =>
        params.type === 'mousePressed' &&
        params.button === 'right' &&
        params.modifiers === 8,
    ),
  );
  const keyboard = cdpCalls(bridge, 'Input.dispatchKeyEvent');
  assert.ok(
    keyboard.some(
      (params) =>
        params.type === 'rawKeyDown' &&
        params.key === 'Control' &&
        params.modifiers === 2,
    ),
  );
  assert.ok(
    keyboard.some(
      (params) => params.type === 'keyUp' && params.key === 'Control',
    ),
  );
  assert.ok(
    keyboard.some(
      (params) =>
        params.type === 'rawKeyDown' &&
        params.key === 'Shift' &&
        params.modifiers === 8,
    ),
  );
  assert.ok(
    keyboard.some(
      (params) =>
        params.type === 'rawKeyDown' &&
        params.code === 'KeyA' &&
        params.modifiers === (process.platform === 'darwin' ? 4 : 2) &&
        Array.isArray(params.commands) &&
        params.commands.includes('selectAll'),
    ),
  );
});

function sessionCalls(
  bridge: FakeBridge,
  method: string,
): Array<{ sessionId: unknown; params: Record<string, unknown> }> {
  return bridge.calls
    .filter(
      (call) => call.method === 'cdp.send' && call.params.method === method,
    )
    .map((call) => ({
      sessionId: call.params.sessionId,
      params: call.params.params as Record<string, unknown>,
    }));
}

test("frame hops route page commands to the frame's execution context or child session", async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  assert.ok(
    cdpCalls(bridge, 'Target.setAutoAttach').some(
      (params) => params.flatten === true,
    ),
    'child targets are auto-attached at claim time',
  );

  // A same-process frame announces its document through an execution context on the tab session.
  bridge.emit('Runtime.executionContextCreated', {
    context: { id: 7, auxData: { frameId: 'F-same', isDefault: true } },
  });
  // An out-of-process frame is a child target with its own session.
  bridge.emit('Target.attachedToTarget', {
    sessionId: 'S-cross',
    targetInfo: {
      type: 'iframe',
      targetId: 'F-cross',
      url: 'http://localhost/cross.html',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    sessionCalls(bridge, 'Runtime.enable').some(
      (call) => call.sessionId === 'S-cross',
    ),
    'the child session gets its domains enabled',
  );
  const crossEvent: BridgeEvent = {
    type: 'event',
    tabId: 41,
    sessionId: 'S-cross',
    method: 'Runtime.executionContextCreated',
    params: {
      context: { id: 3, auxData: { frameId: 'F-cross', isDefault: true } },
    },
  };
  for (const listener of bridge.listeners) listener(crossEvent);
  // Chrome may report the root session's process-swap detach after the new
  // child session and context. That stale event must not erase the OOPIF.
  bridge.emit('Page.frameDetached', { frameId: 'F-cross', reason: 'swap' });

  bridge.calls.length = 0;
  await runtime.dispatch('locator.count', {
    tabId,
    steps: [
      { kind: 'frame', selector: '#same' },
      { kind: 'locator', selector: 'button' },
    ],
  });
  const sameEvaluations = sessionCalls(bridge, 'Runtime.evaluate').filter(
    (call) => String(call.params.expression).includes('"operation":"count"'),
  );
  assert.equal(sameEvaluations.length, 1);
  assert.equal(
    sameEvaluations[0]?.params.contextId,
    7,
    "the count runs in the same-process frame's context",
  );
  assert.equal(sameEvaluations[0]?.sessionId, undefined);
  assert.ok(
    sessionCalls(bridge, 'DOM.describeNode').some(
      (call) => call.params.objectId === 'iframe-same',
    ),
  );

  bridge.calls.length = 0;
  await runtime.dispatch('locator.click', {
    tabId,
    steps: [
      { kind: 'frame', selector: '#cross' },
      { kind: 'locator', selector: 'button' },
    ],
  });
  const crossResolve = sessionCalls(bridge, 'Runtime.evaluate').filter(
    (call) =>
      String(call.params.expression).includes('"operation":"resolve"') &&
      String(call.params.expression).includes('"selector":"button"'),
  );
  assert.equal(
    crossResolve[0]?.sessionId,
    'S-cross',
    'the element is resolved through the child session',
  );
  assert.equal(crossResolve[0]?.params.contextId, 3);
  const pressed = cdpCalls(bridge, 'Input.dispatchMouseEvent').find(
    (params) => params.type === 'mousePressed',
  );
  // quads (10..110, 20..60) are relative to the out-of-process frame; its content box starts at (100, 200).
  assert.deepEqual(
    [pressed?.x, pressed?.y],
    [160, 240],
    "click coordinates add the iframe's content-box origin",
  );
  const hitTest = sessionCalls(bridge, 'Runtime.callFunctionOn').find((call) =>
    String(call.params.functionDeclaration).includes('elementFromPoint'),
  );
  assert.equal(hitTest?.sessionId, 'S-cross');
  assert.deepEqual(
    (hitTest?.params.arguments as Array<{ value: number }>).map(
      (argument) => argument.value,
    ),
    [60, 40],
    'hit testing uses frame-local coordinates',
  );
  const clickBarrier = sessionCalls(bridge, 'Runtime.evaluate').find((call) =>
    String(call.params.expression).includes('__qwenBrowserInputBarrier'),
  );
  assert.equal(
    clickBarrier?.sessionId,
    'S-cross',
    'click completion is awaited in the child session',
  );
  assert.equal(
    clickBarrier?.params.contextId,
    3,
    'click completion is awaited in the target frame context',
  );

  bridge.calls.length = 0;
  assert.equal(
    await runtime.dispatch('locator.evaluate', {
      tabId,
      steps: [
        { kind: 'frame', selector: '#same' },
        { kind: 'locator', selector: 'button' },
      ],
      script: 'return element.id;',
    }),
    'submit',
  );
  const sameEvaluate = sessionCalls(bridge, 'Runtime.evaluate').find((call) =>
    String(call.params.expression).includes('return element.id;'),
  );
  assert.equal(sameEvaluate?.sessionId, undefined);
  assert.equal(
    sameEvaluate?.params.contextId,
    7,
    'locator.evaluate runs in the same-process frame context',
  );

  bridge.calls.length = 0;
  assert.equal(
    await runtime.dispatch('locator.evaluateAll', {
      tabId,
      steps: [
        { kind: 'frame', selector: '#cross' },
        { kind: 'locator', selector: 'button' },
      ],
      script: 'return elements.length;',
    }),
    3,
  );
  const crossEvaluate = sessionCalls(bridge, 'Runtime.evaluate').find((call) =>
    String(call.params.expression).includes('return elements.length;'),
  );
  assert.equal(
    crossEvaluate?.sessionId,
    'S-cross',
    'locator.evaluateAll runs through the child session',
  );
  assert.equal(
    crossEvaluate?.params.contextId,
    3,
    'locator.evaluateAll runs in the cross-process frame context',
  );

  bridge.calls.length = 0;
  await runtime.dispatch('locator.count', {
    tabId,
    steps: [{ kind: 'ref', ref: 'n5/n9' }],
  });
  const pathEvaluations = sessionCalls(bridge, 'Runtime.evaluate').map((call) =>
    String(call.params.expression),
  );
  assert.ok(
    pathEvaluations.some(
      (expression) =>
        expression.includes('"ref":"n5"') &&
        expression.includes('"operation":"resolve"'),
    ),
    "the path's first segment resolves the iframe",
  );
  assert.ok(
    pathEvaluations.some(
      (expression) =>
        expression.includes('"ref":"n9"') &&
        expression.includes('"operation":"count"'),
    ),
    'the last segment runs inside the frame',
  );

  bridge.emit('Target.detachedFromTarget', { sessionId: 'S-cross' });
  await assert.rejects(
    runtime.dispatch('locator.innerText', {
      tabId,
      steps: [
        { kind: 'frame', selector: '#cross' },
        { kind: 'locator', selector: 'button' },
      ],
      timeoutMs: 600,
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'INVALID_LOCATOR' &&
      /not reachable/.test(error.message),
  );
});

test('a failed child-session domain setup is reported when entering an out-of-process frame', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  bridge.failCdpMethods.add('Network.enable');
  bridge.emit('Target.attachedToTarget', {
    sessionId: 'S-cross',
    targetInfo: {
      type: 'iframe',
      targetId: 'F-cross',
      url: 'http://localhost/cross.html',
    },
  });
  const context: BridgeEvent = {
    type: 'event',
    tabId: 41,
    sessionId: 'S-cross',
    method: 'Runtime.executionContextCreated',
    params: {
      context: { id: 3, auxData: { frameId: 'F-cross', isDefault: true } },
    },
  };
  for (const listener of bridge.listeners) listener(context);

  await assert.rejects(
    runtime.dispatch('locator.count', {
      tabId,
      steps: [
        { kind: 'frame', selector: '#cross' },
        { kind: 'locator', selector: 'button' },
      ],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'OPERATION_FAILED' &&
      /Network\.enable failed/.test(error.message),
  );
});

test("a dialog raised inside an out-of-process frame is handled on that frame's session", async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  const event: BridgeEvent = {
    type: 'event',
    tabId: 41,
    sessionId: 'S-cross',
    method: 'Page.javascriptDialogOpening',
    params: {
      type: 'alert',
      message: 'from frame',
      defaultPrompt: '',
      url: '',
    },
  };
  for (const listener of bridge.listeners) listener(event);
  await assert.rejects(
    runtime.dispatch('locator.count', {
      tabId,
      steps: [{ kind: 'locator', selector: 'body' }],
    }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'DIALOG_OPEN',
  );
  await runtime.dispatch('tab.dialog.dismiss', { tabId });
  const handled = sessionCalls(bridge, 'Page.handleJavaScriptDialog');
  assert.equal(handled[0]?.sessionId, 'S-cross');
  assert.equal(handled[0]?.params.accept, false);
});

test('click count is an atomic primitive for coordinate and ref clicks', async () => {
  const bridge = new FakeBridge();
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);
  bridge.calls.length = 0;

  await runtime.dispatch('cua.click', { tabId, x: 40, y: 50, clickCount: 3 });
  const coordinatePresses = cdpCalls(bridge, 'Input.dispatchMouseEvent')
    .filter((params) => params.type === 'mousePressed')
    .map((params) => params.clickCount);
  assert.deepEqual(coordinatePresses, [1, 2, 3]);

  bridge.calls.length = 0;
  await runtime.dispatch('dom_cua.click', {
    tabId,
    nodeId: 'n3',
    clickCount: 3,
  });
  const refPresses = cdpCalls(bridge, 'Input.dispatchMouseEvent')
    .filter((params) => params.type === 'mousePressed')
    .map((params) => params.clickCount);
  assert.deepEqual(refPresses, [1, 2, 3]);

  await assert.rejects(
    runtime.dispatch('cua.click', { tabId, x: 40, y: 50, clickCount: 4 }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_ARGUMENT',
  );
});

test('screenshot scale magnifies the capture without changing the CSS-pixel clip', async () => {
  const bridge = new FakeBridge();
  bridge.devicePixelRatio = 2;
  const runtime = new ChromeRuntime({ bridge });
  onTestFinished(async () => await runtime.stop());
  const tabId = await claimedTab(runtime);

  await runtime.dispatch('tab.screenshot', {
    tabId,
    clip: { x: 10, y: 20, width: 100, height: 50 },
    scale: 3,
  });
  const [capture] = cdpCalls(bridge, 'Page.captureScreenshot');
  assert.deepEqual(capture?.clip, {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    scale: 1.5,
  });

  await assert.rejects(
    runtime.dispatch('tab.screenshot', { tabId, scale: 4 }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError &&
      error.code === 'INVALID_ARGUMENT' &&
      /budget/.test(error.message),
  );
  await assert.rejects(
    runtime.dispatch('tab.screenshot', { tabId, scale: 5 }),
    (error: unknown) =>
      error instanceof BrowserRuntimeError && error.code === 'INVALID_ARGUMENT',
  );
});
