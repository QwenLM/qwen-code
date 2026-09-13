import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { liveMessage } from '@qwen-code/qwen-live/i18n';
import * as policy from '../live-state-policy.ts';
import { isScreenDisplayId } from '../../shared/protocol.ts';

const DISPLAY = '11223344-5566-7788-99aa-bbccddeeff00';
const OTHER = '11223344-5566-7788-99aa-bbccddeeff11';
const image = Uint8Array.of(1, 2, 3);

function fixture() {
  const tree = ts.createSourceFile(
    'index.ts',
    readFileSync(new URL('../index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = [
    'captureOnDemandVisual',
    'captureScreenFeed',
    'sameVisualInput',
    'hostReadinessBlocker',
    'visualSourceReady',
    'refreshScreenDisplays',
    'registerIpc',
  ];
  const declarations = tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name &&
      names.includes(node.name.text),
  );
  assert.equal(declarations.length, names.length);
  const methods = ts.transpileModule(
    declarations.map((node) => node.getText(tree)).join('\n') +
      '\n({' +
      names.join(',') +
      '});',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const calls: Array<{ kind: string; value?: unknown }> = [];
  const diagnostics: Array<{
    event: string;
    details: Record<string, unknown>;
  }> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const context = {
    Buffer,
    createHash,
    diagnosticsEnabled: true,
    ...policy,
    liveMessage,
    isScreenDisplayId,
    daemon: {
      getEpoch: () => 1,
      sendVisualFrame: (...args: unknown[]) => {
        calls.push({ kind: 'frame', value: args });
        return true;
      },
      sendVisualSettings: (...args: unknown[]) => {
        calls.push({ kind: 'settings', value: args });
        return true;
      },
    },
    appshotCapture: {
      captureFrame: async () => {
        calls.push({ kind: 'window' });
        return {
          screenshot: image,
          appName: 'Fixture app',
          accessibilityText: 'AX fixture',
        };
      },
      captureDisplayFrame: async (id: string) => {
        calls.push({ kind: 'display', value: id });
        return { screenshot: image, displayId: DISPLAY };
      },
      listDisplays: () => [
        {
          id: DISPLAY,
          name: 'Fixture display',
          width: 1920,
          height: 1080,
          primary: true,
        },
      ],
      storePng: async () => {
        calls.push({ kind: 'asset' });
        return '/fixture/image.png';
      },
    },
    ipcMain: {
      on: (name: string, fn: (...args: unknown[]) => unknown) =>
        handlers.set(name, fn),
      handle: (name: string, fn: (...args: unknown[]) => unknown) =>
        handlers.set(name, fn),
    },
    isTrustedSender: () => true,
    rendererEventsEnabled: true,
    quitState: undefined,
    connection: { phase: 'ready', displayCaptureV1: true },
    visualInput: {
      source: 'screen',
      mode: 'on-demand',
      screenDisplayId: DISPLAY,
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    },
    visualGeneration: 0,
    screenFeedGeneration: 0,
    screenFeedInFlight: false,
    visualCallId: 'call',
    visualReady: false,
    visualError: undefined,
    screenDisplays: [] as Array<{ id: string }>,
    screenDisplaysError: undefined,
    live: {
      v: 1,
      available: true,
      state: 'listening',
      callId: 'call',
      shortcut: 'Command+E',
    },
    permissions: {
      accessibility: 'granted',
      screenRecording: 'granted',
      microphone: 'granted',
      camera: 'granted',
    },
    selfChecks: {
      appshot: true,
      audioInput: true,
      audioOutput: true,
      globalShortcut: true,
    },
    appshotReadiness: { refresh() {}, requestPermission() {} },
    isHostReady: () => true,
    encodeScreenFrame: () => ({
      image: 'fixture-jpeg',
      width: 1280,
      height: 720,
    }),
    writeLiveDiagnostic: (event: string, details: Record<string, unknown>) =>
      diagnostics.push({ event, details }),
    publishState: () => {},
  };
  const api = runInNewContext(methods, context) as {
    captureOnDemandVisual: (value: object) => Promise<Record<string, unknown>>;
    captureScreenFeed: (generation: number) => Promise<void>;
    sameVisualInput: (a: object, b: object) => boolean;
    hostReadinessBlocker: () => string | undefined;
    registerIpc: () => void;
  };
  return { api, context, calls, handlers, diagnostics };
}

describe('selected display capture routing', () => {
  it('keeps foreground Appshot and its asset/AX separate from private monitor display capture', async () => {
    const f = fixture();
    const appshot = await f.api.captureOnDemandVisual({
      source: 'screen',
      persistAsset: true,
    });
    assert.deepEqual(
      f.calls.map((call) => call.kind),
      ['window', 'asset'],
    );
    assert.equal(appshot.accessibilityText, 'AX fixture');
    assert.equal(appshot.screenshotPath, '/fixture/image.png');
    f.calls.length = 0;
    f.context.permissions.accessibility = 'denied';
    f.context.selfChecks.appshot = false;
    const monitor = await f.api.captureOnDemandVisual({
      source: 'screen',
      screenScope: 'display',
      screenDisplayId: DISPLAY,
      persistAsset: false,
    });
    assert.deepEqual(f.calls, [{ kind: 'display', value: DISPLAY }]);
    assert.equal(monitor.displayId, DISPLAY);
    assert.equal(monitor.screenScope, 'display');
    assert.equal(monitor.accessibilityText, undefined);
    assert.equal(monitor.screenshotPath, undefined);
  });

  it('feeds the complete selected display with its identity and no foreground-window call', async () => {
    const f = fixture();
    f.context.visualInput.mode = 'live-feed';
    await f.api.captureScreenFeed(0);
    assert.equal(f.calls[0]?.kind, 'display');
    assert.deepEqual(f.calls[1], {
      kind: 'frame',
      value: ['screen', 'fixture-jpeg', 1, DISPLAY],
    });
    assert.equal(
      f.calls.some((call) => call.kind === 'window'),
      false,
    );
    assert.equal(f.context.visualReady, true);
  });

  it('correlates debug snapshot/feed bytes without logging images or accessibility contents', async () => {
    const f = fixture();
    await f.api.captureOnDemandVisual({
      source: 'screen',
      screenScope: 'display',
      screenDisplayId: DISPLAY,
      persistAsset: false,
    });
    f.context.visualInput.mode = 'live-feed';
    await f.api.captureScreenFeed(0);
    assert.deepEqual(
      f.diagnostics.map((log) => log.event),
      ['visual_snapshot_captured', 'visual_frame_sent'],
    );
    const expectedHash = createHash('sha256')
      .update(Buffer.from('fixture-jpeg', 'base64'))
      .digest('hex')
      .slice(0, 16);
    for (const { details } of f.diagnostics) {
      assert.equal(details.frameHash, expectedHash);
      assert.equal(details.displayId, DISPLAY);
      assert.equal(details.width, 1280);
      assert.equal(details.height, 720);
      assert.equal(details.bytes, Buffer.byteLength('fixture-jpeg', 'base64'));
      assert.equal(details.image, undefined);
      assert.equal(details.accessibilityText, undefined);
    }
  });

  it('does not calculate snapshot or feed fingerprints when debug is off', async () => {
    const f = fixture();
    f.context.diagnosticsEnabled = false;
    f.context.createHash = () => {
      throw new Error('Unexpected fingerprint without diagnostics');
    };
    await f.api.captureOnDemandVisual({
      source: 'screen',
      screenScope: 'display',
      screenDisplayId: DISPLAY,
      persistAsset: false,
    });
    assert.equal(f.diagnostics.length, 0);
    f.context.visualInput.mode = 'live-feed';
    await f.api.captureScreenFeed(0);
    assert.equal(f.context.visualReady, true);
    assert.equal(f.diagnostics[0]?.details.frameHash, undefined);
  });

  it('discards a monitor capture after display/topology generation changes', async () => {
    const f = fixture();
    let finish!: () => void;
    f.context.appshotCapture.captureDisplayFrame = () =>
      new Promise((resolve) => {
        finish = () => resolve({ screenshot: image, displayId: DISPLAY });
      });
    const capture = f.api.captureOnDemandVisual({
      source: 'screen',
      screenScope: 'display',
      screenDisplayId: DISPLAY,
      persistAsset: false,
    });
    f.context.visualGeneration++;
    finish();
    await assert.rejects(capture, /stale_visual_capture/);
    assert.equal(f.calls.length, 0);
  });

  it('rejects stale target selection before acquiring any display frame', async () => {
    const f = fixture();
    await assert.rejects(
      f.api.captureOnDemandVisual({
        source: 'screen',
        screenScope: 'display',
        screenDisplayId: OTHER,
        persistAsset: false,
      }),
    );
    assert.equal(f.calls.length, 0);
    assert.equal(
      f.api.sameVisualInput(f.context.visualInput, {
        ...f.context.visualInput,
        screenDisplayId: OTHER,
      }),
      false,
    );
  });

  it('requires AX for the original window tool, but not for Screen Live Feed', () => {
    const f = fixture();
    f.context.permissions.accessibility = 'denied';
    f.context.selfChecks.appshot = false;
    assert.equal(f.api.hostReadinessBlocker(), 'accessibility_permission');
    f.context.visualInput.mode = 'live-feed';
    assert.equal(f.api.hostReadinessBlocker(), undefined);
    f.context.permissions.screenRecording = 'denied';
    assert.equal(f.api.hostReadinessBlocker(), 'screen_recording_permission');
  });

  it('forwards only trusted supported and connected display selections', () => {
    const f = fixture();
    f.api.registerIpc();
    const setDisplay = f.handlers.get('live:set-screen-display')!;
    setDisplay({}, DISPLAY.toUpperCase());
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [
      { kind: 'settings', value: [{ screenDisplayId: DISPLAY }, 1] },
    ]);
    assert.throws(() => setDisplay({}, OTHER));
    assert.throws(() => setDisplay({}, 'window'));
    f.context.isTrustedSender = () => false;
    assert.throws(() => setDisplay({}, 'primary'));
    assert.equal(f.calls.length, 1);
  });
});
