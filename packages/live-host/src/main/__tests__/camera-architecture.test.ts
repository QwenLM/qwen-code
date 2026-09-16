import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { liveText } from '@qwen-code/qwen-live/i18n';

const CAMERA_ENGINE = new URL(
  '../../preload/camera-engine.ts',
  import.meta.url,
);
const PRELOAD = new URL('../../preload/index.ts', import.meta.url);
const RENDERER = new URL('../../renderer/live-view.ts', import.meta.url);
const MAIN_PROCESS = new URL('../index.ts', import.meta.url);
const BUILDER_CONFIG = new URL(
  '../../../electron-builder.yml',
  import.meta.url,
);
const ENTITLEMENTS = new URL(
  '../../../build/entitlements.mac.plist',
  import.meta.url,
);
const AFTER_PACK = new URL('../../../scripts/after-pack.cjs', import.meta.url);

describe('Live Host visual input architecture', () => {
  it('captures bounded camera JPEG frames without opening another microphone', async () => {
    const source = await readFile(CAMERA_ENGINE, 'utf8');

    assert.match(source, /getUserMedia\(\{[\s\S]*audio: false/u);
    assert.match(source, /width: \{ ideal: requestedWidth \}/u);
    assert.match(source, /height: \{ ideal: requestedHeight \}/u);
    assert.match(source, /LIVE_JPEG_ATTEMPTS/u);
    assert.match(source, /SNAPSHOT_JPEG_QUALITIES/u);
    assert.match(source, /toBlob\(resolve, 'image\/jpeg'/u);
    assert.match(source, /MAX_INPUT_IMAGE_FRAME_BYTES/u);
    assert.match(source, /generation !== this\.generation\) return/u);
  });

  it('keeps visual lifecycle and frame routing in the Host process', async () => {
    const source = await readFile(MAIN_PROCESS, 'utf8');

    assert.match(source, /let visualInput: VisualInput \| undefined/u);
    assert.match(source, /stopLocalVisual\(\)/u);
    assert.match(source, /daemon\.sendVisualFrame/u);
    assert.match(source, /settings\.source !== 'screen'/u);
    assert.match(source, /settings\.mode !== 'live-feed'/u);
    assert.match(source, /live\.callId !== pending\.callId/u);
    assert.match(source, /daemon\.getEpoch\(\) !== pending\.epoch/u);
    assert.match(source, /pendingVisualSourceChange/u);
    assert.match(source, /applyPendingVisualSourceChange\(\)/u);
    assert.match(
      source,
      /if \(snapshot\.phase !== 'ready'\) \{[\s\S]{0,120}stopLocalVisual\(\)/u,
    );
    assert.match(
      source,
      /if \(nextCamera !== 'granted'\) \{[\s\S]{0,160}failClosedForReadinessLoss\(\)/u,
    );
    assert.match(
      source,
      /if \(visualInput\?\.source === 'camera'\) \{[\s\S]{0,80}failClosedForReadinessLoss\(\)/u,
    );
    assert.match(
      source,
      /visualError = nextError;[\s\S]{0,80}appshotReadiness\.refresh\(\)/u,
    );
    assert.match(source, /camera_transport_rejected/u);
    assert.match(source, /generation !== visualGeneration/u);
    assert.match(source, /function dispatchNextCameraSnapshot\(\): void/u);
    assert.match(source, /pending\.sent = true/u);
    assert.match(
      source,
      /function requestCameraSnapshot[\s\S]*const timer = setTimeout[\s\S]*pendingCameraSnapshots\.set\(requestId, \{[\s\S]*timer,/u,
    );
    assert.doesNotMatch(
      source,
      /pending\.sent = true;\s*pending\.timer = setTimeout/u,
    );
    assert.match(source, /request\.persistAsset === false/u);
    assert.match(source, /visual_frame_sent[\s\S]*bytes: Buffer\.byteLength/u);
    assert.doesNotMatch(
      source,
      /writeLiveDiagnostic\('visual_frame_sent',[\s\S]{0,400}image:/u,
    );
  });

  it('reuses the private capture stream for an in-Host live preview', async () => {
    const [camera, preload, renderer] = await Promise.all([
      readFile(CAMERA_ENGINE, 'utf8'),
      readFile(PRELOAD, 'utf8'),
      readFile(RENDERER, 'utf8'),
    ]);

    assert.match(camera, /attachPreview\(\): void/u);
    assert.match(camera, /slot\.replaceChildren\(this\.video\)/u);
    assert.match(
      preload,
      /attachCameraPreview: \(\) => camera\.attachPreview\(\)/u,
    );
    assert.match(renderer, /slot\.dataset\.liveCameraPreview = ''/u);
    assert.match(renderer, /'ui\.cameraBadge'/u);
    assert.equal(
      liveText('en', 'ui.cameraBadge', { mode: 'Local preview' }),
      'Camera · Local preview',
    );
    assert.match(renderer, /shouldShowCameraPreview/u);
    assert.match(renderer, /'ui\.videoSource'/u);
    assert.equal(liveText('en', 'ui.videoSource'), 'Video Source');
    assert.match(renderer, /'ui\.onDemand'/u);
    assert.equal(liveText('en', 'ui.onDemand'), 'On Demand');
    assert.match(renderer, /'ui\.liveFeed'/u);
    assert.equal(liveText('en', 'ui.liveFeed'), 'Live Feed');
    assert.match(renderer, /SettingsPanel/u);
  });

  it('declares the macOS camera purpose and hardened-runtime entitlement', async () => {
    const [builder, entitlements, afterPack] = await Promise.all([
      readFile(BUILDER_CONFIG, 'utf8'),
      readFile(ENTITLEMENTS, 'utf8'),
      readFile(AFTER_PACK, 'utf8'),
    ]);

    assert.match(builder, /NSCameraUsageDescription:/u);
    assert.match(builder, /resetAdHocDarwinSignature: true/u);
    assert.match(entitlements, /com\.apple\.security\.device\.camera/u);
    assert.doesNotMatch(afterPack, /NSCameraUsageDescription/u);
  });
});
