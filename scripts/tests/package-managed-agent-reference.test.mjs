/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  generateSecrets,
  renderApplicationYml,
  renderHarnessEnv,
  renderServerEnv,
} from '../../packages/managed-agent-server/distribution/bin/qwen-managed-agent-bootstrap.mjs';
import { createReferenceDistribution } from '../package-managed-agent-reference.mjs';

async function fixture(root) {
  const files = {
    'package.json': JSON.stringify({
      version: '1.2.3',
      engines: { node: '>=22.0.0' },
    }),
    LICENSE: 'license\n',
    'packages/managed-agent-server/pom.xml': `
      <artifactId>qwen-managed-agent-server</artifactId>
      <version>0.4.0-alpha</version>
      <java.version>21</java.version>
    `,
    'packages/managed-agent-server/target/qwen-managed-agent-server-0.4.0-alpha.jar':
      'server',
    'packages/managed-agent-server/target/qwen-managed-agent-server-0.4.0-alpha-operator-recovery.jar':
      'recovery',
    'packages/managed-agent-server/src/main/resources/application.yml':
      "workspace-shell-enabled: '${QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED:false}'\n",
    'packages/managed-agent-server/distribution/config/application.example.yml':
      'template\n',
    'packages/managed-agent-server/distribution/systemd/qwen-managed-agent-server.service':
      '[Service]\nKillMode=process\n',
    'packages/managed-agent-server/distribution/systemd/qwen-hosted-harness.service':
      'ExecStart=qwen serve --profile hosted-harness --no-web\n',
    'packages/managed-agent-server/distribution/systemd/harness.env.example':
      'QWEN_SERVER_TOKEN=\n',
    'packages/managed-agent-server/distribution/systemd/server.env.example':
      'SPRING_DATASOURCE_URL=\n',
    'packages/managed-agent-server/distribution/systemd/README.md': 'systemd\n',
    'packages/managed-agent-server/distribution/systemd/README.zh-CN.md':
      'systemd zh\n',
    'packages/managed-agent-server/distribution/bin/qwen-managed-agent-bootstrap':
      '#!/usr/bin/env sh\n',
    'packages/managed-agent-server/distribution/bin/qwen-managed-agent-bootstrap.mjs':
      'export {};\n',
    'packages/managed-agent-server/src/main/resources/openapi/managed-agent-public-api.openapi.json':
      JSON.stringify({ info: { version: '1.46.0' } }),
    'packages/managed-agent-server/src/main/resources/db/managed-schema/V1__baseline.sql':
      'select 1;',
    'packages/managed-agent-server/src/main/java/db/migration/V9__latest.java':
      'class Latest {}',
    'packages/cli/src/serve/capabilities.ts':
      "export const SERVE_PROTOCOL_VERSION = 'v1' as const;\n",
    'packages/cli/src/serve/broker-managed-runtime-provider.ts':
      'export const MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION = 2 as const;\n',
    'packages/cli/src/serve/hosted-harness-contract.ts':
      "const profiles = (\n  process.env[HOSTED_LIFECYCLE_V2_PROFILES_ENV] ?? ''\n).split(',');\n",
    'docs/users/managed-agent-reference-deployment.md': 'deploy\n',
    'docs/users/managed-agent-reference-deployment.zh-CN.md': '部署\n',
    'docs/users/hosted-workspace-recovery.md': 'recover\n',
    'docs/users/hosted-workspace-recovery.zh-CN.md': '恢复\n',
    'packages/managed-agent-server/README.md': 'server reference\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
}

test('packages an independently verifiable reference distribution', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qwen-reference-'));
  try {
    const root = path.join(temporary, 'repo');
    const output = path.join(temporary, 'release');
    const secondOutput = path.join(temporary, 'release-second');
    const extracted = path.join(temporary, 'extracted');
    await fixture(root);

    const result = await createReferenceDistribution({
      repoRoot: root,
      outputDirectory: output,
      version: '0.1.0-alpha.1',
      sourceRevision: 'a'.repeat(40),
    });

    assert.equal(result.manifest.source.revision, 'a'.repeat(40));
    assert.equal(result.manifest.compatibility.qwenCodeVersion, '1.2.3');
    assert.equal(result.manifest.compatibility.serveProtocolVersion, 'v1');
    assert.equal(
      result.manifest.compatibility.managedRuntimeBrokerProtocolVersion,
      2,
    );
    assert.deepEqual(result.manifest.compatibility.databaseSchema, {
      migrationTool: 'Flyway',
      minimumMigrationVersion: '1',
      latestMigrationVersion: '9',
    });
    assert.deepEqual(
      result.manifest.components.map(({ name }) => name),
      ['qwen-managed-agent-server', 'qwen-managed-agent-operator-recovery'],
    );
    assert.deepEqual(result.manifest.defaults, {
      publicShellEnabled: false,
      v2CapabilityAdvertisementEnabled: false,
    });

    await mkdir(extracted);
    execFileSync('tar', ['-xzf', result.archive, '-C', extracted]);
    const bundle = path.join(
      extracted,
      'qwen-managed-agent-reference-0.1.0-alpha.1',
    );
    execFileSync('sha256sum', ['--check', 'SHA256SUMS'], {
      cwd: bundle,
      stdio: 'pipe',
    });
    const launcher = await readFile(
      path.join(bundle, 'bin/qwen-managed-agent-server'),
      'utf8',
    );
    assert.match(launcher, /lib\/qwen-managed-agent-server-0\.4\.0-alpha\.jar/);
    assert.match(launcher, /config\/application\.yml/);
    assert.match(launcher, /SPRING_CONFIG_ADDITIONAL_LOCATION/);
    assert.doesNotMatch(launcher, /set --/);
    assert.equal(
      await readFile(
        path.join(bundle, 'config/application.example.yml'),
        'utf8',
      ),
      'template\n',
    );
    assert.equal(
      await readFile(
        path.join(bundle, 'systemd/qwen-managed-agent-server.service'),
        'utf8',
      ),
      '[Service]\nKillMode=process\n',
    );
    assert.match(
      await readFile(
        path.join(bundle, 'systemd/qwen-hosted-harness.service'),
        'utf8',
      ),
      /--profile hosted-harness/,
    );
    assert.equal(
      await readFile(
        path.join(bundle, 'bin/qwen-managed-agent-bootstrap'),
        'utf8',
      ),
      '#!/usr/bin/env sh\n',
    );
    execFileSync('sha256sum', ['--check', 'SHA256SUMS.txt'], {
      cwd: output,
      stdio: 'pipe',
    });

    const second = await createReferenceDistribution({
      repoRoot: root,
      outputDirectory: secondOutput,
      version: '0.1.0-alpha.1',
      sourceRevision: 'a'.repeat(40),
    });
    assert.deepEqual(
      await readFile(second.archive),
      await readFile(result.archive),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('launchers load the distribution config only when it exists', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qwen-reference-'));
  try {
    const root = path.join(temporary, 'repo');
    const output = path.join(temporary, 'release');
    const extracted = path.join(temporary, 'extracted');
    const fakeBin = path.join(temporary, 'bin');
    await fixture(root);
    const result = await createReferenceDistribution({
      repoRoot: root,
      outputDirectory: output,
      version: '0.1.0-alpha.1',
      sourceRevision: 'a'.repeat(40),
    });
    await mkdir(extracted);
    execFileSync('tar', ['-xzf', result.archive, '-C', extracted]);
    const bundle = path.join(
      extracted,
      'qwen-managed-agent-reference-0.1.0-alpha.1',
    );

    await mkdir(fakeBin);
    const java = path.join(fakeBin, 'java');
    await writeFile(
      java,
      '#!/bin/sh\nprintf "ENV=%s\\n" "${SPRING_CONFIG_ADDITIONAL_LOCATION:-}"\n' +
        'printf "ARG=%s\\n" "$@"\n',
    );
    await chmod(java, 0o755);
    const baseEnv = { ...process.env };
    delete baseEnv.SPRING_CONFIG_ADDITIONAL_LOCATION;
    const env = { ...baseEnv, PATH: `${fakeBin}:${process.env.PATH}` };
    const launcherPath = path.join(bundle, 'bin/qwen-managed-agent-server');
    const recoveryPath = path.join(
      bundle,
      'bin/qwen-managed-agent-operator-recovery',
    );
    const run = (script, args, overrides = {}) =>
      execFileSync('sh', [script, ...args], {
        env: { ...env, ...overrides },
        encoding: 'utf8',
      });

    const withoutConfig = run(launcherPath, ['--spring.profiles.active=test']);
    assert.ok(withoutConfig.includes('ENV=\n'));
    assert.ok(withoutConfig.includes('ARG=--spring.profiles.active=test'));
    assert.ok(
      !withoutConfig.includes('ARG=--spring.config.additional-location'),
    );

    const config = path.join(bundle, 'config/application.yml');
    await writeFile(config, 'qwen: {}\n');
    const withConfig = run(launcherPath, ['--spring.profiles.active=test']);
    assert.ok(withConfig.includes(`ENV=file:${config}`));
    assert.ok(withConfig.includes('ARG=--spring.profiles.active=test'));
    assert.ok(!withConfig.includes('ARG=--spring.config.additional-location'));

    const operator = run(launcherPath, [], {
      SPRING_CONFIG_ADDITIONAL_LOCATION: '/tmp/operator.yml',
    });
    assert.ok(operator.includes('ENV=/tmp/operator.yml'));

    const recovery = run(recoveryPath, ['inspect', 'binding-1', '7']);
    assert.ok(recovery.includes(`ENV=file:${config}`));
    assert.ok(recovery.includes('ARG=-jar'));
    assert.ok(recovery.includes('ARG=inspect'));
    assert.ok(recovery.includes('ARG=binding-1'));
    assert.ok(recovery.includes('ARG=7'));
    assert.ok(!recovery.includes('ARG=--spring.config.additional-location'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('ships systemd units with the documented kill modes', async () => {
  const directory = new URL(
    '../../packages/managed-agent-server/distribution/systemd/',
    import.meta.url,
  );
  const server = await readFile(
    new URL('qwen-managed-agent-server.service', directory),
    'utf8',
  );
  const harness = await readFile(
    new URL('qwen-hosted-harness.service', directory),
    'utf8',
  );

  assert.match(server, /^KillMode=process$/m);
  assert.match(server, /^StateDirectory=qwen-managed-agent$/m);
  assert.match(
    server,
    /^EnvironmentFile=\/etc\/qwen-managed-agent\/server\.env$/m,
  );
  assert.match(
    server,
    /^ExecStart=\/opt\/qwen-managed-agent\/bin\/qwen-managed-agent-server$/m,
  );
  assert.match(harness, /^KillMode=mixed$/m);
  assert.match(harness, /^StateDirectory=qwen-managed-agent$/m);
  assert.match(harness, /--profile hosted-harness/);
  assert.match(harness, /--no-web/);
  assert.match(harness, /QWEN_HOSTED_HARNESS_BROKER_ARGS/);
  assert.ok(server.endsWith('\n'));
  assert.ok(harness.endsWith('\n'));
  assert.doesNotMatch(server, /\t/);
  assert.doesNotMatch(harness, /\t/);
});

test('bootstrap renders matching credentials and a 32-byte key', () => {
  const secrets = generateSecrets('reference-test');
  assert.match(secrets.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Buffer.from(secrets.credentialKey, 'base64').length, 32);
  assert.ok(renderHarnessEnv(secrets).includes(secrets.token));
  const server = renderServerEnv(secrets, '/tmp/application.yml');
  assert.ok(server.includes(secrets.token));
  assert.ok(server.includes(secrets.digest));
  assert.match(server, /^QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED=true$/m);
  assert.match(
    server,
    /^QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL=http:\/\/127\.0\.0\.1:8080$/m,
  );
  assert.match(server, /^QWEN_MANAGED_AGENT_WORKSPACE_ID=\S+$/m);
  assert.match(
    renderApplicationYml(secrets),
    /credential-key-id: 'reference-test'/,
  );
});

test('bootstrap writes private files without printing secrets', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qwen-bootstrap-'));
  try {
    const directory = path.join(temporary, 'config');
    const script = fileURLToPath(
      new URL(
        '../../packages/managed-agent-server/distribution/bin/' +
          'qwen-managed-agent-bootstrap.mjs',
        import.meta.url,
      ),
    );
    const output = execFileSync(
      process.execPath,
      [script, '--directory', directory],
      { encoding: 'utf8' },
    );
    const harness = await readFile(path.join(directory, 'harness.env'), 'utf8');
    const server = await readFile(path.join(directory, 'server.env'), 'utf8');
    const application = await readFile(
      path.join(directory, 'application.yml'),
      'utf8',
    );
    const token = harness.match(/^QWEN_SERVER_TOKEN=([0-9a-f]{64})$/m)[1];
    assert.ok(server.includes(`QWEN_MANAGED_AGENT_HARNESS_TOKEN=${token}`));
    assert.match(application, /credential-key: '[A-Za-z0-9+/=]{44}'/);
    for (const name of ['harness.env', 'server.env', 'application.yml']) {
      assert.equal(
        (await stat(path.join(directory, name))).mode & 0o777,
        0o600,
      );
    }
    assert.ok(!output.includes(token));
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, '--directory', directory], {
          stdio: 'pipe',
        }),
      (error) => error.status === 1,
    );
    execFileSync(
      process.execPath,
      [script, '--directory', directory, '--force'],
      { encoding: 'utf8' },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('bootstrap runs through a symlinked entry point', async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-bootstrap-link-'),
  );
  try {
    const script = fileURLToPath(
      new URL(
        '../../packages/managed-agent-server/distribution/bin/' +
          'qwen-managed-agent-bootstrap.mjs',
        import.meta.url,
      ),
    );
    const link = path.join(temporary, 'bootstrap-link.mjs');
    await symlink(script, link);
    const directory = path.join(temporary, 'config');
    execFileSync(process.execPath, [link, '--directory', directory], {
      encoding: 'utf8',
    });
    const harness = await readFile(path.join(directory, 'harness.env'), 'utf8');
    assert.match(harness, /QWEN_SERVER_TOKEN=[0-9a-f]{64}/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('bootstrap quotes the configuration path for shell sourcing', async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-bootstrap-path-'),
  );
  try {
    const script = fileURLToPath(
      new URL(
        '../../packages/managed-agent-server/distribution/bin/' +
          'qwen-managed-agent-bootstrap.mjs',
        import.meta.url,
      ),
    );
    const directory = path.join(temporary, 'config-$PR14634');
    execFileSync(process.execPath, [script, '--directory', directory], {
      encoding: 'utf8',
    });
    const value = execFileSync(
      'sh',
      [
        '-c',
        'set -a; . "$1"; printf %s "$SPRING_CONFIG_ADDITIONAL_LOCATION"',
        'sh',
        path.join(directory, 'server.env'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(value, `file:${path.join(directory, 'application.yml')}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('bootstrap rejects a configuration path it cannot quote', async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-bootstrap-quote-'),
  );
  try {
    const script = fileURLToPath(
      new URL(
        '../../packages/managed-agent-server/distribution/bin/' +
          'qwen-managed-agent-bootstrap.mjs',
        import.meta.url,
      ),
    );
    const directory = path.join(temporary, "config-'");
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, '--directory', directory], {
          stdio: 'pipe',
        }),
      (error) => error.status === 1,
    );
    await assert.rejects(readFile(path.join(directory, 'harness.env')));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('bootstrap rejects a configuration path the location list splits on', async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-bootstrap-comma-'),
  );
  try {
    const script = fileURLToPath(
      new URL(
        '../../packages/managed-agent-server/distribution/bin/' +
          'qwen-managed-agent-bootstrap.mjs',
        import.meta.url,
      ),
    );
    const directory = path.join(temporary, 'config,one');
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, '--directory', directory], {
          stdio: 'pipe',
        }),
      (error) => error.status === 1,
    );
    await assert.rejects(readFile(path.join(directory, 'harness.env')));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('bootstrap refuses to run while another bootstrap holds the lock', async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'qwen-bootstrap-lock-'),
  );
  try {
    const script = fileURLToPath(
      new URL(
        '../../packages/managed-agent-server/distribution/bin/' +
          'qwen-managed-agent-bootstrap.mjs',
        import.meta.url,
      ),
    );
    const directory = path.join(temporary, 'config');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.bootstrap.lock'), '', {
      mode: 0o600,
    });
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, '--directory', directory], {
          stdio: 'pipe',
        }),
      (error) => error.status === 1,
    );
    await assert.rejects(readFile(path.join(directory, 'harness.env')));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('enables the Session Store wherever the env template enables the Harness', async () => {
  const template = await readFile(
    new URL(
      '../../packages/managed-agent-server/distribution/systemd/server.env.example',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(template, /^QWEN_MANAGED_AGENT_HARNESS_ENABLED=true$/m);
  assert.match(template, /^QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED=true$/m);
  assert.match(
    template,
    /^QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL=http:\/\/127\.0\.0\.1:8080$/m,
  );
  assert.match(template, /^QWEN_MANAGED_AGENT_WORKSPACE_ID=\S+$/m);
});

test('rejects a stable distribution version', async () => {
  await assert.rejects(
    createReferenceDistribution({
      repoRoot: '.',
      outputDirectory: '.',
      version: '1.0.0',
      sourceRevision: 'a'.repeat(40),
    }),
    /experimental SemVer/,
  );
});

test('rejects a numeric prerelease identifier with a leading zero', async () => {
  await assert.rejects(
    createReferenceDistribution({
      repoRoot: '.',
      outputDirectory: '.',
      version: '1.0.0-01',
      sourceRevision: 'a'.repeat(40),
    }),
    /experimental SemVer/,
  );
});

test('rejects stale or ambiguous safety defaults', async (context) => {
  const cases = [
    {
      name: 'commented public Shell default',
      file: 'packages/managed-agent-server/src/main/resources/application.yml',
      contents:
        "# workspace-shell-enabled: '${QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED:false}'\nworkspace-shell-enabled: '${QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED:true}'\n",
      error: /Public Shell must default to false/,
    },
    {
      name: 'commented lifecycle v2 default',
      file: 'packages/cli/src/serve/hosted-harness-contract.ts',
      contents:
        "/*\nprocess.env[HOSTED_LIFECYCLE_V2_PROFILES_ENV] ?? ''\n*/\nconst profiles = (\n  process.env[HOSTED_LIFECYCLE_V2_PROFILES_ENV] ?? 'hosted-workspace-shell/1'\n).split(',');\n",
      error: /Hosted lifecycle v2 profiles must default to empty/,
    },
    {
      name: 'duplicate public Shell default',
      file: 'packages/managed-agent-server/src/main/resources/application.yml',
      contents:
        "workspace-shell-enabled: '${QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED:false}'\nworkspace-shell-enabled: '${QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED:false}'\n",
      error: /Cannot uniquely read public Shell default/,
    },
  ];

  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const temporary = await mkdtemp(
        path.join(os.tmpdir(), 'qwen-reference-'),
      );
      try {
        const root = path.join(temporary, 'repo');
        await fixture(root);
        await writeFile(path.join(root, candidate.file), candidate.contents);
        await assert.rejects(
          createReferenceDistribution({
            repoRoot: root,
            outputDirectory: path.join(temporary, 'release'),
            version: '0.1.0-alpha.1',
            sourceRevision: 'a'.repeat(40),
          }),
          candidate.error,
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
});

test('publishes verified draft assets behind an exact tag', async () => {
  const workflow = await readFile(
    new URL(
      '../../.github/workflows/release-managed-agent-reference.yml',
      import.meta.url,
    ),
    'utf8',
  );
  const draft = workflow.indexOf('draft:true');
  const upload = workflow.indexOf('gh release upload');
  const assetVerification = workflow.indexOf('actual_names=');
  const digestVerification = workflow.indexOf('remote_digest=');
  const digestMismatch = workflow.indexOf('Uploaded digest mismatch');
  const tag = workflow.indexOf('git/refs');
  const publish = workflow.indexOf('-F draft=false');

  assert.ok(draft >= 0);
  assert.ok(draft < upload);
  assert.ok(upload < assetVerification);
  assert.ok(assetVerification < digestVerification);
  assert.ok(digestVerification < digestMismatch);
  assert.ok(digestMismatch < tag);
  assert.ok(assetVerification < tag);
  assert.ok(tag < publish);
  assert.match(workflow, /Accept: application\/octet-stream/);
  assert.match(workflow, /remote_digest.*!=.*local_digest/);
  assert.match(workflow, /scripts\/contract-version-utils\.js/);
  assert.match(workflow, /scripts\/flyway-migration-utils\.js/);
  assert.match(workflow, /grep -x 'managed-agent-reference-v\.\*'/);
  assert.match(workflow, /previous_tag_name:\$previous/);
});
