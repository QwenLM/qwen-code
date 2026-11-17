import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as positions from '../overlay-position.ts';
import * as policy from '../live-state-policy.ts';
import { OVERLAY_GEOMETRY } from '../../shared/overlay-geometry.ts';

function fixture() {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    'handleDisplayChange',
    'clampOverlayToDisplays',
    'overlayWorkArea',
    'positionOverlay',
    'dragOverlay',
    'syncPointerInteractivity',
    'captureOnDemandVisual',
  ]);
  const declarations = tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
  );
  assert.equal(declarations.length, names.size);
  const registrations = source.match(
    /^  screen\.on\('display-(?:added|removed|metrics-changed)',[\s\S]*?^  \}\);/gm,
  );
  assert.equal(registrations?.length, 3);
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const bounds = { x: 900, y: 200, width: 384, height: 480 };
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: area,
    scaleFactor: 2,
    rotation: 0,
  };
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const moves: Array<{ x: number; y: number }> = [];
  const saved: Array<{ x: number; y: number }> = [];
  const dragging: boolean[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const counters = { capture: 0, restart: 0, refresh: 0, publish: 0 };
  let finishCapture: (() => void) | undefined;
  const context = {
    ...positions,
    ...policy,
    OVERLAY_GEOMETRY,
    diagnosticsEnabled: false,
    screen: {
      on: (name: string, handler: (...args: unknown[]) => void) =>
        handlers.set(name, handler),
      getDisplayNearestPoint: () => display,
    },
    overlay: {
      isDestroyed: () => false,
      getBounds: () => ({ ...bounds }),
      setPosition: (x: number, y: number) => {
        Object.assign(bounds, { x, y });
        moves.push({ x, y });
      },
      setIgnoreMouseEvents: () => {},
    },
    desiredOverlayPosition: { x: bounds.x, y: bounds.y },
    hasCustomOverlayPosition: true,
    overlayLayout: 'orb',
    overlayOffset: { x: 0, y: 0 },
    overlayDrag: undefined,
    settingsOpen: false,
    pointerInteractive: false,
    pointerOverInteractive: false,
    subagents: {
      displaysChanged: () => {},
      setDragging: (value: boolean) => dragging.push(value),
    },
    appshotCapture: {
      captureDisplayFrame: () => {
        counters.capture++;
        return new Promise((resolve) => {
          finishCapture = () =>
            resolve({
              screenshot: Uint8Array.of(1),
              displayId: 'fixture-display',
            });
        });
      },
    },
    refreshScreenDisplays: () => counters.refresh++,
    stopScreenFeed: () => counters.restart++,
    syncVisualCapture: () => {},
    publishState: () => counters.publish++,
    persistOverlayPosition: (): void => {
      saved.push({ ...context.desiredOverlayPosition });
    },
    sendRendererCommand: () => {},
    writeLiveDiagnostic: (event: string, details: object) =>
      diagnostics.push({ event, ...details }),
    daemon: { getEpoch: () => 1 },
    appshotReadiness: { refresh: () => {} },
    permissions: { screenRecording: 'granted' },
    selfChecks: { appshot: true },
    visualGeneration: 1,
    visualInput: {
      source: 'screen',
      mode: 'on-demand',
      screenDisplayId: 'primary',
    },
    live: { state: 'listening', callId: 'fixture', available: true },
    isHostReady: () => true,
    encodeScreenFrame: () => ({ image: 'fixture', width: 1280, height: 720 }),
    liveMessage: (key: string) => key,
  };
  const code = ts.transpileModule(
    declarations.map((node) => node.getText(tree)).join('\n') +
      '\n' +
      registrations?.join('\n') +
      '\n({ captureOnDemandVisual, dragOverlay });',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const api = runInNewContext(code, context) as {
    captureOnDemandVisual(request: object): Promise<unknown>;
    dragOverlay(phase: 'start' | 'move' | 'end', x: number, y: number): void;
  };
  return {
    api,
    context,
    display,
    area,
    bounds,
    counters,
    moves,
    saved,
    dragging,
    diagnostics,
    finish: () => finishCapture?.(),
    event: (
      name: string,
      changedMetrics?: string[],
      changedDisplay = display,
    ) => handlers.get(name)?.({}, changedDisplay, changedMetrics),
  };
}

describe('native display event isolation', () => {
  it('preserves a pending monitor frame and drag through non-geometric metrics', async () => {
    const f = fixture();
    const frame = f.api.captureOnDemandVisual({
      source: 'screen',
      screenScope: 'display',
      screenDisplayId: 'primary',
      persistAsset: false,
    });
    f.api.dragOverlay('start', 1000, 500);
    f.api.dragOverlay('move', 1010, 510);
    const before = { ...f.bounds };
    f.event('display-metrics-changed', ['colorSpace']);
    f.finish();
    await frame;
    f.api.dragOverlay('move', 1060, 560);
    assert.equal(f.bounds.x, before.x + 50);
    assert.equal(f.bounds.y, before.y + 50);
    assert.equal(f.context.visualGeneration, 1);
    assert.deepEqual(f.counters, {
      capture: 1,
      restart: 0,
      refresh: 0,
      publish: 0,
    });
    assert.deepEqual(f.saved, []);
    assert.deepEqual(f.dragging, [true]);
    assert.equal(
      f.diagnostics.find((log) => log.event === 'native_display_changed')
        ?.geometryChanged,
      false,
    );
  });

  it('ignores empty and unknown metrics without moving a stationary default orb', () => {
    const f = fixture();
    f.context.hasCustomOverlayPosition = false;
    const before = { ...f.bounds };
    f.event('display-metrics-changed', []);
    f.event('display-metrics-changed', ['colorSpace', 'unknown']);
    assert.deepEqual(f.bounds, before);
    assert.deepEqual(f.moves, []);
    assert.deepEqual(f.dragging, []);
    assert.equal(f.context.visualGeneration, 1);
  });

  for (const metric of ['bounds', 'workArea', 'scaleFactor', 'rotation']) {
    it(`invalidates frames conservatively for another display's ${metric} change without interrupting the orb drag`, async () => {
      const f = fixture();
      const frame = f.api.captureOnDemandVisual({
        source: 'screen',
        screenScope: 'display',
        screenDisplayId: 'primary',
        persistAsset: false,
      });
      const rejection = assert.rejects(frame, /stale_visual_capture/);
      f.api.dragOverlay('start', 1000, 500);
      f.api.dragOverlay('move', 1010, 510);
      const before = { ...f.bounds };
      f.event('display-metrics-changed', ['colorSpace', metric], {
        ...f.display,
        id: 2,
        bounds: { ...f.display.bounds, x: 1440 },
        workArea: { ...f.area, x: 1440 },
      });
      f.finish();
      await rejection;
      f.api.dragOverlay('move', 1060, 560);
      assert.equal(f.bounds.x, before.x + 50);
      assert.equal(f.bounds.y, before.y + 50);
      assert.equal(f.context.visualGeneration, 2);
      assert.equal(f.counters.restart, 1);
      assert.deepEqual(f.saved, []);
      assert.deepEqual(f.dragging, [true]);
    });
  }

  for (const event of ['display-added', 'display-removed']) {
    it(`${event} invalidates capture and preserves an already reachable default position`, () => {
      const f = fixture();
      f.context.hasCustomOverlayPosition = false;
      const before = { ...f.bounds };
      f.event(event);
      assert.equal(f.context.visualGeneration, 2);
      assert.equal(f.counters.refresh, 1);
      assert.equal(f.counters.restart, 1);
      assert.deepEqual(f.bounds, before);
      assert.deepEqual(f.moves, []);
      assert.deepEqual(f.dragging, []);
    });
  }

  it('clamps onto the remaining display after removal without overwriting the saved desired location', () => {
    const f = fixture();
    f.api.dragOverlay('start', 1000, 500);
    f.api.dragOverlay('move', 1010, 510);
    const desired = { ...f.context.desiredOverlayPosition };
    f.area.width = 800;
    f.event('display-removed', undefined, { ...f.display, id: 2 });
    const corrected = { ...f.bounds };
    f.api.dragOverlay('move', 1060, 560);
    assert.deepEqual(f.bounds, corrected);
    assert.equal(
      corrected.x +
        OVERLAY_GEOMETRY.bounds.orb.x +
        OVERLAY_GEOMETRY.bounds.orb.width,
      f.area.width,
    );
    assert.deepEqual(f.context.desiredOverlayPosition, desired);
    assert.deepEqual(f.saved, [desired]);
    assert.deepEqual(f.dragging, [true, false]);
    const log = f.diagnostics.at(-1);
    assert.equal(log?.event, 'overlay_position');
    assert.equal(log?.reason, 'display-removed');
    assert.deepEqual(log?.after, corrected);
  });

  it('clamps the compensated logical position without resetting its macOS offset', () => {
    const f = fixture();
    f.bounds.y = 25;
    f.context.overlayOffset.y = -130;
    const before = { ...f.bounds };
    f.event('display-metrics-changed', ['bounds']);
    assert.deepEqual(f.bounds, before);
    assert.equal(f.context.overlayOffset.y, -130);
    assert.deepEqual(f.moves, []);
  });
});
