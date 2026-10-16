import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerUse } from '../index.js';
import { createCua } from '../runtime.js';
import { documentation } from '../documentation.js';

function fixture() {
  const calls = [], output = [], images = [];
  let revision = 0;
  const result = (value, extra = {}) => ({ text: '', isError: false, structuredJson: JSON.stringify(value), images: [], ...extra });
  const driver = {
    async listToolsJson() { return JSON.stringify({ platform: 'macos', tools: [{ name: 'get_window_state', capabilities: ['accessibility.observation_revision.v1'] }] }); },
    async listApps() { return result({ apps: [{ name: 'Fixture', bundle_id: 'fixture', pid: 42, running: true }] }); },
    async listWindows() { return result({ windows: [{ window_id: 7, title: 'Document', is_app_target: true }] }); },
    async getWindowState(input) {
      calls.push(input);
      revision++;
      return result({
        tree_markdown: '[1] Button "Save"',
        elements: [{ element_id: 1, element_token: 'current' }],
        observation_revision: { mode: input.observationRevision.baseRevisionId ? 'no_change' : 'full', revision_id: `r${revision}`, stable_element_ids: true, capture_complete: true },
        ...(input.includeScreenshot ? { screenshot_width: 100, screenshot_height: 80, screenshot_frame_valid: true } : {}),
      }, { images: input.includeScreenshot ? [{ mimeType: 'image/jpeg', dataBase64: '/9j/2Q==' }] : [] });
    },
    async windowClick(input) { calls.push(input); return result({ effect: 'confirmed' }); },
    async windowTypeText(input) { calls.push(input); return result({ effect: 'unverifiable' }); },
  };
  const controller = new AbortController();
  const cua = createCua({ write: value => output.push(value), emitImage: async value => images.push(value), get signal() { return controller.signal; } }, { computer: new ComputerUse(driver) });
  return { cua, calls, output, images, controller };
}

test('getApp emits full AX without an image; subsequent observations use the native cursor', async () => {
  const { cua, calls, output, images } = fixture();
  const app = await cua.getApp('Fixture');
  assert.equal(calls[0].includeScreenshot, false);
  assert.equal(calls[0].observationRevision.forceFull, true);
  assert.match(output[0], /Save/);
  assert.deepEqual(images, []);
  const text = await app.getAXState();
  assert.equal(typeof text, 'string');
  assert.equal(calls[1].includeScreenshot, false);
  assert.equal(calls[1].observationRevision.baseRevisionId, 'r1');
  assert.equal(output.length, 2);
  await app.getAXState({ emit: false });
  assert.equal(output.length, 2);
});

test('screenshots auto emit with their actual MIME; emit:false suppresses both outputs', async () => {
  const { cua, calls, output, images } = fixture();
  const app = await cua.getApp('Fixture');
  await app.getAXStateAndScreenshot();
  assert.equal(calls.at(-1).includeScreenshot, true);
  assert.equal(images[0], 'data:image/jpeg;base64,/9j/2Q==');
  const count = output.length;
  assert.equal(typeof await app.getScreenshot({ emit: false }), 'string');
  assert.equal(output.length, count);
  assert.equal(images.length, 1);
});

test('actions return void and warn on unconfirmed delivery without retrying', async () => {
  const { cua, calls, output } = fixture();
  const app = await cua.getApp('Fixture');
  assert.equal(await app.click(1), undefined);
  assert.equal(output.length, 1);
  assert.equal(await app.typeText('hello'), undefined);
  assert.match(output.at(-1), /Sent but not confirmed/);
  assert.equal(calls.filter(call => call.text === 'hello').length, 1);
});

test('documentation is platform-specific and rewrites without native state', () => {
  const output = [];
  const cua = createCua({ write: value => output.push(value), emitImage: async () => {} });
  assert.equal(typeof cua.rewriteDocumentation(), 'string');
  assert.equal(output.length, 1);
  assert.match(documentation('linux'), /only X11/);
  assert.doesNotMatch(documentation('linux'), /macOS text:/);
  assert.match(documentation('darwin'), /macOS text:/);
});
