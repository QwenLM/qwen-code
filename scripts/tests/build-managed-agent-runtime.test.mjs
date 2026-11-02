import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runtimeBuildCommands } from '../build-managed-agent-runtime.mjs';
import {
  inspectRuntimeArchive,
  runtimeSelection,
} from '../managed-runtime-backends.mjs';
import { runtimeArchiveFixture } from './fixtures/runtime-archive.mjs';

test('normalizes backend selections without changing default full identity', () => {
  assert.deepEqual(
    runtimeSelection('ssh,local,ssh'),
    runtimeSelection('local,ssh'),
  );
  assert.equal(
    runtimeSelection('ssh,local,external,static,kubernetes').classifier,
    'exec',
  );
  for (const bad of ['', 'full,local', 'k8s', 'local,', 'local,unknown']) {
    assert.throws(() => runtimeSelection(bad), /Unknown Runtime backend/);
  }
});

test('repackages exact backends and verifies the artifact without narrowing ordinary Maven dependencies', () => {
  const commands = runtimeBuildCommands(runtimeSelection('ssh,local'), true);
  assert.equal(commands.length, 2);
  assert.ok(commands[0].includes('-Dmanaged.exec.classifier=exec-local-ssh'));
  assert.ok(commands[0].includes('-Dmanaged.operator-tools.attach=false'));
  assert.ok(
    commands[0].includes(
      '-Dspring-boot.excludes=org.projectlombok:lombok,com.alibaba:qwen-managed-agent-runtime-external,com.alibaba:qwen-managed-agent-runtime-kubernetes,com.alibaba:qwen-managed-agent-runtime-static',
    ),
  );
  assert.ok(commands[0].includes('clean'));
  assert.ok(commands[1].includes('-Dtest=ManagedAgentPackagingIT'));
  assert.ok(!commands[1].includes('-DskipTests'));
  const full = runtimeBuildCommands(runtimeSelection())[0];
  assert.ok(full.includes('-Dspring-boot.excludes=org.projectlombok:lombok'));
  assert.ok(
    !full.some((arg) => arg.startsWith('-Dmanaged.operator-tools.attach')),
  );
});

test('reads the actual nested JAR set and refuses metadata that conceals another backend', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-package-'));
  try {
    const file = path.join(root, 'server.jar');
    await runtimeArchiveFixture(file, 'local,ssh');
    assert.deepEqual(
      inspectRuntimeArchive(file, runtimeSelection('ssh,local')).backends,
      ['local', 'ssh'],
    );
    await runtimeArchiveFixture(file, 'full', 'ssh');
    assert.throws(
      () => inspectRuntimeArchive(file, runtimeSelection('ssh')),
      /does not match/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
