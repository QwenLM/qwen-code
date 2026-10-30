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
  checkManagedRuntimeOssAsset,
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
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

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

describe.skipIf(process.platform === 'win32')(
  'authenticated OSS verification',
  () => {
    function check({
      content = bytes,
      error = '',
      status = 0,
      url = 'oss://release-bucket/releases/server.jar',
      extra = [],
      script = path.join(root, 'scripts/managed-runtime-release.js'),
    } = {}) {
      const bin = path.join(temporary, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}');
      fs.writeFileSync(
        path.join(bin, 'ossutil'),
        `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.OSS_ARGS, JSON.stringify(process.argv.slice(2)));
process.stdout.write(Buffer.from(${JSON.stringify(content.toString('base64'))}, 'base64'));
process.stdout.write(${JSON.stringify(error || '\n\n0.001234(s) elapsed\n')});
process.exit(${status});
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [
          fs.realpathSync(script),
          '--check-oss',
          url,
          '--config',
          path.join(temporary, 'config'),
          '--file',
          jar,
          ...extra,
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            OSS_ARGS: path.join(temporary, 'args'),
            TMPDIR: temporary,
          },
          encoding: 'utf8',
        },
      );
      expect(
        fs
          .readdirSync(temporary)
          .filter((name) => name.startsWith('managed-oss-')),
      ).toEqual([]);
      return result;
    }

    it('downloads authenticated bytes using only the configured read command', () => {
      const result = check();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('present\n');
      expect(
        JSON.parse(fs.readFileSync(path.join(temporary, 'args'), 'utf8')),
      ).toEqual([
        'cat',
        'oss://release-bucket/releases/server.jar',
        '-c',
        path.join(temporary, 'config'),
      ]);
      expect(fs.readFileSync(jar)).toEqual(bytes);
    });

    it('runs current workflow tooling alongside an unchanged old-tag source tree', () => {
      const command = workflow.jobs.release.steps
        .find((item) => item.id === 'publication')
        .run.match(/node (\S+) --check-oss/)[1];
      const script = path.join(temporary, command);
      fs.mkdirSync(path.dirname(script), { recursive: true });
      for (const name of [
        'managed-runtime-release.js',
        'release-script-utils.js',
      ]) {
        fs.copyFileSync(
          path.join(root, 'scripts', name),
          path.join(path.dirname(script), name),
        );
      }
      fs.writeFileSync(
        path.join(temporary, 'package.json'),
        '{"type":"module"}',
      );
      fs.symlinkSync(
        path.join(root, 'node_modules'),
        path.join(temporary, 'node_modules'),
        'dir',
      );
      const oldSource = path.join(
        temporary,
        'scripts/managed-runtime-release.js',
      );
      fs.mkdirSync(path.dirname(oldSource), { recursive: true });
      fs.writeFileSync(
        oldSource,
        'throw new Error("old tag has no --check-oss");',
      );
      const result = check({ script });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('present\n');
      expect(fs.readFileSync(oldSource, 'utf8')).toBe(
        'throw new Error("old tag has no --check-oss");',
      );
    });

    it('preserves an artifact terminal newline when removing the CLI trailer', () => {
      const content = Buffer.concat([bytes, Buffer.from('\n')]);
      fs.writeFileSync(jar, content);
      expect(check({ content }).stdout).toBe('present\n');
    });

    it('refuses unexpected successful CLI output instead of discarding arbitrary bytes', () => {
      const result = check({ error: '\n' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('refusing overwrite');
    });

    it('recognizes only the canonical structured NoSuchKey 404 as missing', () => {
      const result = check({
        content: Buffer.alloc(0),
        status: 1,
        error:
          'Error: oss: service returned error: StatusCode=404, ErrorCode=NoSuchKey, ErrorMessage="The specified key does not exist.", RequestId=request-id\n',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('missing\n');
    });

    it.each([
      'Error: oss: service returned error: StatusCode=403, ErrorCode=AccessDenied, ErrorMessage="Access denied", RequestId=id\n',
      'Error: oss: service returned error: StatusCode=404, ErrorCode=NoSuchBucket, ErrorMessage="Missing bucket", RequestId=id\n',
      'Error: oss: service returned error: StatusCode=403, ErrorCode=NoSuchKey, ErrorMessage="Denied", RequestId=id\n',
      'Error: oss: service returned error: StatusCode=404, ErrorCode=AccessDenied, ErrorMessage="NoSuchKey", RequestId=id\n',
      'Error: HTTP 404 NoSuchKey\n',
      'Error: network unavailable\n',
    ])('fails closed for inaccessible or unconfirmed absence: %s', (error) => {
      const result = check({ content: Buffer.alloc(0), status: 1, error });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Cannot verify existing OSS artifact');
    });

    it.each([
      Buffer.alloc(bytes.length, 1),
      bytes.subarray(0, 4),
      Buffer.concat([bytes, Buffer.from('extra')]),
    ])('refuses different bytes and cleans its download', (content) => {
      const result = check({ content });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('refusing overwrite');
    });

    it.each([
      'https://example.com/object',
      'oss://user:password@bucket/object',
      'oss://bucket/',
      'oss://bucket/key?versionId=old',
    ])('rejects invalid OSS sources before invoking ossutil: %s', (url) => {
      expect(check({ url }).status).toBe(1);
      expect(fs.existsSync(path.join(temporary, 'args'))).toBe(false);
    });

    it('kills a stalled reader and removes its partial download', async () => {
      fs.writeFileSync(
        path.join(temporary, 'ossutil'),
        `#!${process.execPath}
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', temporary);
      vi.stubEnv('TMPDIR', temporary);
      await expect(
        checkManagedRuntimeOssAsset('oss://bucket/key', jar, 'config', 100),
      ).rejects.toThrow('Cannot verify existing OSS artifact');
      expect(
        fs
          .readdirSync(temporary)
          .filter((name) => name.startsWith('managed-oss-')),
      ).toEqual([]);
    });

    it('fails closed when ossutil cannot start', async () => {
      vi.stubEnv('PATH', temporary);
      await expect(
        checkManagedRuntimeOssAsset('oss://bucket/key', jar, 'config'),
      ).rejects.toThrow('Cannot verify existing OSS artifact');
    });

    it('rejects mixed public and authenticated verification arguments', () => {
      expect(
        check({ extra: ['--check-url', 'https://example.com/server.jar'] })
          .status,
      ).toBe(1);
      expect(fs.existsSync(path.join(temporary, 'args'))).toBe(false);
    });
  },
);

