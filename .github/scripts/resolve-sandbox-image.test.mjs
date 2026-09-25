import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  latestSemverTag,
  validateRequestedImage,
  exportImage,
  repoDigestOf,
  repoOfImage,
  parsePullDigest,
  pullImage,
  sandboxSpawnEnv,
  appendStepFile,
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

// The resolver's invocation contract shared by the e2e pins below — arg
// passing plus the three env names the export depends on. One copy, so a
// contract change cannot update one test and leave the other green (#9527
// review).
function runResolver(stub) {
  const envFile = join(dirname(stub), 'env');
  const outFile = join(dirname(stub), 'out');
  const scriptPath = fileURLToPath(
    new URL('./resolve-sandbox-image.mjs', import.meta.url),
  );
  execFileSync(
    process.execPath,
    [scriptPath, 'ghcr.io/qwenlm/qwen-code:1.2.3'],
    {
      env: {
        ...process.env,
        SANDBOX_COMMAND: stub,
        GITHUB_ENV: envFile,
        GITHUB_OUTPUT: outFile,
      },
      timeout: 15_000,
      stdio: 'pipe',
    },
  );
  return { envFile, outFile };
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
        await repoDigestOf(
          stub,
          'ghcr.io/qwenlm/qwen-code:1.2.3',
          'sha256:0123456789abcdef',
        ),
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
          await repoDigestOf(
            stub,
            'ghcr.io/qwenlm/qwen-code:1.2.3',
            'sha256:0123456789abcdef',
          ),
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
        repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3', GENUINE),
        /no repository digest/,
      );
    });
  }
});

