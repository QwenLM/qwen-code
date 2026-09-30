import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { liveMessage, type LiveMessageKey } from '@qwen-code/qwen-live/i18n';
import type { HostPublicState } from '../../shared/host-api.ts';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile(
  'index.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set(['isTrustedSender', 'registerIpc', 'publicState']);
const functions = tree.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
);
assert.equal(functions.length, names.size);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
type Handler = (...args: unknown[]) => unknown;
const errorCode = (key: LiveMessageKey) => (error: unknown) =>
  Boolean(
    error &&
      typeof error === 'object' &&
      'message' in error &&
      error.message === liveMessage(key),
  );

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-live-open-config-'));
  directories.push(directory);
  const dataDir = join(directory, '自定义 Live data');
  mkdirSync(dataDir);
  const path = join(dataDir, 'config.json');
  const content = '{"language":"en"}\n';
  writeFileSync(path, content, { mode: 0o600 });
  const opened: string[] = [];
  const flags = {
    configPath: path as string | undefined,
    destroyed: false,
    openError: '' as string | Error,
  };
  const handlers = new Map<string, Handler>();
  const context = {
    ipcMain: {
      on: (channel: string, callback: Handler) =>
        handlers.set(channel, callback),
      handle: (channel: string, callback: Handler) =>
        handlers.set(channel, callback),
    },
    overlay: { isDestroyed: () => flags.destroyed, webContents: {} },
    rendererEventsEnabled: true,
    quitState: undefined as HostPublicState['quitState'],
    connection: { phase: 'ready' },
    daemon: { getConfigFilePath: () => flags.configPath },
    lstatSync,
    shell: {
      openPath: async (openedPath: string) => {
        opened.push(openedPath);
        if (flags.openError instanceof Error) throw flags.openError;
        return flags.openError;
      },
    },
    liveMessage,
    theme: 'system',
    resolvedTheme: () => 'light',
    language: 'en',
    overlayOffset: { x: 0, y: 0 },
    visualInput: undefined,
    visualError: undefined,
    visualReady: false,
    screenDisplays: [],
    screenDisplaysError: undefined,
    permissions: {},
    selfChecks: {},
    effectiveLiveStatus: () => ({
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+E',
    }),
  };
  const code = `${functions.map((node) => node.getText(tree)).join('\n')}\nregisterIpc(); ({ publicState });`;
  const controls = runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  ) as { publicState: () => HostPublicState };
  const openConfig = handlers.get('live:open-config');
  assert(openConfig);
  return {
    path,
    content,
    dataDir,
    flags,
    context,
    controls,
    opened,
    open: (sender: unknown = context.overlay.webContents, ...args: unknown[]) =>
      openConfig({ sender }, ...args) as Promise<void>,
  };
}

describe('native config-file opening', () => {
  it('opens only the active config and exposes availability, not the private path', async () => {
    const h = fixture();
    const state = h.controls.publicState();
    assert.equal(state.canOpenConfig, true);
    assert.equal(JSON.stringify(state).includes(h.path), false);
    await h.open(h.context.overlay.webContents, '/another/config.json');
    assert.deepEqual(h.opened, [h.path]);
    assert.equal(readFileSync(h.path, 'utf8'), h.content);
    assert.equal(lstatSync(h.path).mode & 0o777, 0o600);
  });

  it('rejects foreign/stale renderers, reload, Quit and unavailable connections', async () => {
    const h = fixture();
    const unavailable = errorCode('host.config.unavailable');
    await assert.rejects(h.open({}), unavailable);
    const stale = h.context.overlay.webContents;
    h.context.overlay.webContents = {};
    await assert.rejects(h.open(stale), unavailable);
    h.flags.destroyed = true;
    await assert.rejects(h.open(), unavailable);
    h.flags.destroyed = false;
    h.context.rendererEventsEnabled = false;
    await assert.rejects(h.open(), unavailable);
    h.context.rendererEventsEnabled = true;
    for (const quitState of ['pending', 'failed'] as const) {
      h.context.quitState = quitState;
      assert.equal(h.controls.publicState().canOpenConfig, false);
      await assert.rejects(h.open(), unavailable);
    }
    h.context.quitState = undefined;
    h.context.connection.phase = 'disconnected';
    assert.equal(h.controls.publicState().canOpenConfig, false);
    await assert.rejects(h.open(), unavailable);
    h.context.connection.phase = 'ready';
    h.flags.configPath = undefined;
    assert.equal(h.controls.publicState().canOpenConfig, false);
    await assert.rejects(h.open(), unavailable);
    assert.deepEqual(h.opened, []);
  });

  it('does not create missing config files or open directories and symlinks', async () => {
    const h = fixture();
    const inaccessible = errorCode('host.config.inaccessible');
    unlinkSync(h.path);
    await assert.rejects(h.open(), inaccessible);
    assert.deepEqual(readdirSync(h.dataDir), []);
    mkdirSync(h.path);
    await assert.rejects(h.open(), inaccessible);
    rmSync(h.path, { recursive: true });
    const target = join(h.dataDir, 'other.json');
    writeFileSync(target, h.content);
    symlinkSync(target, h.path);
    await assert.rejects(h.open(), inaccessible);
    assert.equal(readFileSync(target, 'utf8'), h.content);
    assert.deepEqual(h.opened, []);
  });

  it('handles native opener error strings and rejections without exposing details, and allows retry', async () => {
    const h = fixture();
    for (const failure of [
      'private launch details',
      new Error('private launch details'),
    ]) {
      h.flags.openError = failure;
      await assert.rejects(h.open(), errorCode('host.config.openFailed'));
    }
    h.flags.openError = '';
    await h.open();
    assert.deepEqual(h.opened, [h.path, h.path, h.path]);
    assert.equal(readFileSync(h.path, 'utf8'), h.content);
  });
});
