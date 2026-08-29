/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from 'vitest';
import { TestRig } from '../test-helper.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const extension = `{
  "name": "test-extension",
  "version": "0.0.1"
}`;

const extensionUpdate = `{
  "name": "test-extension",
  "version": "0.0.2"
}`;

test('installs a local extension, verifies a command, and updates it', async () => {
  const rig = new TestRig();
  await rig.setup('extension install test');
  const testServerPath = join(rig.testDir!, 'qwen-extension.json');
  writeFileSync(testServerPath, extension);
  try {
    await rig.runCommand(['extensions', 'uninstall', 'test-extension']);
  } catch {
    /* empty */
  }

  const result = await rig.runCommand(
    ['extensions', 'install', `${rig.testDir!}`],
    { stdin: 'y\n' },
  );
  expect(result).toContain('test-extension');

  const listResult = await rig.runCommand(['extensions', 'list']);
  expect(listResult).toContain('test-extension');
  writeFileSync(testServerPath, extensionUpdate);
  const updateResult = await rig.runCommand([
    'extensions',
    'update',
    `test-extension`,
  ]);
  expect(updateResult).toContain('0.0.2');

  await rig.runCommand(['extensions', 'uninstall', 'test-extension']);

  await rig.cleanup();
});

test('installs a local Qoder plugin', async () => {
  const rig = new TestRig();
  await rig.setup('qoder plugin install test');
  const manifestDir = join(rig.testDir!, '.qoder-plugin');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, 'plugin.json'),
    JSON.stringify({ name: 'sample-qoder-plugin', version: '1.0.0' }),
  );
  writeFileSync(join(rig.testDir!, 'system-prompt.md'), '# System context');
  const skillDir = join(rig.testDir!, 'skills', 'sample-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: sample-skill\ndescription: Synthetic skill\n---\n',
  );

  try {
    await rig.runCommand(['extensions', 'uninstall', 'sample-qoder-plugin']);
  } catch {
    // The extension is not installed yet.
  }
  try {
    const result = await rig.runCommand(
      ['extensions', 'install', rig.testDir!],
      { stdin: 'y\n' },
    );
    expect(result).toContain('sample-qoder-plugin');

    const listResult = await rig.runCommand(['extensions', 'list']);
    expect(listResult).toContain('sample-qoder-plugin');
  } finally {
    try {
      await rig.runCommand(['extensions', 'uninstall', 'sample-qoder-plugin']);
    } catch {
      // Installation may have failed before the extension was registered.
    }
    await rig.cleanup();
  }
});
