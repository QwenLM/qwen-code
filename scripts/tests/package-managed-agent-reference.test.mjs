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
  readdir,
  readFile,
  realpath,
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
  accountCanEnter,
  directoriesToEnter,
  generateSecrets,
  lookupServiceUser,
  renderApplicationYml,
  renderHarnessEnv,
  renderMysqlSetup,
  renderServerEnv,
} from '../../packages/managed-agent-server/distribution/bin/qwen-managed-agent-bootstrap.mjs';
import {
  ADMIN_COMMANDS,
  createReferenceDistribution,
} from '../package-managed-agent-reference.mjs';

function mainSource(main) {
  return `packages/managed-agent-server/src/main/java/${main.replaceAll('.', '/')}.java`;
}

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
    'packages/managed-agent-server/target/qwen-managed-agent-server-0.4.0-alpha-exec.jar':
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
    'packages/managed-agent-server/distribution/bin/qwen-managed-agent-upgrade':
      '#!/usr/bin/env sh\nupgrade\n',
    'packages/managed-agent-server/distribution/bin/qwen-managed-agent-upgrade.mjs':
      'export {};\n',
    'packages/managed-agent-server/src/main/resources/openapi/managed-agent-public-api.openapi.json':
      JSON.stringify({ info: { version: '1.46.0' } }),
    'packages/managed-agent-server/src/main/resources/db/managed-schema/V1__baseline.sql':
      'select 1;',
    'packages/managed-agent-server/src/main/java/db/migration/V9__latest.java':
      'class Latest {}',
    'packages/cli/src/serve/capabilities.ts':
      "export const SERVE_PROTOCOL_VERSION = 'v1' as const;\n",
    'packages/cli/src/serve/managed-runtime-broker-client.ts':
      'export const MANAGED_RUNTIME_BROKER_PROTOCOL_VERSION = 2 as const;\n',
    'packages/cli/src/serve/hosted-harness-contract.ts':
      "const profiles = (\n  process.env[HOSTED_LIFECYCLE_V2_PROFILES_ENV] ?? 'hosted-workspace-shell/1'\n).split(',');\n",
    'docs/users/managed-agent-reference-deployment.md': 'deploy\n',
    'docs/users/managed-agent-reference-deployment.zh-CN.md': '部署\n',
    'docs/users/hosted-workspace-recovery.md': 'recover\n',
    'docs/users/hosted-workspace-recovery.zh-CN.md': '恢复\n',
    'packages/managed-agent-server/README.md': 'server reference\n',
  };
  for (const [, main] of ADMIN_COMMANDS) {
    files[mainSource(main)] =
      'class Main { public static void main(String[] args) {} }\n';
  }
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
      v2CapabilityAdvertisementEnabled: true,
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
    const upgrade = path.join(bundle, 'bin/qwen-managed-agent-upgrade');
    assert.equal(
      await readFile(upgrade, 'utf8'),
      '#!/usr/bin/env sh\nupgrade\n',
    );
    assert.equal((await stat(upgrade)).mode & 0o777, 0o755);
    for (const module of [
      'qwen-managed-agent-bootstrap.mjs',
      'qwen-managed-agent-upgrade.mjs',
    ]) {
      assert.equal(
        await readFile(path.join(bundle, 'bin', module), 'utf8'),
        'export {};\n',
      );
    }
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

    // One server jar runs every maintenance entry point.
    const admin = path.join(bundle, 'bin/qwen-managed-agent-admin');
    const registration = run(admin, [
      'storage-registration',
      'inspect',
      't',
      's',
    ]);
    assert.ok(registration.includes(`ENV=file:${config}`));
    assert.deepEqual(
      registration.split('\n').filter((line) => line.startsWith('ARG=')),
      [
        'ARG=-Dloader.main=com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageRegistrationMain',
        'ARG=-cp',
        `ARG=${bundle}/lib/qwen-managed-agent-server-0.4.0-alpha.jar`,
        'ARG=org.springframework.boot.loader.launch.PropertiesLauncher',
        'ARG=inspect',
        'ARG=t',
        'ARG=s',
      ],
    );
    for (const [name, main] of ADMIN_COMMANDS) {
      assert.ok(
        run(admin, [name]).includes(`ARG=-Dloader.main=${main}\n`),
        name,
      );
    }
    const help = run(admin, []);
    for (const [name, , summary] of ADMIN_COMMANDS) {
      assert.match(
        help,
        new RegExp(`^  ${name} +${summary.replace('.', '\\.')}$`, 'm'),
      );
    }
    assert.ok(!help.includes('ARG='), 'help runs no Java');
    assert.throws(
      () => run(admin, ['no-such-command'], {}),
      (error) =>
        error.status === 2 &&
        String(error.stderr).includes('unknown command: no-such-command'),
    );

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

