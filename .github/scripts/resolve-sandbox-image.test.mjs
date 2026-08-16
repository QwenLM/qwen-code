import assert from 'node:assert/strict';
import test from 'node:test';

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  latestSemverTag,
  validateRequestedImage,
  exportImage,
  repoDigestOf,
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

function withDockerStub(scriptBody, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-stub-'));
  const stub = join(dir, 'docker-stub');
  try {
    writeFileSync(stub, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    return fn(stub);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('repoDigestOf resolves a pulled image to its content digest', async () => {
  await withDockerStub(
    'printf "%s\\n" "ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef"',
    async (stub) => {
      // The exported reference must be pinned by CONTENT: `docker tag` and
      // `docker build` cannot move a digest reference, while the tag the
      // image was pulled under can be retagged by any co-resident process
      // with daemon access before the gate runs.
      assert.equal(
        await repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3'),
        'ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef',
      );
    },
  );
});

test('repoDigestOf refuses an image without a repository digest', async () => {
  // `<no value>` is what `docker image inspect --format
  // {{index .RepoDigests 0}}` prints for a locally built image; exporting
  // the mutable tag in that state is exactly what the pin exists to block.
  await withDockerStub('printf "%s\\n" "<no value>"', async (stub) => {
    await assert.rejects(
      repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3'),
      /no repository digest/,
    );
  });
});

test('repoDigestOf fails closed when the inspect fails', async () => {
  await withDockerStub('exit 1', async (stub) => {
    await assert.rejects(
      repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3'),
      /no repository digest/,
    );
  });
});
