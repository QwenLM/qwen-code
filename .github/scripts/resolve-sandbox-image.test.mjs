import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  latestSemverTag,
  validateRequestedImage,
  exportImage,
  repoDigestOf,
  repoOfImage,
  parsePullDigest,
  pullImage,
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

// async + `return await`: a bare `return fn(stub)` would run the `finally`
// unlink BEFORE the async body's promise settles, racing the spawned child's
// script-open — the parent wins often enough to flake the success path with
// a misleading 'no repository digest' error (probe: 23/30 loops failed).
async function withDockerStub(scriptBody, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-stub-'));
  const stub = join(dir, 'docker-stub');
  try {
    writeFileSync(stub, `#!/bin/sh\n${scriptBody}\n`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    return await fn(stub);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('repoDigestOf resolves a pulled image to its content digest', async () => {
  await withDockerStub(
    "printf '%s\\n' '[\"ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef\"]'",
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

test('withDockerStub keeps the stub alive until the async body settles', async () => {
  // One success-path call per process hides the unlink race above, so drive
  // the spawn→open window in a loop.
  for (let i = 0; i < 30; i++) {
    await withDockerStub(
      "printf '%s\\n' '[\"ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef\"]'",
      async (stub) => {
        assert.equal(
          await repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3'),
          'ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef',
        );
      },
    );
  }
});

test('repoDigestOf refuses an image without a repository digest', async () => {
  // A locally built image has no RepoDigests — `{{json .RepoDigests}}`
  // renders `null`, older daemons print `<no value>`; exporting the mutable
  // tag in either state is exactly what the pin exists to block.
  for (const shape of ['null', '<no value>', '[]']) {
    await withDockerStub(`printf "%s\\n" "${shape}"`, async (stub) => {
      await assert.rejects(
        repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3'),
        /no repository digest/,
      );
    });
  }
});

test('repoDigestOf fails closed when the inspect fails', async () => {
  await withDockerStub('exit 1', async (stub) => {
    await assert.rejects(
      repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3'),
      /no repository digest/,
    );
  });
});

// The exported reference is bound to the digest the PULL itself reported:
// `docker tag` never rewrites digests, so retagged attacker content keeps
// its original repo in RepoDigests (measured live: a tag moved to other
// content resolves to `busybox@sha256:…` and passes the `@sha256:` presence
// check). Only the pulled repo + the pull's own Digest line together tie
// the export to the fetched content (#9214 review).
const GENUINE =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('repoDigestOf refuses content whose repo is not the pulled image', async () => {
  await withDockerStub(
    "printf '%s\\n' '[\"aaa.example/backdoor@sha256:dc2d74b2dc2d74b2dc2d74b2dc2d74b2dc2d74b2dc2d74b2dc2d74b2dc2d74b2\"]'",
    async (stub) => {
      await assert.rejects(
        repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3', GENUINE),
        /none of which is/,
      );
    },
  );
});

test('repoDigestOf accepts the digest the pull reported', async () => {
  await withDockerStub(
    `printf '%s\\n' '["ghcr.io/qwenlm/qwen-code@${GENUINE}"]'`,
    async (stub) => {
      assert.equal(
        await repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3', GENUINE),
        `ghcr.io/qwenlm/qwen-code@${GENUINE}`,
      );
    },
  );
});

test('repoDigestOf keeps the pulled repo when a same-content tag sorts first', async () => {
  // `docker tag` of the SAME content adds an alphabetically-sorted
  // RepoDigests entry for the new name: index 0 moves off the pulled repo
  // while a suffix-only digest check still passes (docker 29.1.3 probe:
  // after `docker tag <pulled> a/a:1`, RepoDigests[0] is `a/a@sha256:…`).
  // The resolver must export the `<repo>@<digest>` entry, not index 0 —
  // every gate consumer's shape regex refuses a foreign repo, so exporting
  // index 0 gate-crashes the autofix loop until a manual `docker rmi`.
  await withDockerStub(
    `printf '%s\\n' '["a/a@${GENUINE}","ghcr.io/qwenlm/qwen-code@${GENUINE}"]'`,
    async (stub) => {
      assert.equal(
        await repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3', GENUINE),
        `ghcr.io/qwenlm/qwen-code@${GENUINE}`,
      );
    },
  );
});

test('repoOfImage strips tag and digest but keeps a registry port', () => {
  assert.equal(
    repoOfImage('ghcr.io/qwenlm/qwen-code:1.2.3'),
    'ghcr.io/qwenlm/qwen-code',
  );
  assert.equal(
    repoOfImage('ghcr.io/qwenlm/qwen-code@sha256:ab'),
    'ghcr.io/qwenlm/qwen-code',
  );
  assert.equal(repoOfImage('registry:5000/img:tag'), 'registry:5000/img');
});

test('parsePullDigest extracts the Digest line from pull output', () => {
  const pullLog = [
    '1.2.3: Pulling from qwenlm/qwen-code',
    `Digest: ${GENUINE}`,
    'Status: Image is up to date for ghcr.io/qwenlm/qwen-code:1.2.3',
    'ghcr.io/qwenlm/qwen-code:1.2.3',
  ].join('\n');
  assert.equal(parsePullDigest(pullLog), GENUINE);
  assert.equal(parsePullDigest('Status: Image is up to date'), '');
  assert.equal(parsePullDigest('Digest: sha256:tooshort'), '');
});

test('pullImage captures the pull-reported digest on success', async () => {
  await withDockerStub(
    `printf "%s\\n" "pulling..." "Digest: ${GENUINE}" "Status: Downloaded"`,
    async (stub) => {
      const result = await pullImage(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3');
      assert.deepEqual(result, { ok: true, digest: GENUINE });
    },
  );
});

test('pullImage reports failure without a digest', async () => {
  await withDockerStub('exit 1', async (stub) => {
    const result = await pullImage(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3');
    assert.deepEqual(result, { ok: false, digest: '' });
  });
});
