import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerUse } from '../index.js';
import { createCua } from '../runtime.js';
import { documentation } from '../documentation.js';
function fixture() {
  const calls = []; const written = []; const images = [];
  const computer = new ComputerUse({ callTool(name, raw) {
    const args = JSON.parse(raw); calls.push([name, args]);
    return { text: name.startsWith('get_') ? 'driver-rendered state [1]' : 'Sent but not confirmed.',
      structuredJson: JSON.stringify({ app: 'org.fixture', name: 'Fixture' }),
      images: name.includes('screenshot') ? [{ mimeType: 'image/png', dataBase64: 'AQ==' }] : [],
    };
  } });
  return { cua: createCua({ write: (x) => written.push(x), emitImage: (x) => images.push(x) }, { computer }), calls, written, images };
}
test('getApp emits its one native full AX result; observations forward driver text unchanged', async () => {
  const f = fixture(); const app = await f.cua.getApp('Fixture');
  assert.deepEqual(f.calls, [['get_app', { app: 'Fixture' }]]);
  assert.deepEqual(f.written, ['driver-rendered state [1]']); assert.equal(f.images.length, 0);
  assert.equal(await app.getAXState({ forceFull: true, maxTextChars: 20000, emit: false }), 'driver-rendered state [1]');
  assert.deepEqual(f.calls.at(-1), ['get_ax_state', { app: 'org.fixture', force_full: true, max_text_chars: 20000 }]);
  assert.equal(f.written.length, 1);
});
test('screenshot-only is a distinct native operation and actual MIME is preserved', async () => {
  const f = fixture(); const app = await f.cua.getApp('Fixture');
  await app.getScreenshot();
  assert.equal(f.calls.at(-1)[0], 'get_screenshot');
  assert.deepEqual(f.images, ['data:image/png;base64,AQ==']);
  await app.getAXStateAndScreenshot({ emit: false }); assert.equal(f.images.length, 1);
});
test('actions return void, preserve advisories and send once with click modifiers', async () => {
  const f = fixture(); const app = await f.cua.getApp('Fixture');
  assert.equal(await app.click(1, { key: ['shift'] }), undefined);
  assert.deepEqual(f.calls.at(-1), ['click', { app: 'org.fixture', element: 1, key: ['shift'] }]);
  assert.equal(f.written.at(-1), 'Sent but not confirmed.');
  assert.equal(f.calls.length, 2);
});
test('documentation is platform-specific and includes generated tool descriptions', () => {
  assert.match(documentation('linux'), /only X11/);
  assert.match(documentation('darwin'), /macOS/);
  assert.match(documentation('darwin'), /getAXStateAndScreenshot/);
  assert.match(documentation('darwin'), /cua\.desktop\.keyDown/);
  assert.doesNotMatch(documentation('darwin'), /app\.desktop\./);
});

test('desktop calls use explicit scope, serialize, return void and dispose the owning session', async () => {
  const f = fixture();
  await f.cua.desktop.getScreenshot();
  assert.deepEqual(f.calls[0], ['get_screenshot', { scope: 'desktop' }]);
  assert.equal(await f.cua.desktop.click({ x: 15, y: 32 }, { key: 'ctrl' }), undefined);
  assert.deepEqual(f.calls[1], ['click', { key: 'ctrl', x: 15, y: 32, scope: 'desktop' }]);
  await f.cua.desktop.keyDown('shift');
  await f.cua.desktop.keyUp('shift');
  assert.deepEqual(f.calls.slice(-2), [['key_down', { key: 'shift', scope: 'desktop' }], ['key_up', { key: 'shift', scope: 'desktop' }]]);
  await f.cua[Symbol.asyncDispose]();
  await assert.rejects(f.cua.desktop.keyDown('shift'), /closed/);
});

test('browser facade returns repository handles unchanged, requires unique URLs, and cleans up', async () => {
  const written = []; const navigated = []; let closed = 0;
  const tab = { id: 'tab-1', playwright: { domSnapshot: async () => 'DOM' }, goto: async (url) => navigated.push(url) };
  const browser = { browserId: 'chrome-1', documentation: async () => 'BROWSER DOC', tabs: {
    list: async () => [{ id: 'tab-1', url: 'https://example.com' }, { id: 'tab-2', url: 'https://example.com' }],
    get: async (id) => { assert.equal(id, 'tab-1'); return tab; }, new: async () => tab,
  } };
  const browserModule = { setupBrowserRuntime: async () => ({ browsers: {
    list: async () => [{ id: 'chrome-1', name: 'Chrome' }], get: async () => browser,
  } }), closeBrowserRuntime: async () => { closed++; } };
  const cua = createCua({ write: (value) => written.push(value) }, { browserModule });
  assert.equal(await cua.getBrowser('Chrome'), browser);
  assert.equal(await cua.getBrowser({ id: 'chrome-1' }), browser);
  assert.equal(written.filter((text) => text === 'BROWSER DOC').length, 1);
  await assert.rejects(cua.getTab({ url: 'https://example.com' }), /found 2/);
  assert.equal(await cua.getTab('tab-1', { browser: 'Chrome' }), tab);
  assert.equal(written.at(-1), 'DOM');
  assert.equal(await cua.createBrowserTab('Chrome', 'https://example.org'), tab);
  assert.deepEqual(navigated, ['https://example.org']);
  await cua[Symbol.asyncDispose](); assert.equal(closed, 1);
  await assert.rejects(cua.getBrowser('Chrome'), /closed/);
});

test('disposing during a lazy browser import prevents a late browser connection', async () => {
  let resolveModule; let connected = 0;
  const pending = new Promise((resolve) => { resolveModule = resolve; });
  const cua = createCua({ write() {} }, { browserModule: pending });
  const selection = cua.getBrowser('Chrome');
  await cua[Symbol.asyncDispose]();
  resolveModule({ setupBrowserRuntime() { connected++; throw new Error('must not connect'); } });
  await assert.rejects(selection, /closed/);
  assert.equal(connected, 0);
});