test('refuses an admin command whose entry point is gone', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qwen-reference-'));
  try {
    const root = path.join(temporary, 'repo');
    await fixture(root);
    const [name, main] = ADMIN_COMMANDS[0];
    const source = path.join(root, mainSource(main));
    await writeFile(source, 'class Main {}\n');
    const build = () =>
      createReferenceDistribution({
        repoRoot: root,
        outputDirectory: path.join(temporary, 'release'),
        version: '0.1.0-alpha.1',
        sourceRevision: 'a'.repeat(40),
      });
    await assert.rejects(
      build,
      new RegExp(`${name}: ${main} has no main method`),
    );
    await rm(source);
    await assert.rejects(
      build,
      new RegExp(`${name} names a missing class ${main}`),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('maps every admin command to an entry point in the server', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const names = ADMIN_COMMANDS.map(([name]) => name);
  assert.equal(new Set(names).size, names.length);
  for (const [name, main] of ADMIN_COMMANDS) {
    assert.match(name, /^[a-z]+(-[a-z]+)*$/);
    assert.match(
      await readFile(path.join(root, mainSource(main)), 'utf8'),
      /public static void main\(String/,
      name,
    );
  }
  // And the other way: a new entry point needs a command too. The server
  // application is the one main the admin launcher does not run.
  const sources = path.join(
    root,
    'packages/managed-agent-server/src/main/java',
  );
  const mains = [];
  for (const file of await readdir(sources, { recursive: true })) {
    if (
      file.endsWith('.java') &&
      /public static void main\(String/.test(
        await readFile(path.join(sources, file), 'utf8'),
      )
    ) {
      mains.push(file.slice(0, -'.java'.length).replaceAll(path.sep, '.'));
    }
  }
  assert.deepEqual(
    mains
      .filter(
        (main) =>
          main !==
          'com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication',
      )
      .sort(),
    ADMIN_COMMANDS.map(([, main]) => main).sort(),
  );
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
  // A JVM stopped by SIGTERM exits 143; without this the stopped unit fails.
  assert.match(server, /^SuccessExitStatus=143$/m);
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
  // The Broker token reaches the Harness through harness.env, never argv.
  assert.doesNotMatch(harness, /BROKER/);
  assert.match(
    harness,
    /^EnvironmentFile=\/etc\/qwen-managed-agent\/harness\.env$/m,
  );
  assert.match(
    harness,
    /^ExecStart=\/usr\/local\/bin\/qwen serve --profile hosted-harness --hostname 127\.0\.0\.1 --port 4170 --no-web$/m,
  );
  assert.ok(server.endsWith('\n'));
  assert.ok(harness.endsWith('\n'));
  assert.doesNotMatch(server, /\t/);
  assert.doesNotMatch(harness, /\t/);
});

test('bootstrap renders matching credentials and a 32-byte key', () => {
  const secrets = generateSecrets('reference-test');
  assert.match(secrets.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Buffer.from(secrets.credentialKey, 'base64').length, 32);
  const harness = renderHarnessEnv(secrets);
  assert.ok(harness.includes(secrets.token));
  // The control plane refuses a `;` comment, which a shell stops reading the file at.
  assert.doesNotMatch(harness, /^\s*;/m);
  assert.ok(
    harness
      .split('\n')
      .includes(`QWEN_MANAGED_RUNTIME_BROKER_TOKEN=${secrets.brokerToken}`),
  );
  assert.match(
    harness,
    /^QWEN_MANAGED_RUNTIME_BROKER_URL=http:\/\/127\.0\.0\.1:4182$/m,
  );
  const paths = {
    databasePassword: secrets.databasePassword,
    applicationConfigPath: '/tmp/application.yml',
    harnessEnvPath: '/tmp/harness.env',
  };
  const server = renderServerEnv(paths);
  assertReadsHarnessCredentials(server, secrets, '/tmp/harness.env');
  assertDerivesSessionStoreWiring(server);
  assert.ok(
    server
      .split('\n')
      .includes(`SPRING_DATASOURCE_PASSWORD=${secrets.databasePassword}`),
  );
  assert.doesNotMatch(server, /SERVICE_USER/);
  assert.match(
    renderServerEnv({ ...paths, serviceUser: 'qwen-managed-agent' }),
    /^QWEN_MANAGED_AGENT_SERVICE_USER=qwen-managed-agent$/m,
  );
  assert.match(
    renderApplicationYml(secrets),
    /credential-key-id: 'reference-test'/,
  );
});

test('bootstrap writes the MySQL setup for the generated password', () => {
  const secrets = generateSecrets();
  assert.match(secrets.databasePassword, /^[0-9a-f]{64}$/);
  const sql = renderMysqlSetup(secrets);
  const statements = sql.split('\n').filter((line) => !line.startsWith('--'));
  assert.deepEqual(statements, [
    'CREATE DATABASE qwen_managed_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    `CREATE USER 'qwen'@'localhost' IDENTIFIED BY '${secrets.databasePassword}';`,
    `CREATE USER 'qwen'@'127.0.0.1' IDENTIFIED BY '${secrets.databasePassword}';`,
    "GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'localhost';",
    "GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'127.0.0.1';",
    "GRANT SELECT ON performance_schema.user_variables_by_thread TO 'qwen'@'localhost';",
    "GRANT SELECT ON performance_schema.user_variables_by_thread TO 'qwen'@'127.0.0.1';",
    '',
  ]);
});

test('bootstrap resolves the service account before changing owners', () => {
  const ids = { '-u': [990], '-g': [985], '-G': [985, 4] };
  const lookup = (flag) => ids[flag];
  assert.deepEqual(
    lookupServiceUser('qwen-managed-agent', { lookup, uid: 0 }),
    { uid: 990, gid: 985, groups: [985, 4] },
  );
  // The name is written unquoted into server.env.
  for (const name of ['', 'Qwen', '-x', 'a b', 'a;b', 'x'.repeat(33)]) {
    assert.match(
      lookupServiceUser(name, { lookup, uid: 0 }).error,
      /must be a user name/,
    );
  }
  assert.match(
    lookupServiceUser('qwen-managed-agent', { lookup, uid: 1000 }).error,
    /run the bootstrap as root/,
  );
  assert.match(
    lookupServiceUser('missing', {
      lookup: () => {
        throw new Error('no such user');
      },
      uid: 0,
    }).error,
    /User missing does not exist/,
  );
});

test('bootstrap checks directory entry the way the kernel does', () => {
  const account = { uid: 990, gid: 985, groups: [985, 4] };
  // The owner bits alone apply to the owner, even when others may enter.
  assert.equal(
    accountCanEnter({ uid: 990, gid: 0, mode: 0o055 }, account),
    false,
  );
  assert.equal(
    accountCanEnter({ uid: 990, gid: 0, mode: 0o700 }, account),
    true,
  );
  assert.equal(accountCanEnter({ uid: 0, gid: 4, mode: 0o750 }, account), true);
  assert.equal(
    accountCanEnter({ uid: 0, gid: 4, mode: 0o705 }, account),
    false,
  );
  assert.equal(accountCanEnter({ uid: 0, gid: 0, mode: 0o755 }, account), true);
  assert.equal(
    accountCanEnter({ uid: 0, gid: 0, mode: 0o750 }, account),
    false,
  );
});

test('bootstrap follows symbolic links to the directories the account enters', async () => {
  const temporary = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'qwen-bootstrap-links-')),
  );
  try {
    const target = path.join(temporary, 'private', 'config');
    await mkdir(target, { recursive: true });
    await mkdir(path.join(temporary, 'etc'));
    const absolute = path.join(temporary, 'etc', 'qwen-managed-agent');
    await symlink(target, absolute);
    const relative = path.join(temporary, 'etc', 'relative');
    await symlink(path.join('..', 'private', 'config'), relative);
    for (const link of [absolute, relative]) {
      const entered = await directoriesToEnter(link);
      // The directory holding the link, and one that only the target names.
      assert.ok(entered.includes(path.join(temporary, 'etc')), link);
      assert.ok(entered.includes(path.join(temporary, 'private')), link);
      assert.equal(entered.at(-1), target, link);
    }
    await symlink('loop-b', path.join(temporary, 'loop-a'));
    await symlink('loop-a', path.join(temporary, 'loop-b'));
    await assert.rejects(
      directoriesToEnter(path.join(temporary, 'loop-a')),
      /Too many symbolic links/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
    const digest = harness.match(
      /^QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST=(sha256:[0-9a-f]{64})$/m,
    )[1];
    const brokerToken = harness.match(
      /^QWEN_MANAGED_RUNTIME_BROKER_TOKEN=([0-9a-f]{64})$/m,
    )[1];
    assertReadsHarnessCredentials(
      server,
      { token, digest, brokerToken },
      path.join(directory, 'harness.env'),
    );
    assert.match(application, /credential-key: '[A-Za-z0-9+/=]{44}'/);
    const sql = await readFile(path.join(directory, 'mysql-setup.sql'), 'utf8');
    const password = server.match(
      /^SPRING_DATASOURCE_PASSWORD=([0-9a-f]{64})$/m,
    )[1];
    assert.ok(sql.includes(`IDENTIFIED BY '${password}';`));
    for (const name of [
      'harness.env',
      'server.env',
      'application.yml',
      'mysql-setup.sql',
    ]) {
      assert.equal(
        (await stat(path.join(directory, name))).mode & 0o777,
        0o600,
      );
    }
    for (const secret of [token, digest, brokerToken, password]) {
      assert.ok(!output.includes(secret));
    }
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

test(
  'bootstrap gives the service account its files',
  { skip: process.getuid?.() !== 0 && 'needs root to change owners' },
  async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), 'qwen-bootstrap-owner-'),
    );
    try {
      const script = fileURLToPath(
        new URL(
          '../../packages/managed-agent-server/distribution/bin/' +
            'qwen-managed-agent-bootstrap.mjs',
          import.meta.url,
        ),
      );
      const user = 'nobody';
      const ids = (flag) =>
        execFileSync('id', [flag, user], { encoding: 'utf8' })
          .trim()
          .split(/\s+/)
          .map(Number);
      const [uid] = ids('-u');
      const [gid] = ids('-g');
      const directory = path.join(temporary, 'config');
      const run = (target = directory) =>
        execFileSync(
          process.execPath,
          [script, '--directory', target, '--service-user', user],
          { encoding: 'utf8', stdio: 'pipe' },
        );
      // mkdtemp's 0700 parent keeps the account out, so nothing is written.
      assert.throws(run, (error) =>
        String(error.stderr).includes(`${user} cannot enter ${temporary}`),
      );
      await chmod(temporary, 0o755);
      await rm(directory, { recursive: true, force: true });
      run();
      const owners = {
        '.': [0, gid, 0o750],
        'harness.env': [uid, gid, 0o600],
        'application.yml': [uid, gid, 0o600],
        'server.env': [0, gid, 0o640],
        'mysql-setup.sql': [0, 0, 0o600],
      };
      for (const [name, expected] of Object.entries(owners)) {
        const info = await stat(path.join(directory, name));
        assert.deepEqual(
          [info.uid, info.gid, info.mode & 0o777],
          expected,
          name,
        );
      }
      assert.match(
        await readFile(path.join(directory, 'server.env'), 'utf8'),
        /^QWEN_MANAGED_AGENT_SERVICE_USER=nobody$/m,
      );
      // A 0700 directory reached only through a symbolic link keeps the
      // account out too.
      const hidden = path.join(temporary, 'private');
      await mkdir(path.join(hidden, 'config'), { recursive: true });
      await chmod(hidden, 0o700);
      const linked = path.join(temporary, 'linked');
      await symlink(path.join(hidden, 'config'), linked);
      assert.throws(
        () => run(linked),
        (error) =>
          String(error.stderr).includes(`${user} cannot enter ${hidden}`),
      );
      assert.deepEqual(await readdir(path.join(hidden, 'config')), []);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

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

test('leaves the Session Store wiring to the server defaults in the env template', async () => {
  const template = await readFile(
    new URL(
      '../../packages/managed-agent-server/distribution/systemd/server.env.example',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(template, /^QWEN_MANAGED_AGENT_HARNESS_ENABLED=true$/m);
  assertDerivesSessionStoreWiring(template);
  assert.doesNotMatch(
    template,
    /^QWEN_MANAGED_AGENT_(HARNESS_TOKEN|CAPABILITY_DIGEST)=/m,
  );
  assert.doesNotMatch(template, /RUNTIME_BROKER_TOKEN/);
  assert.match(
    template,
    /^QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE=\/etc\/qwen-managed-agent\/harness\.env$/m,
  );
});

// The server derives the store switch, URL and workspace ID; an explicit
// workspace ID would conflict with the local-process Broker's derived one.
function assertDerivesSessionStoreWiring(env) {
  assert.doesNotMatch(env, /^QWEN_MANAGED_AGENT_SESSION_STORE_/m);
  assert.doesNotMatch(env, /^QWEN_MANAGED_AGENT_WORKSPACE_ID=/m);
  assert.match(
    env,
    /^QWEN_MANAGED_AGENT_WORKSPACE_CWD=\/srv\/qwen-workspace$/m,
  );
}

// harness.env is the one copy of the shared credentials; server.env names it.
function assertReadsHarnessCredentials(
  server,
  { token, digest, brokerToken },
  harnessEnv,
) {
  assert.ok(!server.includes(token));
  assert.ok(!server.includes(digest));
  assert.ok(!server.includes(brokerToken));
  assert.doesNotMatch(
    server,
    /^QWEN_MANAGED_AGENT_(HARNESS_TOKEN|CAPABILITY_DIGEST|RUNTIME_BROKER_TOKEN)=/m,
  );
  assert.ok(
    server
      .split('\n')
      .includes(`QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE='${harnessEnv}'`),
  );
}

test('ships the Harness credential keys the control plane reads', async () => {
  const template = await readFile(
    new URL(
      '../../packages/managed-agent-server/distribution/systemd/harness.env.example',
      import.meta.url,
    ),
    'utf8',
  );
  // The control plane matches these keys exactly, from the start of a line,
  // and accepts only these characters in their values.
  assert.match(template, /^QWEN_SERVER_TOKEN=[A-Za-z0-9._:/+=-]+$/m);
  assert.match(
    template,
    /^QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST=sha256:[A-Za-z0-9._:/+=-]+$/m,
  );
  // It refuses a `;` comment, which a shell stops reading the file at.
  assert.doesNotMatch(template, /^\s*;/m);
  // The tool path's pair ships commented, for the operator to enable together.
  assert.match(
    template,
    /^# QWEN_MANAGED_RUNTIME_BROKER_URL=http:\/\/127\.0\.0\.1:4182$/m,
  );
  assert.match(
    template,
    /^# QWEN_MANAGED_RUNTIME_BROKER_TOKEN=[A-Za-z0-9._:/+=-]+$/m,
  );
  assert.doesNotMatch(template, /^#? *QWEN_HOSTED_HARNESS_BROKER_ARGS=/m);
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
        "/*\nprocess.env[HOSTED_LIFECYCLE_V2_PROFILES_ENV] ?? 'hosted-workspace-shell/1'\n*/\nconst profiles = (\n  process.env[HOSTED_LIFECYCLE_V2_PROFILES_ENV] ?? ''\n).split(',');\n",
      error:
        /Hosted lifecycle v2 profiles must default to canonical Shell only/,
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
