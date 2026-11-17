import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as positions from '../overlay-position.ts';
import type { HostPublicState } from '../../shared/host-api.ts';
import { OVERLAY_GEOMETRY } from '../../shared/overlay-geometry.ts';
import { StartupInteraction } from '../startup-interaction.ts';
import {
  displayLiveMessage,
  isLiveLanguage,
  liveMessage,
} from '@qwen-code/qwen-live/i18n';
import { canToggleLive, shouldStopLiveOnToggle } from '../live-state-policy.ts';

type Callback = (...args: unknown[]) => unknown;

function fixture(minimumNativeY?: number, diagnosticsEnabled = false) {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'showOverlay',
    'stopLive',
    'createOverlay',
    'isTrustedSender',
    'registerIpc',
    'syncPointerInteractivity',
    'dragOverlay',
    'persistOverlayPosition',
    'clampOverlayToDisplays',
    'resetOverlayInteraction',
    'dismissSettings',
    'quitHost',
    'publicState',
    'resolvedTheme',
    'activateNativeServices',
    'deactivateNativeServices',
    'beginMediaPermissionMonitor',
    'scheduleReadinessReconnect',
    'microphonePermission',
    'cameraPermission',
    'requestCameraPermission',
    'applyOverlayPosition',
    'overlayWorkArea',
    'setOverlayLayout',
    'subagentsAnchor',
    'subagentsHoverRegions',
    'maybeStartStartupInteraction',
    'toggleLive',
    'newConversation',
    'positionOverlay',
    'sendRequiredPlaybackReceipt',
  ]);
  const functions = tree.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name &&
        names.has(node.name.text),
    )
    .map((node) => node.getText(tree))
    .join('\n');
  const ipc = new Map<string, Callback>();
  const area = { x: 0, y: 23, width: 1280, height: 777 };
  const saved: Array<{ x: number; y: number }> = [];
  const stored = {
    position: undefined as { x: number; y: number } | undefined,
  };
  let hidden = 0;
  let quitCalls = 0;
  let quitResolves: (() => void) | undefined;
  let quitRejects: ((error: Error) => void) | undefined;
  const commands: string[] = [];
  const diagnostics: Array<{ event: string; details: object }> = [];
  const states: HostPublicState[] = [];
  const offsets: Array<{ x: number; y: number }> = [];
  const actions: string[] = [];
  const playback: Array<{ kind: string; epoch: number; outputId: number }> = [];
  const flags = { hostReady: false };
  const resources = { audio: false, camera: false, shortcut: false };
  const timers = new Set<object>();
  const grants = new Map<string, (granted: boolean) => void>();
  const timer = () => {
    const value = { unref() {} };
    timers.add(value);
    return value;
  };
  class Window {
    readonly events = new Map<string, Callback>();
    readonly webContents = {
      on: (name: string, callback: Callback) => this.events.set(name, callback),
      setWindowOpenHandler: () => {},
      isDestroyed: () => false,
    };
    readonly ignored: boolean[] = [];
    readonly moves: Array<{ x: number; y: number }> = [];
    constructor(
      readonly options: {
        x?: number;
        y?: number;
        width: number;
        height: number;
      },
    ) {}
    isDestroyed() {
      return false;
    }
    getBounds() {
      return {
        x: this.options.x ?? 40,
        y: this.options.y ?? 80,
        width: this.options.width,
        height: this.options.height,
      };
    }
    setPosition(x: number, y: number) {
      this.options.x = x;
      this.options.y =
        minimumNativeY === undefined ? y : Math.max(minimumNativeY, y);
      this.moves.push({ x, y });
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents(value: boolean) {
      this.ignored.push(value);
    }
    showInactive() {}
    hide() {
      hidden++;
    }
    on(name: string, callback: Callback) {
      this.events.set(name, callback);
    }
    once() {}
    loadFile() {
      return Promise.resolve();
    }
  }
  const context = {
    isLiveLanguage,
    liveMessage,
    language: 'en',
    screenDisplays: [],
    screenDisplaysError: undefined,
    appshotCapture: undefined,
    refreshScreenDisplays: () => {},
    theme: 'system',
    nativeTheme: { shouldUseDarkColors: true },
    subagents: undefined,
    BrowserWindow: Window,
    screen: {
      getCursorScreenPoint: () => ({ x: 400, y: 400 }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getDisplayMatching: () => ({ workArea: area }),
    },
    ipcMain: {
      on: (name: string, fn: Callback) => ipc.set(name, fn),
      handle: (name: string, fn: Callback) => ipc.set(name, fn),
    },
    app: {
      getPath: () => '/fixture',
      quit: () => {
        quitCalls++;
      },
    },
    daemon: {
      getConfigFilePath: () => undefined,
      getEpoch: () => 1,
      sendPlaybackStarted: (epoch: number, outputId: number) => {
        playback.push({ kind: 'started', epoch, outputId });
        return true;
      },
      sendPlaybackCompleted: (epoch: number, outputId: number) => {
        playback.push({ kind: 'completed', epoch, outputId });
        return true;
      },
      requestQuit: () =>
        new Promise<void>((resolve, reject) => {
          quitResolves = resolve;
          quitRejects = reject;
        }),
    },
    connection: { phase: 'ready' },
    OVERLAY_GEOMETRY,
    StartupInteraction,
    canToggleLive,
    shouldStopLiveOnToggle,
    isHostReady: () => flags.hostReady,
    setInterval: timer,
    setTimeout: timer,
    clearInterval: (value: object) => timers.delete(value),
    clearTimeout: (value: object) => timers.delete(value),
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: (permission: string) =>
        new Promise<boolean>((resolve) => grants.set(permission, resolve)),
    },
    shortcut: {
      stop: () => {
        resources.shortcut = false;
      },
    },
    appshotReadiness: { start() {}, stop() {} },
    failClosedForReadinessLoss: () => {},
    failRequiredDaemonMessage: () => {
      throw new Error('Unexpected failed playback receipt');
    },
    shell: {
      openExternal: async () => {
        throw new Error('Unexpected external settings');
      },
    },
    join,
    __dirname: '/fixture',
    ...positions,
    readOverlayPosition: () => stored.position,
    saveOverlayPosition: (_path: string, position: { x: number; y: number }) =>
      saved.push({ x: position.x, y: position.y }),
    writeLiveDiagnostic: (event: string, details: object) =>
      diagnostics.push({ event, details }),
    sendRendererCommand: (channel: string, value?: unknown) => {
      commands.push(channel);
      if (channel === 'live:overlay-offset') {
        const point = value as { x: number; y: number };
        offsets.push({ x: point.x, y: point.y });
      }
      if (channel === 'live:audio:initialize') resources.audio = true;
      if (channel === 'live:audio:deactivate') resources.audio = false;
      if (channel === 'live:camera:deactivate') resources.camera = false;
    },
    stopLocalVisual: () => {
      resources.camera = false;
    },
    stopLocalAudio: () => {},
    closeHostAudioCapture: () => {},
    closeHostInputCapture: () => {},
    sendRequiredAction: (action: { action: string }) => {
      actions.push(action.action);
      return true;
    },
    overlayRecovery: { markReady: () => {}, handleFailure: () => {} },
    isRecoverableOverlayLoadFailure: () => false,
    syncOutputAudioEndMarkerMode: () => {},
    publishState: (): void => {
      states.push(controls.publicState());
      controls.maybeStart();
    },
    effectiveLiveStatus: () => ({
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+E',
    }),
    syncVisualCapture: () => {},
  };
  const script = `let overlay;
let overlayReady = true, rendererEventsEnabled = true, pointerInteractive = false;
let pointerOverInteractive = false, settingsOpen = false, overlayDrag, desiredOverlayPosition;
let hasCustomOverlayPosition = false;
let overlayLayout = 'setup';
let overlayOffset = { x: 0, y: 0 };
let nativeServicesActive = false, nativeServiceGeneration = 0, liveStartPending = false, quitting = false;
let audioTransportFailed = false, captureReadyEpoch, pendingVisualSourceChange;
let visualSourceChangeGeneration = 0, readinessReconnectTimer, readinessReconnectReason, mediaPermissionTimer;
let quitApproved = false, quitOperation, quitState;
let visualInput, visualError, visualReady = false;
const permissions = {}, selfChecks = {};
const startupInteraction = new StartupInteraction();
let live = { v: 1, available: true, state: 'idle', shortcut: 'Command+E' };
const OVERLAY_WIDTH = 384, OVERLAY_HEIGHT = 480, diagnosticsEnabled = ${diagnosticsEnabled}, READINESS_RECONNECT_DEBOUNCE_MS = 2500;
${functions}
registerIpc();
({ create: (ready = true) => { overlay = createOverlay(); if (ready) overlay.events.get('did-finish-load')?.(); return overlay; }, showOverlay, stopLive,
   clamp: () => clampOverlayToDisplays(), quitHost: () => quitHost(), publicState,
   activate: activateNativeServices, maybeStart: maybeStartStartupInteraction, subagentsAnchor, subagentsHoverRegions });`;
  const controls = runInNewContext(
    ts.transpileModule(script, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as {
    create: (ready?: boolean) => Window;
    showOverlay: () => void;
    stopLive: () => void;
    clamp: () => void;
    quitHost: () => Promise<void>;
    publicState: () => HostPublicState;
    activate: () => void;
    maybeStart: () => void;
    subagentsAnchor: () =>
      | { x: number; y: number; width: number; height: number }
      | undefined;
    subagentsHoverRegions: () => Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  };
  return {
    controls,
    ipc,
    stored,
    saved,
    area,
    hidden: () => hidden,
    quitCalls: () => quitCalls,
    finishQuit: () => quitResolves?.(),
    failQuit: () => quitRejects?.(new Error('private transport error')),
    commands,
    diagnostics,
    states,
    offsets,
    actions,
    playback,
    flags,
    connect: () => {
      context.connection = { phase: 'ready' };
    },
    resources,
    timers,
    grants,
    disconnect: () => {
      context.connection = { phase: 'disconnected' };
    },
  };
}

describe('native overlay interaction', () => {
  it('logs current native window movement only in debug mode without repositioning it', () => {
    const quiet = fixture();
    const quietWindow = quiet.controls.create();
    quiet.diagnostics.length = 0;
    quietWindow.events.get('move')?.();
    assert.equal(quiet.diagnostics.length, 0);

    const host = fixture(undefined, true);
    const previous = host.controls.create();
    const window = host.controls.create();
    host.diagnostics.length = 0;
    const moves = window.moves.length;
    previous.events.get('move')?.();
    assert.equal(host.diagnostics.length, 0);
    window.events.get('move')?.();
    assert.equal(window.moves.length, moves);
    assert.equal(host.diagnostics.length, 1);
    const log = host.diagnostics[0];
    assert.equal(log?.event, 'overlay_native_moved');
    assert.deepEqual(JSON.parse(JSON.stringify(log?.details)), {
      bounds: window.getBounds(),
      offset: { x: 0, y: 0 },
    });
  });

  it('accepts playback receipts only from the current ready renderer with valid epoch and output identity', () => {
    const host = fixture();
    const window = host.controls.create(false);
    const event = { sender: window.webContents };
    const receipt = { epoch: 1, outputId: 7 };
    for (const channel of [
      'live:audio:playback-started',
      'live:audio:playback-completed',
    ]) {
      const handle = host.ipc.get(channel)!;
      handle(event, receipt);
      assert.equal(host.playback.length, 0);
    }
    window.events.get('did-finish-load')?.();
    for (const channel of [
      'live:audio:playback-started',
      'live:audio:playback-completed',
    ]) {
      const handle = host.ipc.get(channel)!;
      handle({ sender: {} }, receipt);
      for (const invalid of [
        null,
        1,
        { epoch: 0, outputId: 7 },
        { epoch: 1, outputId: -1 },
        { epoch: 1, outputId: 1.5 },
        { epoch: 1 },
      ])
        handle(event, invalid);
    }
    assert.equal(host.playback.length, 0);
    host.ipc.get('live:audio:playback-started')!(event, receipt);
    host.ipc.get('live:audio:playback-completed')!(event, receipt);
    assert.deepEqual(host.playback, [
      { kind: 'started', epoch: 1, outputId: 7 },
      { kind: 'completed', epoch: 1, outputId: 7 },
    ]);
    host.controls.create();
    host.ipc.get('live:audio:playback-started')!(event, receipt);
    assert.equal(host.playback.length, 2);
  });

  it('places both first-run layouts at bottom-right with margins and retains a later drag', () => {
    const host = fixture();
    const window = host.controls.create();
    const event = { sender: window.webContents };
    const layout = host.ipc.get('live:overlay-layout')!;
    const margins = (visible: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => {
      const bounds = window.getBounds();
      return {
        right:
          host.area.x + host.area.width - bounds.x - visible.x - visible.width,
        bottom:
          host.area.y +
          host.area.height -
          bounds.y -
          visible.y -
          visible.height,
      };
    };
    assert.deepEqual(margins(OVERLAY_GEOMETRY.bounds.setup), {
      right: 20,
      bottom: 20,
    });
    layout(event, 'orb');
    assert.deepEqual(margins(OVERLAY_GEOMETRY.bounds.orb), {
      right: 20,
      bottom: 20,
    });
    const anchor = host.controls.subagentsAnchor();
    assert(anchor);
    assert.equal(anchor.width, OVERLAY_GEOMETRY.bounds.orb.width);
    assert(anchor.x <= window.getBounds().x + OVERLAY_GEOMETRY.status.x);
    assert(
      anchor.x + anchor.width >=
        window.getBounds().x +
          OVERLAY_GEOMETRY.status.x +
          OVERLAY_GEOMETRY.status.width,
    );
    assert(
      anchor.y + anchor.height >=
        window.getBounds().y +
          OVERLAY_GEOMETRY.status.y +
          OVERLAY_GEOMETRY.status.height,
    );
    assert.equal(host.controls.subagentsHoverRegions().length, 3);
    const blank = {
      x: window.getBounds().x + 190,
      y: window.getBounds().y + 220,
    };
    assert(
      !host.controls
        .subagentsHoverRegions()
        .some(
          (r) =>
            blank.x >= r.x &&
            blank.x <= r.x + r.width &&
            blank.y >= r.y &&
            blank.y <= r.y + r.height,
        ),
    );
    const drag = host.ipc.get('live:drag-overlay')!;
    drag(event, 'start', 1000, 700);
    drag(event, 'end', 900, 650);
    const dragged = window.getBounds();
    host.ipc.get('live:settings-open')!(event, true);
    host.ipc.get('live:settings-open')!(event, false);
    assert.deepEqual(window.getBounds(), dragged);
    const replacement = host.controls.create();
    layout({ sender: replacement.webContents }, 'orb');
    assert.deepEqual(replacement.getBounds(), dragged);
  });

  it('does not reposition the window on show/state refresh and does not hide on stop', () => {
    const host = fixture();
    const window = host.controls.create();
    const initial = window.getBounds();
    host.controls.showOverlay();
    host.controls.showOverlay();
    assert.deepEqual(window.getBounds(), initial);
    assert.equal(window.moves.length, 0);
    host.controls.stopLive();
    assert.equal(host.hidden(), 0);
    assert.equal(window.options.height, 480);
  });

  it('restores the dragged bottom-right position after native re-show clamps the canvas', () => {
    const host = fixture();
    const window = host.controls.create();
    const event = { sender: window.webContents };
    const layout = host.ipc.get('live:overlay-layout')!;
    layout(event, 'orb');
    const drag = host.ipc.get('live:drag-overlay')!;
    drag(event, 'start', 1000, 700);
    drag(event, 'end', 1100, 800);
    const desired = { x: 956, y: 326 };
    const before = window.getBounds();
    assert.deepEqual({ x: before.x, y: before.y }, desired);
    assert.deepEqual(host.saved, [desired]);
    const moves = window.moves.length;
    host.controls.showOverlay();
    assert.equal(window.moves.length, moves);

    window.hide();
    window.showInactive = () => {
      window.options.x = 896;
      window.options.y = 320;
    };
    host.controls.showOverlay();
    assert.deepEqual(window.getBounds(), before);
    assert.equal(window.moves.length, moves + 1);
    assert.deepEqual(window.moves.at(-1), desired);
    assert.equal(host.controls.publicState().overlayOffset?.x, 0);
    assert.equal(host.controls.publicState().overlayOffset?.y, 0);
    assert.deepEqual(host.saved, [desired]);
    const replacement = host.controls.create();
    layout({ sender: replacement.webContents }, 'orb');
    assert.deepEqual(replacement.getBounds(), before);
    assert.deepEqual(host.saved, [desired]);
  });

  it('preserves an existing native offset and saved drag position when re-show clamps another edge', () => {
    const host = fixture(33);
    host.area.y = 33;
    host.stored.position = { x: 956, y: -97 };
    const window = host.controls.create();
    const event = { sender: window.webContents };
    const layout = host.ipc.get('live:overlay-layout')!;
    layout(event, 'orb');
    const drag = host.ipc.get('live:drag-overlay')!;
    drag(event, 'start', 292, 255);
    drag(event, 'end', 292, 265);
    const desired = { x: 956, y: -87 };
    const before = window.getBounds();
    assert.equal(before.y, 33);
    assert.equal(host.controls.publicState().overlayOffset?.y, -120);
    assert.deepEqual(host.saved, [desired]);
    const moves = window.moves.length;
    const offsets = host.offsets.length;
    host.controls.showOverlay();
    assert.equal(window.moves.length, moves);
    assert.equal(host.offsets.length, offsets);

    window.hide();
    window.showInactive = () => {
      window.options.x = 896;
    };
    host.controls.showOverlay();
    assert.deepEqual(window.getBounds(), before);
    assert.equal(window.moves.length, moves + 1);
    assert.deepEqual(window.moves.at(-1), desired);
    assert.equal(host.controls.publicState().overlayOffset?.x, 0);
    assert.equal(host.controls.publicState().overlayOffset?.y, -120);
    assert.deepEqual(host.saved, [desired]);
    const replacement = host.controls.create();
    layout({ sender: replacement.webContents }, 'orb');
    assert.deepEqual(replacement.getBounds(), before);
    assert.equal(host.controls.publicState().overlayOffset?.y, -120);
    assert.deepEqual(host.saved, [desired]);
  });

  it('resets the pointer cache before accepting events from a replacement window', () => {
    const host = fixture();
    const first = host.controls.create();
    const pointer = host.ipc.get('live:pointer-interactivity');
    assert(pointer);
    pointer({ sender: first.webContents }, true);
    const replacement = host.controls.create();
    pointer({ sender: first.webContents }, true);
    assert.equal(replacement.ignored.at(-1), true);
    pointer({ sender: replacement.webContents }, true);
    assert.equal(replacement.ignored.at(-1), false);
  });

  it('restores a saved position and accepts only bounded drag messages from its renderer', () => {
    const host = fixture();
    host.stored.position = { x: 100, y: 200 };
    const window = host.controls.create();
    assert.equal(window.getBounds().x, 100);
    const drag = host.ipc.get('live:drag-overlay');
    assert(drag);
    drag({ sender: {} }, 'start', 300, 300);
    drag({ sender: window.webContents }, 'move', 350, 350);
    assert.equal(window.moves.length, 0);
    drag({ sender: window.webContents }, 'start', NaN, 300);
    drag({ sender: window.webContents }, 'move', 350, 350);
    assert.equal(window.moves.length, 0);
    drag({ sender: window.webContents }, 'start', 300, 300);
    drag({ sender: window.webContents }, 'move', 350, 350);
    drag({ sender: window.webContents }, 'end', 350, 350);
    assert.equal(window.getBounds().x, 150);
    assert.equal(window.getBounds().y, 250);
    assert.deepEqual(host.saved.at(-1), { x: 150, y: 250 });
    host.area.width = 400;
    host.controls.clamp();
    assert.equal(window.getBounds().x, 16);
  });

  it('waits for the single graceful daemon quit before exiting Host', async () => {
    const host = fixture();
    host.controls.create();
    const first = host.controls.quitHost();
    const second = host.controls.quitHost();
    assert.equal(first, second);
    assert.equal(host.quitCalls(), 0);
    host.finishQuit();
    await first;
    assert.equal(host.quitCalls(), 1);
  });

  it('keeps Host alive after a failed daemon quit and allows a safe retry', async () => {
    const host = fixture();
    const window = host.controls.create();
    const quit = host.ipc.get('live:quit');
    assert(quit);
    assert.throws(
      () => quit({ sender: {} }),
      (error: Error) =>
        /Untrusted/.test(displayLiveMessage('en', error.message)),
    );
    const failed = host.controls.quitHost();
    host.failQuit();
    await assert.rejects(failed, (error: Error) =>
      /Could not shut down Qwen Live/.test(
        displayLiveMessage('en', error.message),
      ),
    );
    assert.equal(host.quitCalls(), 0);
    const retry = quit({ sender: window.webContents });
    host.finishQuit();
    await retry;
    assert.equal(host.quitCalls(), 1);
  });

  it('publishes native Quit pending and failed state independently of daemon connection snapshots', async () => {
    const host = fixture();
    const window = host.controls.create();
    host.states.length = 0;
    assert.equal(host.controls.publicState().quitState, undefined);
    const first = host.controls.quitHost();
    assert.equal(host.states.at(-1)?.quitState, 'pending');
    host.disconnect();
    assert.equal(host.controls.publicState().quitState, 'pending');
    host.failQuit();
    await assert.rejects(first, (error: Error) =>
      /Could not shut down/.test(displayLiveMessage('en', error.message)),
    );
    assert.equal(host.states.at(-1)?.quitState, 'failed');
    assert.equal(host.quitCalls(), 0);
    const retry = host.ipc.get('live:quit')?.({ sender: window.webContents });
    assert.equal(host.states.at(-1)?.quitState, 'pending');
    host.finishQuit();
    await retry;
    assert.deepEqual(
      host.states.map((state) => state.quitState),
      ['pending', 'failed', 'pending'],
    );
    assert.equal(host.quitCalls(), 1);
  });

  it('stops local media, permissions polling and shortcuts before waiting for daemon Quit and does not restart on failure or retry', async () => {
    const host = fixture();
    host.controls.create();
    host.controls.activate();
    host.resources.camera = host.resources.shortcut = true;
    assert.equal(host.resources.audio, true);
    assert.equal(host.timers.size, 1);
    const first = host.controls.quitHost();
    assert.deepEqual(host.resources, {
      audio: false,
      camera: false,
      shortcut: false,
    });
    assert.equal(host.timers.size, 0);
    assert.equal(host.controls.quitHost(), first);
    host.controls.activate();
    assert.equal(host.resources.audio, false);
    host.failQuit();
    await assert.rejects(first, (error: Error) =>
      /Could not shut down/.test(displayLiveMessage('en', error.message)),
    );
    host.controls.activate();
    assert.equal(host.resources.audio, false);
    const retry = host.controls.quitHost();
    host.finishQuit();
    await retry;
    assert.equal(
      host.commands.filter((value) => value === 'live:audio:initialize').length,
      1,
    );
  });

  it('discards late microphone and camera grants across pending and failed Quit', async () => {
    const host = fixture();
    const window = host.controls.create();
    host.controls.activate();
    const request = host.ipc.get('live:request-permission');
    assert(request);
    const microphone = request({ sender: window.webContents }, 'microphone');
    const camera = request({ sender: window.webContents }, 'camera');
    const quit = host.controls.quitHost();
    const before = host.commands.length;
    host.grants.get('microphone')?.(true);
    await microphone;
    host.failQuit();
    await assert.rejects(quit, (error: Error) =>
      /Could not shut down/.test(displayLiveMessage('en', error.message)),
    );
    host.grants.get('camera')?.(true);
    await camera;
    assert.equal(
      host.commands.slice(before).includes('live:audio:initialize'),
      false,
    );
    assert.equal(
      host.controls.publicState().permissions.camera,
      'not_determined',
    );
    assert.equal(host.resources.audio, false);
    assert.equal(host.timers.size, 0);
  });

  it('dismisses settings on current-window blur without accepting stale-window blur', () => {
    const host = fixture();
    const previous = host.controls.create();
    const window = host.controls.create();
    host.commands.length = 0;
    const settings = host.ipc.get('live:settings-open');
    assert(settings);
    settings({ sender: window.webContents }, true);
    assert.equal(window.ignored.at(-1), false);
    previous.events.get('blur')?.();
    assert.deepEqual(host.commands, []);
    window.events.get('blur')?.();
    assert.deepEqual(host.commands, ['live:settings-dismiss']);
    assert.equal(window.ignored.at(-1), true);
  });

  it('uses compact bounds at edges and restores desired position after settings and preview clamps', () => {
    const host = fixture();
    host.stored.position = { x: 956, y: -100 };
    const window = host.controls.create();
    const event = { sender: window.webContents };
    const layout = host.ipc.get('live:overlay-layout')!;
    const settings = host.ipc.get('live:settings-open')!;
    assert.equal(window.getBounds().x, 896);
    layout(event, 'orb');
    assert.equal(window.getBounds().x, 956);
    assert.equal(window.getBounds().y, -100);
    settings(event, true);
    assert.equal(window.getBounds().x, 896);
    assert.equal(window.getBounds().y, 23);
    settings(event, false);
    assert.equal(window.getBounds().x, 956);
    assert.equal(window.getBounds().y, -100);
    layout(event, 'orb-preview');
    assert.equal(window.getBounds().y, 1);
    layout(event, 'orb');
    assert.equal(window.getBounds().y, -100);
    assert.deepEqual(host.saved, []);
    const recreated = host.controls.create();
    layout({ sender: recreated.webContents }, 'orb');
    assert.equal(recreated.getBounds().y, -100);
    assert.equal(recreated.getBounds().x, 956);
  });

  it('accepts an initial layout before renderer ready and rejects malformed or foreign layout changes', () => {
    const host = fixture();
    host.stored.position = { x: 956, y: -100 };
    const window = host.controls.create(false);
    const layout = host.ipc.get('live:overlay-layout')!;
    layout({ sender: window.webContents }, 'orb');
    assert.equal(window.getBounds().x, 896);
    window.events.get('did-finish-load')?.();
    assert.equal(window.getBounds().x, 956);
    layout({ sender: {} }, 'setup');
    layout({ sender: window.webContents }, 'unexpected');
    assert.equal(window.getBounds().x, 956);
    assert.deepEqual(host.saved, []);
  });

  it('starts once only after readiness, and explicit stop prevents restart after reconnect', () => {
    const host = fixture();
    host.disconnect();
    host.controls.create();
    host.flags.hostReady = true;
    host.controls.maybeStart();
    assert.deepEqual(host.actions, []);
    host.connect();
    host.flags.hostReady = false;
    host.controls.maybeStart();
    assert.deepEqual(host.actions, []);
    host.flags.hostReady = true;
    host.controls.maybeStart();
    host.controls.maybeStart();
    assert.deepEqual(host.actions, ['toggle']);
    host.controls.stopLive();
    host.disconnect();
    host.connect();
    host.controls.maybeStart();
    assert.deepEqual(host.actions, ['toggle', 'stop']);
  });

  it('compensates macOS top clamping and keeps drag deltas, settings and reload on the same logical position', () => {
    const host = fixture(33);
    host.area.y = 33;
    host.stored.position = { x: 100, y: -97 };
    const window = host.controls.create();
    const event = { sender: window.webContents };
    host.ipc.get('live:overlay-layout')!(event, 'orb');
    assert.equal(window.getBounds().y, 33);
    assert.equal(host.controls.publicState().overlayOffset?.y, -130);
    const drag = host.ipc.get('live:drag-overlay')!;
    drag(event, 'start', 292, 255);
    drag(event, 'move', 292, 265);
    drag(event, 'end', 292, 265);
    assert.equal(window.getBounds().y, 33);
    assert.equal(host.controls.publicState().overlayOffset?.y, -120);
    assert.equal(host.saved.at(-1)?.y, -87);
    host.ipc.get('live:settings-open')!(event, true);
    assert.equal(host.controls.publicState().overlayOffset?.y, 0);
    host.ipc.get('live:settings-open')!(event, false);
    assert.equal(host.controls.publicState().overlayOffset?.y, -120);
    assert.equal(host.saved.at(-1)?.y, -87);
    window.events.get('did-start-loading')?.();
    window.events.get('did-finish-load')?.();
    assert.equal(host.controls.publicState().overlayOffset?.y, -120);
    assert.equal(host.offsets.at(-1)?.y, -120);
  });
});
