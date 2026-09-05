import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const audioEngine = readFileSync(
  join(appRoot, 'src', 'preload', 'audio-engine.ts'),
  'utf8',
);

describe('Live Host audio architecture', () => {
  it('matches the Codex virtual microphone graph for capture', () => {
    assert.match(audioEngine, /createMediaStreamDestination\(\)/);
    assert.match(audioEngine, /worklet\.connect\(destination\)/);
    assert.doesNotMatch(audioEngine, /silent\.connect\(context\.destination\)/);
  });

  it('plays provider PCM on the device clock without a second media clock', () => {
    assert.match(
      audioEngine,
      /context\.createBuffer\(1, samples, OUTPUT_SAMPLE_RATE\)/,
    );
    assert.match(audioEngine, /source\.connect\(context\.destination\)/);
    assert.doesNotMatch(audioEngine, /sampleRate: OUTPUT_SAMPLE_RATE/);
    assert.doesNotMatch(audioEngine, /private outputDestination:/);
    assert.doesNotMatch(audioEngine, /private outputStream:/);
    assert.doesNotMatch(audioEngine, /private outputElement:/);
  });

  it('fully releases the device-clock playback context when output is cleared', () => {
    assert.match(audioEngine, /context\?\.close\(\)/);
  });

  it('monitors both initial and replacement input tracks for device loss', () => {
    assert.match(audioEngine, /private monitorInputTracks\(/);
    assert.equal(audioEngine.match(/this\.monitorInputTracks\(/gu)?.length, 2);
    assert.match(
      audioEngine,
      /private async refreshCaptureInput\(\)[\s\S]*const generation = \+\+this\.captureGeneration/u,
    );
  });
});
