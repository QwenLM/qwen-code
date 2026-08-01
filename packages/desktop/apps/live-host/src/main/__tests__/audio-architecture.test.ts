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
  it('matches the Codex virtual microphone graph instead of hardware output', () => {
    assert.match(audioEngine, /createMediaStreamDestination\(\)/);
    assert.match(audioEngine, /worklet\.connect\(destination\)/);
    assert.doesNotMatch(audioEngine, /silent\.connect\(context\.destination\)/);
  });

  it('fully releases playback routing when output is cleared', () => {
    assert.match(audioEngine, /outputElement\?\.pause\(\)/);
    assert.match(audioEngine, /outputElement\.srcObject = null/);
    assert.match(audioEngine, /outputStream\?\.getTracks\(\)/);
    assert.match(audioEngine, /context\?\.close\(\)/);
  });
});
