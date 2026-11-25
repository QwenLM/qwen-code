/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCliSettingsService } from './createCliSettingsService.js';
import {
  loadSettings,
  loadSettingsWithService,
} from '../test-utils/resolveSettings.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/core';
import { SettingScope,
} from './settings.js';

it('reloads a project Settings snapshot from the shared SettingsService watcher', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'settings-manager-watch-'));
  const filePath = new Storage(workspace).getWorkspaceSettingsPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ context: { fileName: 'old.md' } }));
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  let unwatch: (() => void) | undefined;
  let unwatchBlocked: (() => void) | undefined;
  try {
    const settings = loadSettingsWithService(workspace, service, ['project']);
    settings.setTrusted(true);
    const blocked = loadSettingsWithService(workspace, service, ['project']);
    blocked.setTrusted(true);
    expect(settings.merged.context.fileName).toBe('old.md');
    expect(blocked.merged.context.fileName).toBe('old.md');
    const snapshots: string[] = [];
    const onChange = vi.fn(() =>
      snapshots.push(settings.merged.context.fileName),
    );
    let rewriteInHook = false;
    unwatch = await settings.watchChanges({
      acceptChange: async () => {
        if (!rewriteInHook) return true;
        writeFileSync(
          filePath,
          JSON.stringify({ context: { fileName: 'hook.md' } }),
        );
        return { accepted: true, refreshSource: true };
      },
      onChange,
    });
    const blockedChange = vi.fn();
    unwatchBlocked = await blocked.watchChanges({
      acceptChange: async () => false,
      onChange: blockedChange,
    });
    writeFileSync(
      filePath,
      JSON.stringify({ context: { fileName: 'new.md' } }),
    );
    await vi.waitFor(
      () => {
        expect(settings.merged.context.fileName).toBe('new.md');
        expect(onChange).toHaveBeenCalledWith('projectSettings');
      },
      { timeout: 8000 },
    );
    expect(blocked.merged.context.fileName).toBe('old.md');
    expect(blockedChange).not.toHaveBeenCalled();
    rewriteInHook = true;
    writeFileSync(
      filePath,
      JSON.stringify({ context: { fileName: 'intermediate.md' } }),
    );
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(2), {
      timeout: 8000,
    });
    expect(snapshots[1]).toBe('hook.md');
    expect(blocked.merged.context.fileName).toBe('old.md');
  } finally {
    unwatch?.();
    unwatchBlocked?.();
    await service.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('does not suppress the first external edit after a pre-watch session write', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'settings-manager-late-watch-'));
  const filePath = new Storage(workspace).getWorkspaceSettingsPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ context: { fileName: 'old.md' } }));
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const settings = loadSettingsWithService(workspace, service, ['project']);
  settings.setTrusted(true);
  expect(
    settings.setValue(
      SettingScope.Project,
      ['context', 'fileName'],
      'session.md',
    ),
  ).toBe(true);
  const onChange = vi.fn();
  const stop = await settings.watchChanges({
    acceptChange: async () => true,
    onChange,
  });
  try {
    writeFileSync(
      filePath,
      JSON.stringify({ context: { fileName: 'external.md' } }),
    );
    await vi.waitFor(
      () => expect(settings.merged.context.fileName).toBe('external.md'),
      { timeout: 8000 },
    );
    expect(onChange).toHaveBeenCalledOnce();
  } finally {
    stop();
    await service.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('can attach a plain preloaded projection to SettingsService watching', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'settings-manager-attach-'));
  const filePath = new Storage(workspace).getWorkspaceSettingsPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ context: { fileName: 'old.md' } }));
  const settings = loadSettings(workspace, ['project']);
  settings.setTrusted(true);
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  settings.attachSettingsService(service);
  const stop = await settings.watchChanges({
    acceptChange: async () => true,
    onChange: vi.fn(),
  });
  try {
    writeFileSync(
      filePath,
      JSON.stringify({ context: { fileName: 'new.md' } }),
    );
    await vi.waitFor(
      () => expect(settings.merged.context.fileName).toBe('new.md'),
      { timeout: 8000 },
    );
  } finally {
    stop();
    await service.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('observes project settings creation, deletion and recreation', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'settings-manager-create-'));
  const filePath = new Storage(workspace).getWorkspaceSettingsPath();
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const settings = loadSettingsWithService(workspace, service, ['project']);
  settings.setTrusted(true);
  const onChange = vi.fn();
  const stop = await settings.watchChanges({
    acceptChange: async () => true,
    onChange,
  });
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ context: { fileName: 'new.md' } }),
    );
    await vi.waitFor(
      () => expect(settings.merged.context.fileName).toBe('new.md'),
      { timeout: 8000 },
    );
    expect(onChange).toHaveBeenCalledWith('projectSettings');
    onChange.mockClear();

    rmSync(filePath);
    await vi.waitFor(
      () => {
        expect(settings.project.settings).toEqual({});
        expect(settings.merged.context.fileName).not.toBe('new.md');
        expect(onChange).toHaveBeenCalledWith('projectSettings');
      },
      { timeout: 8000 },
    );
    onChange.mockClear();

    writeFileSync(
      filePath,
      JSON.stringify({ context: { fileName: 'recreated.md' } }),
    );
    await vi.waitFor(
      () => {
        expect(settings.merged.context.fileName).toBe('recreated.md');
        expect(onChange).toHaveBeenCalledWith('projectSettings');
      },
      { timeout: 8000 },
    );
  } finally {
    stop();
    await service.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('delivers a session write to another session without echoing to the writer', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'settings-manager-write-'));
  const filePath = new Storage(workspace).getWorkspaceSettingsPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ context: { fileName: 'old.md' } }));
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const writer = loadSettingsWithService(workspace, service, ['project']);
  const reader = loadSettingsWithService(workspace, service, ['project']);
  writer.setTrusted(true);
  reader.setTrusted(true);
  const writerHook = vi.fn(async () => true);
  const readerHook = vi.fn(async () => true);
  const stopWriter = await writer.watchChanges({
    acceptChange: writerHook,
    onChange: vi.fn(),
  });
  const stopReader = await reader.watchChanges({
    acceptChange: readerHook,
    onChange: vi.fn(),
  });
  try {
    expect(
      writer.setValue(SettingScope.Project, ['context', 'fileName'], 'new.md'),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(reader.merged.context.fileName).toBe('new.md'),
    );
    expect(writerHook).not.toHaveBeenCalled();
    expect(readerHook).toHaveBeenCalledTimes(1);
  } finally {
    stopWriter();
    stopReader();
    await service.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('explicit reload bypasses a rejecting watcher hook and updates the same session', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'settings-explicit-reload-'));
  const filePath = new Storage(workspace).getWorkspaceSettingsPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ context: { fileName: 'old.md' } }));
  const service = createCliSettingsService({ environmentPolicy: 'session' });
  const settings = loadSettingsWithService(workspace, service, ['project']);
  settings.setTrusted(true);
  const acceptChange = vi.fn(async () => false);
  const onChange = vi.fn();
  const changed = vi.fn();
  settings.subscribe(changed);
  const stop = await settings.watchChanges({ acceptChange, onChange });
  try {
    writeFileSync(filePath, JSON.stringify({ context: { fileName: 'blocked.md' } }));
    await vi.waitFor(() => expect(acceptChange).toHaveBeenCalled(), { timeout: 8000 });
    expect(settings.merged.context.fileName).toBe('old.md');
    expect(onChange).not.toHaveBeenCalled();
    acceptChange.mockClear();
    settings.reload();
    expect(settings.merged.context.fileName).toBe('blocked.md');
    expect(acceptChange).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    // Subsequent automatic edits still require approval.
    writeFileSync(filePath, JSON.stringify({ context: { fileName: 'blocked-again.md' } }));
    await vi.waitFor(() => expect(acceptChange).toHaveBeenCalled(), { timeout: 8000 });
    expect(settings.merged.context.fileName).toBe('blocked.md');
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    stop();
    await service.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
});
