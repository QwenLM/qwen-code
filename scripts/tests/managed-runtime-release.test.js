/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkManagedRuntimeAsset,
  stageManagedRuntimeRelease,
} from '../managed-runtime-release.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const workflow = parse(
  fs.readFileSync(
    path.join(root, '.github/workflows/release-managed-runtime.yml'),
    'utf8',
  ),
);
let temporary;
let jar;
const bytes = Buffer.concat([
  Buffer.from('504b0304', 'hex'),
  Buffer.from('release JAR fixture'),
]);
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-release-'));
  jar = path.join(temporary, 'server.jar');
  fs.writeFileSync(jar, bytes);
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

it('stages the exact server bytes and the checksum consumed by the first-use installer', async () => {
  const outDir = path.join(temporary, 'release');
  const result = await stageManagedRuntimeRelease({
    jar,
    version: '0.25.4-preview.1',
    outDir,
  });
  const name = 'qwen-managed-agent-server-0.25.4-preview.1.jar';
  expect(result).toEqual({
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  expect(fs.readFileSync(path.join(outDir, name))).toEqual(bytes);
  expect(fs.readFileSync(path.join(outDir, `${name}.sha256`), 'utf8')).toBe(
    `${result.sha256}  ${name}\n`,
  );
  expect(fs.readdirSync(outDir).sort()).toEqual([name, `${name}.sha256`]);
});

it.each(['latest', '../escape', 'v0.25.4'])(
  'refuses non-exact version %s before staging',
  async (version) => {
    const outDir = path.join(temporary, 'release');
    await expect(
      stageManagedRuntimeRelease({ jar, version, outDir }),
    ).rejects.toThrow('exact CLI release');
    expect(fs.existsSync(outDir)).toBe(false);
  },
);

it('refuses non-JAR content rather than producing a downloadable payload', async () => {
  fs.writeFileSync(jar, '<html>error</html>');
  await expect(
    stageManagedRuntimeRelease({
      jar,
      version: '0.25.4',
      outDir: path.join(temporary, 'release'),
    }),
  ).rejects.toThrow('packaged server JAR');
});

it('recognizes an already published identical artifact without replacing it', async () => {
  const fetchImpl = vi.fn(async () => new Response(bytes));
  await expect(
    checkManagedRuntimeAsset('https://example.com/server.jar', jar, fetchImpl),
  ).resolves.toBe('present');
  expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

it('treats only a genuine 404 as an unpublished artifact', async () => {
  await expect(
    checkManagedRuntimeAsset(
      'https://example.com/server.jar',
      jar,
      async () => new Response('', { status: 404 }),
    ),
  ).resolves.toBe('missing');
  for (const status of [403, 429, 500]) {
    await expect(
      checkManagedRuntimeAsset(
        'https://example.com/server.jar',
        jar,
        async () => new Response('', { status }),
      ),
    ).rejects.toThrow(`HTTP ${status}`);
  }
});

it.each(['different bytes of the same length', 'truncated', 'oversized'])(
  'refuses an existing %s artifact',
  async (kind) => {
    const content =
      kind === 'truncated'
        ? bytes.subarray(0, 4)
        : kind === 'oversized'
          ? Buffer.concat([bytes, Buffer.from('extra')])
          : Buffer.alloc(bytes.length, 1);
    await expect(
      checkManagedRuntimeAsset(
        'https://example.com/server.jar',
        jar,
        async () => new Response(content),
      ),
    ).rejects.toThrow('refusing overwrite');
  },
);

it('does not disguise network failure as a missing release', async () => {
  await expect(
    checkManagedRuntimeAsset(
      'https://example.com/server.jar',
      jar,
      async () => {
        throw new Error('network unavailable');
      },
    ),
  ).rejects.toThrow('network unavailable');
});

it.each([
  'http://example.com/server.jar',
  'https://user:password@example.com/server.jar',
])('requires a public HTTPS source: %s', async (url) => {
  const fetchImpl = vi.fn();
  await expect(checkManagedRuntimeAsset(url, jar, fetchImpl)).rejects.toThrow(
    'public HTTPS',
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});

describe('Managed runtime publication gates', () => {
  const steps = workflow.jobs.release.steps;
  const step = (name) => steps.find((item) => item.name === name);
  it('defaults manual runs to verification and restricts publication to the protected official repository', () => {
    expect(workflow.on.release.types).toEqual(['published']);
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(workflow.jobs.prepare.if).toContain(
      "github.repository == 'QwenLM/qwen-code'",
    );
    expect(workflow.jobs.release.environment.name).toBe('production-release');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.release.if).toContain(
      "needs.prepare.outputs.eligible == 'true'",
    );
    for (const name of [
      'Recheck the immutable tag and existing publication bytes',
      'Configure signed Central publication',
      'Publish the signed server artifact to Central',
      'Attach only missing GitHub release assets',
      'Install the verified OSS uploader',
      'Upload only missing OSS release assets',
    ]) {
      expect(step(name).if).toContain(
        "github.event_name == 'release' || !inputs.dry_run",
      );
    }
    expect(step('Attach only missing GitHub release assets').run).not.toContain(
      '--clobber',
    );
    const build = steps.findIndex(
      (item) =>
        item.name === 'Verify the executable JAR and publication profile',
    );
    expect(build).toBeLessThan(
      steps.findIndex(
        (item) => item.name === 'Publish the signed server artifact to Central',
      ),
    );
  });

  it('pins checkout and reproducible timestamps, and verifies the SDK before packaging the server', () => {
    expect(steps[0].with.ref).toBe('${{ needs.prepare.outputs.sha }}');
    expect(steps[0].with['persist-credentials']).toBe(false);
    expect(
      step('Verify and install the SDK from the same source').run,
    ).toContain('clean install');
    expect(
      step('Verify and install the SDK from the same source').run,
    ).toContain('project.build.outputTimestamp="${BUILD_TIMESTAMP}"');
    expect(
      step('Verify the executable JAR and publication profile').run,
    ).toContain('-Pcentral-release');
    expect(
      step('Verify the executable JAR and publication profile').run,
    ).toContain('clean verify');
    expect(step('Publish the signed server artifact to Central').run).toContain(
      'cmp ',
    );
  });

  it('keeps auxiliary executable JARs out of Central without changing their ordinary build attachment', () => {
    const pom = fs.readFileSync(
      path.join(root, 'packages/managed-agent-server/pom.xml'),
      'utf8',
    );
    expect(pom).toContain(
      '<managed.operator-tools.attach>true</managed.operator-tools.attach>',
    );
    const profile = pom.match(
      /<profile>\s*<id>central-release<\/id>([\s\S]*?)<\/profile>/,
    )[1];
    expect(profile).toContain(
      '<managed.operator-tools.attach>false</managed.operator-tools.attach>',
    );
    for (const plugin of [
      'central-publishing-maven-plugin',
      'maven-source-plugin',
      'maven-javadoc-plugin',
      'maven-gpg-plugin',
    ])
      expect(profile).toContain(plugin);
    expect(
      pom.match(/<attach>\$\{managed.operator-tools.attach\}<\/attach>/g),
    ).toHaveLength(6);
  });
});

describe.skipIf(process.platform === 'win32')('release gate execution', () => {
  function executable(name, body) {
    const bin = path.join(temporary, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
    return bin;
  }
  function run(script, env = {}) {
    return spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
      cwd: temporary,
      env: {
        ...process.env,
        HOME: temporary,
        BASH_ENV: '/dev/null',
        PATH: `${path.join(temporary, 'bin')}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP: temporary,
        GITHUB_OUTPUT: path.join(temporary, 'output'),
        RELEASE_TAG: 'v0.25.4',
        EVENT_NAME: 'workflow_dispatch',
        WORKFLOW_REF: 'refs/heads/main',
        ...env,
      },
      encoding: 'utf8',
    });
  }
  const gate = workflow.jobs.prepare.steps.find(
    (item) => item.id === 'gate',
  ).run;
  const preflight = workflow.jobs.release.steps.find(
    (item) => item.id === 'publication',
  ).run;

  it('rejects a non-main manual run before consulting the release', () => {
    executable('gh', 'touch gh-called; exit 1');
    expect(run(gate, { WORKFLOW_REF: 'refs/heads/untrusted' }).status).not.toBe(
      0,
    );
    expect(fs.existsSync(path.join(temporary, 'gh-called'))).toBe(false);
  });

  it('ignores an unrelated published release without attempting publication', () => {
    executable('gh', 'touch gh-called; exit 1');
    expect(
      run(gate, { EVENT_NAME: 'release', RELEASE_TAG: 'vscode-v0.25.4' })
        .status,
    ).toBe(0);
    expect(fs.readFileSync(path.join(temporary, 'output'), 'utf8')).toBe(
      'eligible=false\n',
    );
    expect(fs.existsSync(path.join(temporary, 'gh-called'))).toBe(false);
  });

  it('rejects a changed release tag before checking or uploading artifacts', () => {
    executable('git', "printf '%s\\tref\\n' different-sha");
    executable('gh', 'touch gh-called; exit 1');
    expect(
      run(preflight, { SOURCE_SHA: 'original-sha', CLI_VERSION: '0.25.4' })
        .status,
    ).not.toBe(0);
    expect(fs.existsSync(path.join(temporary, 'gh-called'))).toBe(false);
  });

  it('aborts preflight on an artifact-verification error instead of treating it as present', () => {
    executable('git', "printf '%s\\tref\\n' original-sha");
    executable('gh', "printf '%s\\n' '{\"draft\":false}'");
    executable(
      'node',
      'case "$*" in *github.com*".jar --file "*) echo mismatch >&2; exit 7 ;; *repo.maven.apache.org*) echo present ;; *) echo missing ;; esac',
    );
    const result = run(preflight, {
      SOURCE_SHA: 'original-sha',
      CLI_VERSION: '0.25.4',
      OSS_PUBLIC_BASE_URL: 'https://example.com',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('mismatch');
  });
});