test('repoDigestOf fails closed when the inspect fails', async () => {
  await withDockerStub('exit 1', async (stub) => {
    await assert.rejects(
      repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3', GENUINE),
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

test('repoDigestOf matches Docker Hub canonical short-form RepoDigests', async () => {
  // docker records Hub repos in canonical short form — a pull of
  // docker.io/library/busybox:stable stores RepoDigests as busybox@sha256:…
  // (measured live, docker 24.0.9) — so the match must fold the same
  // prefixes or a fully-qualified Hub reference fails closed on its own
  // correct digest.
  for (const requested of [
    'docker.io/library/busybox:stable',
    'docker.io/busybox:stable',
  ]) {
    await withDockerStub(
      `printf '%s\\n' '["busybox@${GENUINE}"]'`,
      async (stub) => {
        assert.equal(
          await repoDigestOf(stub, requested, GENUINE),
          `busybox@${GENUINE}`,
        );
      },
    );
  }
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

test('sandboxSpawnEnv pins the daemon endpoint against both override routes', () => {
  // DOCKER_HOST outranks everything and DOCKER_CONTEXT='' falls through to
  // `currentContext` in the pool-shared config.json, so clearing is not
  // enough: the context must be NAMED and DOCKER_HOST must be gone.
  const env = sandboxSpawnEnv({
    PATH: '/usr/bin',
    DOCKER_HOST: 'tcp://attacker.invalid:2375',
    DOCKER_CONTEXT: '',
  });
  assert.equal(env.DOCKER_CONTEXT, 'default');
  assert.ok(!('DOCKER_HOST' in env), 'DOCKER_HOST must not reach the child');
  assert.equal(env.PATH, '/usr/bin');
  // A hostile context NAME must not survive either.
  assert.equal(
    sandboxSpawnEnv({ DOCKER_CONTEXT: 'rogue' }).DOCKER_CONTEXT,
    'default',
  );
  // process.env is the default source and must not be mutated.
  process.env.DOCKER_HOST = 'tcp://attacker.invalid:2375';
  try {
    assert.ok(!('DOCKER_HOST' in sandboxSpawnEnv()));
    assert.equal(process.env.DOCKER_HOST, 'tcp://attacker.invalid:2375');
  } finally {
    delete process.env.DOCKER_HOST;
  }
});

test('the inspect runs against the pinned endpoint too', async () => {
  // The env pin has to be on BOTH spawns: an inspect answered by a daemon
  // someone else controls hands back any digest it likes, and the pull's own
  // Digest line is then compared against attacker-chosen RepoDigests.
  process.env.DOCKER_HOST = 'tcp://attacker.invalid:2375';
  process.env.DOCKER_CONTEXT = 'rogue';
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-inspect-env-'));
  const sink = join(dir, 'env.txt');
  try {
    await withDockerStub(
      `printf "%s\\n" "HOST=[\${DOCKER_HOST-unset}]" "CTX=[\${DOCKER_CONTEXT-unset}]" > ${sink}\n` +
        `printf '%s\\n' '["ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef"]'`,
      async (stub) => {
        assert.equal(
          await repoDigestOf(
            stub,
            'ghcr.io/qwenlm/qwen-code:1.2.3',
            'sha256:0123456789abcdef',
          ),
          'ghcr.io/qwenlm/qwen-code@sha256:0123456789abcdef',
        );
      },
    );
    assert.equal(readFileSync(sink, 'utf8'), 'HOST=[unset]\nCTX=[default]\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DOCKER_HOST;
    delete process.env.DOCKER_CONTEXT;
  }
});

test('the pull runs against the pinned endpoint, not the parent values', async () => {
  process.env.DOCKER_HOST = 'tcp://attacker.invalid:2375';
  process.env.DOCKER_CONTEXT = 'rogue';
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-env-'));
  const sink = join(dir, 'env.txt');
  try {
    await withDockerStub(
      `printf "%s\\n" "HOST=[\${DOCKER_HOST-unset}]" "CTX=[\${DOCKER_CONTEXT-unset}]" > ${sink}`,
      async (stub) => {
        await pullImage(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3');
      },
    );
    assert.equal(readFileSync(sink, 'utf8'), 'HOST=[unset]\nCTX=[default]\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DOCKER_HOST;
    delete process.env.DOCKER_CONTEXT;
  }
});

test('repoDigestOf gives up on an inspect that never returns', async () => {
  // The timeout is the only thing standing between a wedged daemon and the
  // step timeout; without an injectable bound a timer mutant ships green.
  const started = Date.now();
  await withDockerStub('exec sleep 30', async (stub) => {
    await assert.rejects(
      repoDigestOf(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3', GENUINE, 200),
      /no repository digest/,
    );
  });
  assert.ok(
    Date.now() - started < 10_000,
    'the inspect timeout must fire well before the step timeout',
  );
});

test('pullImage accumulates stdout across chunk boundaries', async () => {
  // The Digest line is deliberately split across two writes: a reader that
  // keeps only the latest chunk parses no digest here, while the real pull
  // output (progress lines, then the digest) hides that mutant entirely.
  await withDockerStub(
    `printf "%s" "1.2.3: Pulling from qwenlm/qwen-code\nDigest: "; sleep 0.2; printf "%s\\n" "${'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'}" "Status: Downloaded"`,
    async (stub) => {
      const result = await pullImage(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3');
      assert.deepEqual(result, {
        ok: true,
        digest:
          'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      });
    },
  );
});

test('pullImage gives up on a pull that never returns', async () => {
  // Mirrors the repoDigestOf timeout pin: without an injectable bound a
  // wedged registry holds the step until the job timeout instead of
  // failing closed and taking the fallback path.
  const started = Date.now();
  await withDockerStub('exec sleep 30', async (stub) => {
    assert.deepEqual(
      await pullImage(stub, 'ghcr.io/qwenlm/qwen-code:1.2.3', 200),
      { ok: false, digest: '' },
    );
  });
  assert.ok(
    Date.now() - started < 10_000,
    'the pull timeout must fire well before the step timeout',
  );
});

test('appendStepFile appends to a regular file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-append-'));
  const file = join(dir, 'out.txt');
  try {
    appendStepFile(file, 'a=1\n');
    appendStepFile(file, 'b=2\n');
    assert.equal(readFileSync(file, 'utf8'), 'a=1\nb=2\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendStepFile refuses a planted FIFO instead of blocking on it', () => {
  // $GITHUB_OUTPUT lives under the runner-writable temp tree. A FIFO planted
  // at that path with no reader blocks a plain append until the step timeout;
  // the non-blocking open turns that into an immediate refusal.
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-fifo-'));
  const fifo = join(dir, 'github_output');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return; // no mkfifo on this platform — nothing to assert
  }
  // Drive the append from a child process: a regression to a blocking open
  // would wedge this suite exactly as it wedges the step, and a hung test
  // reports far later and far less clearly than a failed one. `killed` is
  // what separates the two outcomes — the non-blocking open fails on its own
  // with ENXIO, while a blocking open only ever dies from the timeout here.
  const moduleUrl = new URL('./resolve-sandbox-image.mjs', import.meta.url)
    .href;
  const source = `const m = await import(${JSON.stringify(moduleUrl)}); m.appendStepFile(${JSON.stringify(fifo)}, 'image=x\\n');`;
  let error;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      timeout: 5_000,
      stdio: 'pipe',
    });
  } catch (thrown) {
    error = thrown;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(error, 'appending to a FIFO must fail, not succeed');
  assert.notEqual(
    error.killed,
    true,
    'the refusal must be immediate, not a block until the timeout',
  );
  // A blocking open dies with no output at all, so the refusal has to be
  // visible in the child's own words for this to mean anything.
  assert.match(String(error.stderr), /ENXIO|not a regular file/);
});

test('appendStepFile refuses a FIFO whose reader is held open', () => {
  // With a reader already holding the FIFO open, the write-side open
  // SUCCEEDS and only the post-open type check refuses the write — the
  // exact guard the no-reader test never reaches (that one dies in
  // openSync with ENXIO first). Without the check the `image=` line is
  // swallowed by the attacker's reader and the gate sees an empty image.
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-fifo-reader-'));
  const fifo = join(dir, 'github_output');
  let reader;
  try {
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this platform — nothing to assert
    }
    reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    assert.throws(
      () => appendStepFile(fifo, 'image=x\n'),
      /not a regular file/,
    );
  } finally {
    if (reader !== undefined) closeSync(reader);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendStepFile refuses a directory at the step-file path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-image-dir-'));
  try {
    assert.throws(() => appendStepFile(dir, 'image=x\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the resolver refuses to export when the pull reports no Digest line', async () => {
  // End-to-end pin of main()'s headline refusal: pull exits 0 without a
  // Digest line while inspect happily reports a same-repo digest — the shape
  // an attacker-retagged image presents. The resolver must exit non-zero and
  // leave BOTH step files untouched; deleting the refusal exports the
  // unbound content (mutant probe in the #9527 review).
  await withDockerStub(
    [
      'if [ "$1" = "pull" ]; then',
      "  printf '%s\\n' 'Status: Downloaded newer image'",
      '  exit 0',
      'fi',
      `printf '%s\\n' '["ghcr.io/qwenlm/qwen-code@${GENUINE}"]'`,
    ].join('\n'),
    (stub) => {
      const envFile = join(dirname(stub), 'env');
      const outFile = join(dirname(stub), 'out');
      let error;
      try {
        runResolver(stub);
      } catch (thrown) {
        error = thrown;
      }
      assert.ok(error, 'the resolver must exit non-zero');
      assert.match(String(error.stderr), /reported no Digest line/);
      // The untouched-file checks must run BEFORE the helper's cleanup
      // deletes the dir — after it they can never see what the resolver
      // wrote (#9527 review).
      assert.equal(
        existsSync(envFile),
        false,
        'GITHUB_ENV must stay untouched',
      );
      assert.equal(
        existsSync(outFile),
        false,
        'GITHUB_OUTPUT must stay untouched',
      );
    },
  );
});

test('the resolver exports the digest-bound reference on the success path', async () => {
  // Success-path companion to the refusal pin above: with a genuine Digest
  // line and matching RepoDigests, BOTH step files must carry the
  // `<repo>@<digest>` reference, never the mutable tag. A regression to
  // exporting the requested tag ships the exact vulnerability class this
  // PR closes and must fail here — the suite stayed green for that mutant
  // until this test existed (#9527 review).
  await withDockerStub(
    [
      'if [ "$1" = "pull" ]; then',
      `  printf '%s\\n' 'Status: Downloaded newer image' 'Digest: ${GENUINE}'`,
      '  exit 0',
      'fi',
      `printf '%s\\n' '["ghcr.io/qwenlm/qwen-code@${GENUINE}"]'`,
    ].join('\n'),
    (stub) => {
      const expected = `ghcr.io/qwenlm/qwen-code@${GENUINE}`;
      const { envFile, outFile } = runResolver(stub);
      assert.equal(
        readFileSync(envFile, 'utf8'),
        `QWEN_SANDBOX_IMAGE=${expected}\n`,
      );
      assert.equal(readFileSync(outFile, 'utf8'), `image=${expected}\n`);
    },
  );
});

function checkWorkflowSandboxBindings(name, doc) {
  let totalConsumers = 0;
  for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
    const steps = job.steps ?? [];
    const consumers = steps.filter(
      (step) =>
        (typeof step.run === 'string' &&
          step.run.includes('QWEN_SANDBOX_IMAGE')) ||
        (typeof step.env?.SETTINGS_JSON === 'string' &&
          step.env.SETTINGS_JSON.includes('"sandbox": "docker"')),
    );
    if (consumers.length === 0) continue;
    totalConsumers += consumers.length;
    const resolvers = steps.filter(
      (step) =>
        typeof step.run === 'string' &&
        step.run.includes('resolve-sandbox-image.mjs'),
    );
    assert.ok(
      resolvers.length > 0,
      `${name} job '${jobName}': consumes the sandbox image but has no resolver step`,
    );
    for (const resolver of resolvers) {
      assert.ok(
        resolver.id,
        `${name} job '${jobName}': the resolver step needs an id so its image output is addressable`,
      );
      // The export is derived from this binary's stdout: an unpinned
      // SANDBOX_COMMAND (or the bare `docker` default) is steerable
      // through the same $GITHUB_ENV-append channel the DOCKER_HOST pin
      // closes, and a PATH shadow in the runner-writable qwen-bin dir
      // defeats a bare-name pin — so step env must bind an absolute
      // path (#9527 review).
      assert.equal(
        resolver.env?.SANDBOX_COMMAND,
        '/usr/bin/docker',
        `${name} job '${jobName}': pin SANDBOX_COMMAND to an absolute docker path so neither an appended $GITHUB_ENV value nor a $GITHUB_PATH shadow can steer the exported digest`,
      );
    }
    const bindings = resolvers.map(
      (resolver) => `\${{ steps.${resolver.id}.outputs.image }}`,
    );
    for (const step of consumers) {
      assert.ok(
        bindings.includes(step.env?.QWEN_SANDBOX_IMAGE),
        `${name} job '${jobName}' step '${step.name}': bind QWEN_SANDBOX_IMAGE to the resolver step output, not the appendable $GITHUB_ENV value`,
      );
      // The digest-bound reference is only as strong as the daemon that
      // resolves it: a DOCKER_HOST appended to $GITHUB_ENV (or a rewritten
      // currentContext in the pool-shared $DOCKER_CONFIG/config.json)
      // steers the sandbox this step spawns unless the step env pins the
      // endpoint the same way the resolver's own spawns do (#9527 review).
      assert.equal(
        step.env?.DOCKER_HOST,
        '',
        `${name} job '${jobName}' step '${step.name}': set DOCKER_HOST to '' so step env outranks an appended value (the docker CLI skips an empty value)`,
      );
      assert.equal(
        step.env?.DOCKER_CONTEXT,
        'default',
        `${name} job '${jobName}' step '${step.name}': pin DOCKER_CONTEXT so the pool-shared currentContext cannot steer the docker endpoint`,
      );
      // always() and failure() can both run a consumer when the resolver
      // FAILED, and its image binding is then empty — an empty
      // QWEN_SANDBOX_IMAGE relaunches the CLI without any sandbox, so such
      // a consumer must also gate on the resolver's outcome to fail closed
      // (#9527 review).
      if (/always\(\)|failure\(\)/.test(String(step.if ?? ''))) {
        assert.ok(
          resolvers.some((resolver) =>
            String(step.if).includes(
              `steps.${resolver.id}.outcome == 'success'`,
            ),
          ),
          `${name} job '${jobName}' step '${step.name}': a consumer that can run after a resolver failure must also gate on the resolver step outcome`,
        );
      }
    }
  }
  assert.ok(
    totalConsumers > 0,
    `${name}: no sandbox consumers detected — the contract test would pass vacuously`,
  );
}

// Workflow contract: the resolver's step OUTPUT is the value every agent and
// gate must consume — $GITHUB_ENV is appendable by later steps, so a consumer
// that inherits QWEN_SANDBOX_IMAGE from it can be steered after resolution.
// Every 'Resolve sandbox image' step must therefore carry an id, and every
// sandbox-consuming step in the job must bind that step's image output.
// The protected set is DERIVED from the tree — every workflow with a step
// that runs the resolver — so a new resolver step cannot land untested
// (#9527 review).
test('every sandbox-image consumer binds the resolver step output', () => {
  const workflowsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'workflows',
  );
  const workflows = readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({
      name,
      doc: parse(readFileSync(join(workflowsDir, name), 'utf8')),
    }))
    .filter(({ doc }) =>
      Object.values(doc?.jobs ?? {}).some((job) =>
        (job.steps ?? []).some(
          (step) =>
            typeof step.run === 'string' &&
            step.run.includes('resolve-sandbox-image.mjs'),
        ),
      ),
    );
  // repo-hygiene.yml runs the same resolver/consumer shape and needs the
  // same binding, but it is outside this PR's footprint and the gate rejects
  // the change here; it is tracked in the deferred review findings queue
  // (#9527). Remove it from this set once that binding lands.
  const UNBOUND_WORKFLOWS = ['repo-hygiene.yml'];
  for (const name of UNBOUND_WORKFLOWS) {
    assert.ok(
      workflows.some((workflow) => workflow.name === name),
      `${name} no longer runs the resolver — drop it from UNBOUND_WORKFLOWS`,
    );
  }

  for (const { name, doc } of workflows) {
    const exempt = UNBOUND_WORKFLOWS.includes(name);
    let checkError;
    try {
      checkWorkflowSandboxBindings(name, doc);
    } catch (thrown) {
      checkError = thrown;
    }
    if (exempt) {
      // Inverted tripwire: the exemption exists ONLY while the binding
      // is absent, so the same check must fail once the workflow binds
      // the resolver output — a stale entry would silently re-open the
      // hole the derived set closes (#9527 review).
      assert.ok(
        checkError,
        `${name} now binds the resolver output — drop it from UNBOUND_WORKFLOWS`,
      );
    } else if (checkError) {
      throw checkError;
    }
  }
});
