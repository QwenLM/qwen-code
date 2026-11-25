/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SettingsSourceStore } from './settingsFileSource.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('shares user and project reads independently and refreshes after invalidation', () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-sources-'));
  roots.push(root);
  const userPath = join(root, 'user.json');
  const projectPath = join(root, 'project.json');
  const localPath = join(root, 'local.json');
  writeFileSync(userPath, 'user-1');
  writeFileSync(projectPath, 'project-1');
  const store = new SettingsSourceStore();
  const user = store.getUser(userPath);
  const project = store.getProject(projectPath, localPath);

  expect(store.getUser(userPath)).toBe(user);
  expect(store.getProject(projectPath, localPath)).toBe(project);
  expect(user.read()).toBe('user-1');
  expect(project.project.read()).toBe('project-1');
  expect(project.local.read()).toBeUndefined();

  writeFileSync(userPath, 'user-2');
  writeFileSync(projectPath, 'project-2');
  writeFileSync(localPath, 'local-2');
  expect(user.read()).toBe('user-1');
  expect(project.project.read()).toBe('project-1');
  store.invalidateAll();
  expect(user.read()).toBe('user-2');
  expect(project.project.read()).toBe('project-2');
  expect(project.local.read()).toBe('local-2');
});

it('rejects a second user root in one service', () => {
  const store = new SettingsSourceStore();
  store.getUser(join(tmpdir(), 'user-a', 'settings.json'));
  expect(() => store.getUser(join(tmpdir(), 'user-b', 'settings.json'))).toThrow(
    'User settings root is already fixed',
  );
});

it('keeps an absent source absent after a no-op transaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-source-missing-'));
  roots.push(root);
  const store = new SettingsSourceStore();
  try {
    const source = store.getUser(join(root, 'settings.json'));
    expect(source.read()).toBeUndefined();
    expect(source.mutate(() => false).changed).toBe(false);
    expect(source.read()).toBeUndefined();
  } finally {
    await store.dispose();
  }
});

it('rejects new source and watcher access after disposal begins', async () => {
  const store = new SettingsSourceStore();
  await store.dispose();

  expect(() => store.getUser(join(tmpdir(), 'disposed-user.json'))).toThrow(
    'disposing or disposed',
  );
  expect(() =>
    store.getProject(
      join(tmpdir(), 'disposed-project.json'),
      join(tmpdir(), 'disposed-local.json'),
    ),
  ).toThrow('disposing or disposed');
  await expect(
    store.watchFile(join(tmpdir(), 'disposed-watch.json'), () => undefined),
  ).rejects.toThrow('disposing or disposed');
});
