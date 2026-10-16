/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
