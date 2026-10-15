import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { liveMessage } from '@qwen-code/qwen-live/i18n';
import {
  canChangeLiveVisualInput,
  shouldRequestVisualSourceChange,
} from '../live-state-policy.ts';

type Callback = (...args: unknown[]) => unknown;

function fixture() {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'registerIpc',
    'applyPendingVisualSourceChange',
    'visualSourceReady',
    'scheduleReadinessReconnect',
    'cancelReadinessReconnect',
    'beginMediaPermissionMonitor',
    'microphonePermission',
    'cameraPermission',
    'requestCameraPermission',
  ]);
  const declarations = tree.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name &&
        names.has(node.name.text),
    )
    .map((node) => node.getText(tree));
  assert.equal(
    declarations.length,
    names.size,
    'Every real function must be found',
  );
  const ipc = new Map<string, Callback>();
  const calls: Array<{ update: object; epoch: number }> = [];
  const diagnostics: Array<{ event: string; details: object }> = [];
  const flags = { sent: true };
  let reconnects = 0;
  let now = 0;
  type Timer = {
    at: number;
    repeat?: number;
    callback: () => void;
    unref: () => void;
  };
  const timers = new Set<Timer>();
  const timer = (
    callback: () => void,
    milliseconds: number,
    repeat?: number,
  ) => {
    const value = { at: now + milliseconds, repeat, callback, unref() {} };
    timers.add(value);
    return value;
  };
  const context = {
    liveMessage,
    canChangeLiveVisualInput,
    shouldRequestVisualSourceChange,
    isTrustedSender: () => true,
    ipcMain: {
      on: (name: string, callback: Callback) => ipc.set(name, callback),
      handle: (name: string, callback: Callback) => ipc.set(name, callback),
    },
    connection: { phase: 'ready' },
    daemon: {
      getEpoch: () => 7,
      sendVisualSettings: (update: object, epoch: number) => {
        calls.push({ update: JSON.parse(JSON.stringify(update)), epoch });
        return flags.sent;
      },
      reconnectNow: () => {
        reconnects++;
      },
    },
    writeLiveDiagnostic: (event: string, details: object) =>
      diagnostics.push({ event, details: { ...details } }),
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: () => {
        throw new Error('Media prompts are forbidden in this probe');
      },
    },
    appshotReadiness: { refresh() {} },
    setTimeout: timer,
    clearTimeout: (value: Timer) => timers.delete(value),
    setInterval: (callback: () => void, milliseconds: number) =>
      timer(callback, milliseconds, milliseconds),
    clearInterval: (value: Timer) => timers.delete(value),
    publishState: () => undefined,
    sendRendererCommand: () => undefined,
    syncVisualCapture: () => undefined,
    failClosedForReadinessLoss: () => {
      throw new Error('Unexpected readiness loss');
    },
  };
  const script = `
let nativeServicesActive = true, nativeServiceGeneration = 1, quitState;
let readinessReconnectTimer, readinessReconnectReason, mediaPermissionTimer;
let pendingVisualSourceChange, visualSourceChangeGeneration = 0;
const READINESS_RECONNECT_DEBOUNCE_MS = 2500;
const permissions = { microphone: 'denied', camera: 'granted', accessibility: 'granted', screenRecording: 'granted' };
const selfChecks = { audioInput: false, audioOutput: true, globalShortcut: true, appshot: true };
const live = { v: 1, available: true, state: 'listening', callId: 'fixture-call', shortcut: 'Command+E' };
const visualInput = { source: 'screen', mode: 'live-feed' };
${declarations.join('\n')}
registerIpc();
({ beginMediaPermissionMonitor, scheduleReadinessReconnect,
   pending: () => Boolean(readinessReconnectTimer),
   microphone: () => permissions.microphone,
   mode: () => visualInput.mode });
`;
  const controls = runInNewContext(
    ts.transpileModule(script, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as {
    beginMediaPermissionMonitor: () => void;
    scheduleReadinessReconnect: (reason?: 'readiness' | 'visual') => void;
    pending: () => boolean;
    microphone: () => string;
    mode: () => string;
  };
  return {
    controls,
    flags,
    calls,
    diagnostics,
    reconnects: () => reconnects,
    invoke: (name: string, value: unknown) => {
      const handler = ipc.get(name);
      assert(handler);
      return handler({}, value);
    },
    advance: (milliseconds: number) => {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers]
          .filter((value) => value.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        if (next.repeat) next.at += next.repeat;
        else timers.delete(next);
        next.callback();
      }
      now = end;
    },
  };
}