describe('Managed runtime publication gates', () => {
  const steps = workflow.jobs.release.steps;
  const step = (name) => steps.find((item) => item.name === name);
  it('stages the executable classifier while retaining legacy fallback and runtime download names', () => {
    const verification = step(
      'Verify the executable JAR and publication profile',
    ).run;
    expect(verification).toContain(
      'qwen-managed-agent-server-${CLI_VERSION}-exec.jar',
    );
    expect(verification).toContain(
      'Main-Class: org.springframework.boot.loader.launch.JarLauncher',
    );
    expect(verification).toContain(
      'if [[ ! -f "${runtime_jar}" ]]; then runtime_jar="packages/managed-agent-server/target/qwen-managed-agent-server-${CLI_VERSION}.jar"; fi',
    );
    expect(verification).toContain(
      '--jar "${runtime_jar}" --version "${CLI_VERSION}" --out-dir dist/managed-runtime',
    );
    expect(step('Verify both public download channels').run).toContain(
      'jar="qwen-managed-agent-server-${CLI_VERSION}.jar"',
    );
  });

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
      'Attach only missing GitHub release assets',
      'Install the verified OSS uploader',
      'Configure authenticated OSS access',
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
    for (const name of [
      'Attach only missing GitHub release assets',
      'Upload only missing OSS release assets',
    ]) {
      expect(build).toBeLessThan(steps.indexOf(step(name)));
    }
  });

  it('distributes the verified runtime without Central publication access or signing credentials', () => {
    const definition = JSON.stringify(workflow);
    for (const dependency of [
      'CENTRAL_USERNAME',
      'CENTRAL_PASSWORD',
      'MAVEN_GPG_PRIVATE_KEY',
      'MAVEN_GPG_PASSPHRASE',
      'repo.maven.apache.org',
      'gpg-private-key',
    ]) {
      expect(definition).not.toContain(dependency);
    }
    expect(steps.some((item) => /\bmvn\b.*\bdeploy\b/u.test(item.run))).toBe(
      false,
    );
    expect(workflow.on.workflow_dispatch.inputs.dry_run.description).toBe(
      'Build and verify without publishing to GitHub or OSS.',
    );
  });

  it('configures the pinned OSS reader before preflight and reuses the upload destination and credentials', () => {
    const install = step('Install the verified OSS uploader');
    const configure = step('Configure authenticated OSS access');
    const preflight = step(
      'Recheck the immutable tag and existing publication bytes',
    );
    const upload = step('Upload only missing OSS release assets');
    expect(steps.indexOf(install)).toBeLessThan(steps.indexOf(configure));
    expect(steps.indexOf(configure)).toBeLessThan(steps.indexOf(preflight));
    expect(steps.indexOf(preflight)).toBeLessThan(
      steps.indexOf(step('Attach only missing GitHub release assets')),
    );
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(upload));
    expect(install.env.OSSUTIL_URL).toContain('/1.7.19/');
    expect(install.env.OSSUTIL_SHA256).toBe(
      'dcc512e4a893e16bbee63bc769339d8e56b21744fd83c8212a9d8baf28767343',
    );
    expect(configure.env.ALIYUN_OSS_ACCESS_KEY_ID).toBe(
      '${{ secrets.ALIYUN_OSS_ACCESS_KEY_ID }}',
    );
    expect(configure.env.ALIYUN_OSS_ACCESS_KEY_SECRET).toBe(
      '${{ secrets.ALIYUN_OSS_ACCESS_KEY_SECRET }}',
    );
    expect(configure.run).toContain('umask 077');
    expect(configure.run).toContain(
      '-L EN -c "${RUNNER_TEMP}/managed-ossutilconfig"',
    );
    expect(workflow.jobs.release.env.ALIYUN_OSS_BUCKET).toContain(
      'vars.ALIYUN_OSS_BUCKET',
    );
    expect(preflight.run).toContain(
      'oss="oss://${ALIYUN_OSS_BUCKET}/releases/qwen-code/${RELEASE_TAG}/${asset}"',
    );
    expect(preflight.run).toContain(
      '--check-oss "${oss}" --config "${RUNNER_TEMP}/managed-ossutilconfig"',
    );
    expect(upload.run).toContain(
      '--bucket "${ALIYUN_OSS_BUCKET}" --config "${RUNNER_TEMP}/managed-ossutilconfig"',
    );
    expect(upload.env).toBeUndefined();
    expect(step('Verify both public download channels').run).toContain(
      '--check-url "${base}/${asset}"',
    );
    expect(step('Verify both public download channels').run).toContain(
      'OSS_PUBLIC_BASE_URL',
    );
  });

  it('pins checkout and reproducible timestamps, and verifies the SDK before packaging the server', () => {
    expect(steps[0].with.ref).toBe('${{ needs.prepare.outputs.sha }}');
    expect(steps[0].with['persist-credentials']).toBe(false);
    const tools = step('Checkout release tooling from the workflow revision');
    expect(tools.with).toEqual({
      ref: '${{ github.workflow_sha }}',
      path: '.qwen/managed-release-tools',
      'sparse-checkout': 'scripts',
      'persist-credentials': false,
    });
    expect(tools.uses).toBe(steps[0].uses);
    for (const item of steps.filter((item) =>
      item.run?.includes('managed-runtime-release.js'),
    )) {
      expect(item.run).not.toContain('node scripts/managed-runtime-release.js');
      expect(item.run).toContain(
        'node .qwen/managed-release-tools/scripts/managed-runtime-release.js',
      );
    }

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
  });

  it('isolates server test classes without filtering or bypassing release verification', () => {
    const verification = step(
      'Verify the executable JAR and publication profile',
    ).run;
    expect(verification).toContain('-DforkCount=1');
    expect(verification).toContain('-DreuseForks=false');
    expect(verification).toContain('clean verify -Pcentral-release');
    expect(verification).not.toMatch(
      /-D(?:test=|groups=|excludedGroups=|skipTests|maven\.test\.(?:skip|failure\.ignore)|surefire\.(?:includes|excludes|rerunFailingTestsCount))/,
    );
    expect(verification).not.toContain('-DargLine=');
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
  const repair = workflow.jobs.release.steps.find(
    (item) => item.name === 'Repair the 0.26.3 ownership test fixture',
  );
  const repairSource = 'eeee1443a7e36ab22b2f1dcded8dec64b621a7ee';
  const repairedTest =
    'packages/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/Issue13180HardenedVerificationTest.java';
  const repairPatch = 'scripts/patches/managed-runtime-v0.26.3-tests.patch';

  function repairFixture() {
    const fixed = fs.readFileSync(path.join(root, repairedTest), 'utf8');
    const target = path.join(temporary, repairedTest);
    const patch = path.join(
      temporary,
      '.qwen/managed-release-tools',
      repairPatch,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(patch), { recursive: true });
    fs.writeFileSync(target, fixed);
    fs.copyFileSync(path.join(root, repairPatch), patch);
    const git = (...args) => {
      const result = spawnSync(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=Release test',
          '-c',
          'user.email=release-test@example.invalid',
          ...args,
        ],
        { cwd: temporary, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
    };
    git('init', '--quiet');
    git('apply', '--reverse', patch);
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(path.join(temporary, 'product.java'), 'original product');
    git('add', repairedTest, 'product.java');
    git('commit', '--quiet', '-m', 'Release test fixture');
    return { fixed, original, target, patch };
  }

  it('repairs only the 0.26.3 test while retaining the original ownership assertions and product bytes', () => {
    expect(repair.if).toBe("${{ env.RELEASE_TAG == 'v0.26.3' }}");
    const { fixed, target } = repairFixture();
    const result = run(repair.run, {
      RELEASE_TAG: 'v0.26.3',
      SOURCE_SHA: repairSource,
      GITHUB_STEP_SUMMARY: path.join(temporary, 'summary'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(target, 'utf8')).toBe(fixed);
    expect(fs.readFileSync(path.join(temporary, 'product.java'), 'utf8')).toBe(
      'original product',
    );
  });

  it.each(['wrong source', 'production patch'])(
    'refuses the 0.26.3 repair with %s before changing files',
    (failure) => {
      const { original, target, patch } = repairFixture();
      if (failure === 'production patch') {
        fs.writeFileSync(
          patch,
          fs
            .readFileSync(patch, 'utf8')
            .replaceAll(repairedTest, 'product.java'),
        );
      }
      const result = run(repair.run, {
        RELEASE_TAG: 'v0.26.3',
        SOURCE_SHA: failure === 'wrong source' ? 'other-sha' : repairSource,
        GITHUB_STEP_SUMMARY: path.join(temporary, 'summary'),
      });
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(target, 'utf8')).toBe(original);
      expect(
        fs.readFileSync(path.join(temporary, 'product.java'), 'utf8'),
      ).toBe('original product');
    },
  );

  it('requires both credentials before creating a private shared OSS configuration', () => {
    const configure = workflow.jobs.release.steps.find(
      (item) => item.name === 'Configure authenticated OSS access',
    ).run;
    executable(
      'ossutil',
      'touch oss-called; for value do :; done; : > "$value"',
    );
    const env = {
      ALIYUN_OSS_ACCESS_KEY_ID: 'fixture-id',
      ALIYUN_OSS_ACCESS_KEY_SECRET: '',
      ALIYUN_OSS_ENDPOINT: 'https://example.invalid',
    };
    expect(run(configure, env).status).not.toBe(0);
    expect(fs.existsSync(path.join(temporary, 'oss-called'))).toBe(false);
    expect(
      run(configure, { ...env, ALIYUN_OSS_ACCESS_KEY_SECRET: 'fixture-secret' })
        .status,
    ).toBe(0);
    expect(
      fs.statSync(path.join(temporary, 'managed-ossutilconfig')).mode & 0o777,
    ).toBe(0o600);
  });

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

  it('prepares both distribution channels when Central publication is unavailable and its credentials are absent', () => {
    executable('git', "printf '%s\\tref\\n' original-sha");
    executable('gh', "printf '%s\\n' '{\"draft\":false}'");
    executable(
      'node',
      'case "$*" in *repo.maven.apache.org*) echo unexpected-central >&2; exit 7 ;; *) echo missing ;; esac',
    );
    const result = run(preflight, {
      SOURCE_SHA: 'original-sha',
      CLI_VERSION: '0.25.4',
      ALIYUN_OSS_BUCKET: 'release-bucket',
      CENTRAL_USERNAME: '',
      CENTRAL_PASSWORD: '',
      MAVEN_USERNAME: '',
      MAVEN_PASSWORD: '',
      MAVEN_GPG_PRIVATE_KEY: '',
      MAVEN_GPG_PASSPHRASE: '',
    });
    expect(result.status).toBe(0);
    for (const channel of ['github', 'oss']) {
      expect(
        fs.readFileSync(
          path.join(temporary, `managed-${channel}-missing`),
          'utf8',
        ),
      ).toBe(
        'dist/managed-runtime/qwen-managed-agent-server-0.25.4.jar\n' +
          'dist/managed-runtime/qwen-managed-agent-server-0.25.4.jar.sha256\n',
      );
    }
  });

  it.each(['github.com', 'oss://'])(
    'aborts preflight on a %s artifact-verification error instead of treating it as present',
    (channel) => {
      executable('git', "printf '%s\\tref\\n' original-sha");
      executable('gh', "printf '%s\\n' '{\"draft\":false}'");
      executable(
        'node',
        'case "$*" in *"$MISMATCH_HOST"*) echo mismatch >&2; exit 7 ;; *) echo missing ;; esac',
      );
      const result = run(preflight, {
        SOURCE_SHA: 'original-sha',
        CLI_VERSION: '0.25.4',
        OSS_PUBLIC_BASE_URL: 'https://example.com',
        ALIYUN_OSS_BUCKET: 'release-bucket',
        MISMATCH_HOST: channel,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('mismatch');
    },
  );
});
