import assert from 'node:assert/strict';
import test from 'node:test';

import {
  latestSemverTag,
  validateRequestedImage,
} from './resolve-sandbox-image.mjs';

test('latestSemverTag returns the highest stable semver tag', () => {
  assert.equal(
    latestSemverTag([
      'latest',
      '0.19',
      '0.19.4',
      '0.19.10',
      '0.20.0-rc.1',
      'sha-abc123',
      '0.20.0',
    ]),
    '0.20.0',
  );
});

test('latestSemverTag ignores non-stable tags', () => {
  assert.equal(latestSemverTag(['latest', '0.19', 'sha-abc123']), undefined);
});

test('validateRequestedImage accepts a configured image', () => {
  assert.equal(
    validateRequestedImage(' ghcr.io/qwenlm/qwen-code:0.1.0 '),
    'ghcr.io/qwenlm/qwen-code:0.1.0',
  );
});

test('validateRequestedImage rejects missing package config output', () => {
  for (const value of [undefined, '', ' ', 'undefined', 'null']) {
    assert.throws(
      () => validateRequestedImage(value),
      /package\.json config\.sandboxImageUri/,
    );
  }
});
