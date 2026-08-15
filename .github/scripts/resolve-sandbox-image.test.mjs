import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  latestSemverTag,
  validateRequestedImage,
  exportImage,
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

test('exportImage publishes the resolved image as a step output', () => {
  // The autofix gate reads this output (GATE_IMAGE) to choose the container
  // it runs the branch's build/test in — deliberately NOT $GITHUB_ENV, which
  // an earlier step can append to. An empty output makes the gate wrapper
  // refuse and every round take the gate-crashed retry path, so the write is
  // load-bearing enough to pin.
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-'));
  const outFile = join(dir, 'out');
  const envFile = join(dir, 'env');
  const saved = { out: process.env.GITHUB_OUTPUT, env: process.env.GITHUB_ENV };
  try {
    process.env.GITHUB_OUTPUT = outFile;
    process.env.GITHUB_ENV = envFile;
    exportImage('ghcr.io/qwenlm/qwen-code:1.2.3');
    assert.equal(
      readFileSync(outFile, 'utf8'),
      'image=ghcr.io/qwenlm/qwen-code:1.2.3\n',
    );
    assert.equal(
      readFileSync(envFile, 'utf8'),
      'QWEN_SANDBOX_IMAGE=ghcr.io/qwenlm/qwen-code:1.2.3\n',
    );
  } finally {
    if (saved.out === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = saved.out;
    if (saved.env === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = saved.env;
    rmSync(dir, { recursive: true, force: true });
  }
});