describe('Host visual readiness review regressions', () => {
  it('performs a pending microphone readiness reconnect without a visual change', () => {
    const value = fixture();
    value.controls.beginMediaPermissionMonitor();
    value.advance(2_000);
    assert.equal(value.controls.microphone(), 'granted');
    assert.equal(value.controls.pending(), true);
    value.advance(2_501);
    assert.equal(value.reconnects(), 1);
  });

  it('keeps microphone recovery scheduled when already-granted Camera is selected', async () => {
    const value = fixture();
    value.controls.beginMediaPermissionMonitor();
    value.advance(2_000);
    assert.equal(value.controls.microphone(), 'granted');
    assert.equal(value.controls.pending(), true);
    await value.invoke('live:set-visual-source', 'camera');
    assert.deepEqual(value.calls, [{ update: { source: 'camera' }, epoch: 7 }]);
    value.advance(2_501);
    assert.equal(
      value.reconnects(),
      1,
      'Camera source send must not discard microphone recovery',
    );
  });

  it('cancels a purely visual reconnect after its source update was sent', async () => {
    const value = fixture();
    value.controls.scheduleReadinessReconnect('visual');
    await value.invoke('live:set-visual-source', 'camera');
    value.advance(2_501);
    assert.equal(value.reconnects(), 0);
    assert.equal(value.controls.pending(), false);
    value.controls.scheduleReadinessReconnect();
    value.advance(2_501);
    assert.equal(value.reconnects(), 1);
  });

  for (const reasons of [
    ['readiness', 'visual'],
    ['visual', 'readiness', 'visual'],
  ] as const) {
    it(`does not downgrade the full readiness requirement: ${reasons.join(', ')}`, async () => {
      const value = fixture();
      for (const reason of reasons)
        value.controls.scheduleReadinessReconnect(reason);
      await value.invoke('live:set-visual-source', 'camera');
      value.advance(2_501);
      assert.equal(value.reconnects(), 1);
    });
  }

  it('surfaces a failed visual-mode send to the IPC caller', async () => {
    const value = fixture();
    value.flags.sent = false;
    await assert.rejects(async () =>
      value.invoke('live:set-visual-mode', 'on-demand'),
    );
    assert.deepEqual(value.calls, [
      { update: { mode: 'on-demand' }, epoch: 7 },
    ]);
    assert.equal(value.controls.mode(), 'live-feed');
  });

  it('records a diagnostic for failed visual-mode transport', async () => {
    const value = fixture();
    value.flags.sent = false;
    try {
      await value.invoke('live:set-visual-mode', 'on-demand');
    } catch {
      // The failure is allowed to reject; this case independently checks diagnostics.
    }
    assert.deepEqual(value.calls, [
      { update: { mode: 'on-demand' }, epoch: 7 },
    ]);
    assert.deepEqual(value.diagnostics, [
      {
        event: 'visual_mode_rejected',
        details: { epoch: 7, mode: 'on-demand' },
      },
    ]);
    assert.equal(value.controls.mode(), 'live-feed');
  });

  it('accepts a successful visual-mode send without claiming unacknowledged state', async () => {
    const value = fixture();
    assert.equal(
      await value.invoke('live:set-visual-mode', 'on-demand'),
      undefined,
    );
    assert.deepEqual(value.calls, [
      { update: { mode: 'on-demand' }, epoch: 7 },
    ]);
    assert.equal(value.controls.mode(), 'live-feed');
  });
});
