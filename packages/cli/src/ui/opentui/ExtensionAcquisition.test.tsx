// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import type { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
  decodePasteBytes: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
}));
vi.mock('@opentui/react', () => ({
  useKeyboard: () => {},
  usePaste: () => {},
  useTerminalDimensions: () => ({ width: 100, height: 40 }),
}));
vi.mock('@opentui/react/jsx-runtime', () => ({
  jsx: () => null,
  jsxs: () => null,
}));
vi.mock('@opentui/react/jsx-dev-runtime', () => ({ jsxDEV: () => null }));
vi.mock('./theme.js', () => ({ C: {}, SYNTAX: {} }));

import {
  useExtensionAcquisition,
  type ExtensionCatalogContext,
} from './ExtensionAcquisition.js';

type Metadata = Awaited<ReturnType<ExtensionManager['parseInstallSource']>>;
type Extension = Awaited<ReturnType<ExtensionManager['installExtension']>>;
type Acquisition = ReturnType<typeof useExtensionAcquisition>;
type Outcome =
  | { ok: true; status: Awaited<ReturnType<Acquisition['install']>> }
  | { ok: false; error: unknown };
const extension = { name: 'owned' } as Extension;
const setting = {
  name: 'Owned token',
  description: 'Required owned token',
  envVar: 'OWNED_TOKEN',
};
const consent = {
  originSource: 'QwenCode' as const,
  extensionConfig: {
    name: 'owned',
    version: '1.0.0',
    mcpServers: { owned: { command: 'owned-command' } },
  },
};
function metadata(): Metadata {
  return { source: '/owned/marketplace', type: 'local' };
}
function marketplaceMetadata(): Metadata {
  return {
    ...metadata(),
    marketplaceConfig: {
      name: 'owned-market',
      owner: { name: 'Owned', email: 'owned@example.invalid' },
      plugins: [
        { name: 'first', version: '1.0.0', source: './first' },
        { name: 'chosen', version: '1.0.0', source: './chosen' },
      ],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(initial = metadata()) {
  const methods = {
    parseInstallSource: vi
      .fn<ExtensionManager['parseInstallSource']>()
      .mockResolvedValue(initial),
    installExtension: vi
      .fn<ExtensionManager['installExtension']>()
      .mockResolvedValue(extension),
    setExtensionScope: vi.fn<ExtensionManager['setExtensionScope']>(),
    // These global callbacks must remain untouched by the hook.
    requestConsent: vi.fn(),
    requestChoicePlugin: vi.fn(),
    requestSetting: vi.fn(),
  };
  const context: ExtensionCatalogContext = {
    manager: methods as unknown as ExtensionManager,
    cwd: '/owned/workspace',
    isCurrent: () => true,
    reload: vi.fn(async () => {}),
    onChanged: vi.fn(),
    onStatus: vi.fn(),
  };
  const hook = renderHook(({ owner }) => useExtensionAcquisition(owner), {
    initialProps: { owner: context },
  });
  return { methods, context, hook };
}
async function begin(
  hook: { result: { current: Acquisition } },
  scope: 'user' | 'project' = 'user',
  remember = false,
) {
  let outcome!: Promise<Outcome>;
  await act(async () => {
    outcome = hook.result.current.install('./owned', scope, remember).then(
      (status) => ({ ok: true as const, status }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  });
  return { outcome };
}
async function finish(run: { outcome: Promise<Outcome> }) {
  let outcome!: Outcome;
  await act(async () => {
    outcome = await run.outcome;
  });
  return outcome;
}
function permission<K extends NonNullable<Acquisition['permission']>['kind']>(
  hook: { result: { current: Acquisition } },
  kind: K,
): Extract<NonNullable<Acquisition['permission']>, { kind: K }> {
  const shown = hook.result.current.permission;
  if (!shown || shown.kind !== kind)
    throw new Error(`Expected ${kind} permission`);
  return shown as Extract<NonNullable<Acquisition['permission']>, { kind: K }>;
}
function expectCancelled(outcome: Outcome, text: string) {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toEqual(new Error(text));
}
afterEach(cleanup);

describe('useExtensionAcquisition', () => {
  it('parses the captured cwd, selects the nondefault unique plugin and uses operation-local permissions', async () => {
    const f = fixture(marketplaceMetadata());
    const receivedSettings: string[] = [];
    f.methods.installExtension.mockImplementation(
      async (_metadata, askConsent, askSetting) => {
        await askConsent!(consent);
        receivedSettings.push(await askSetting!(setting));
        return extension;
      },
    );
    const run = await begin(f.hook, 'project', true);
    expect(f.methods.parseInstallSource).toHaveBeenCalledExactlyOnceWith(
      './owned',
      '/owned/workspace',
    );
    expect(f.methods.installExtension).not.toHaveBeenCalled();
    expect(f.hook.result.current.pending).toBe(true);
    await act(async () => {
      permission(f.hook, 'choice').resolve('chosen');
    });
    const request = permission(f.hook, 'consent');
    expect(request.text).toContain('owned-command');
    await act(async () => {
      request.resolve(true);
    });
    await act(async () => {
      permission(f.hook, 'setting').resolve('actual-setting-value');
    });
    expect(await finish(run)).toEqual({
      ok: true,
      status: { type: 'success', text: 'Installed extension "owned".' },
    });
    const args = f.methods.installExtension.mock.calls[0];
    expect(args[0]).toEqual({ ...marketplaceMetadata(), pluginName: 'chosen' });
    expect(args[3]).toBe('/owned/workspace');
    expect(args[4]).toBeUndefined();
    expect(args[5]).toEqual({
      scope: 'workspace',
      workspacePath: '/owned/workspace',
    });
    expect(args[6]).toBeInstanceOf(AbortSignal);
    expect(receivedSettings).toEqual(['actual-setting-value']);
    expect(f.methods.setExtensionScope).toHaveBeenCalledExactlyOnceWith(
      'owned',
      'project',
    );
    expect(f.context.reload).toHaveBeenCalledTimes(1);
    expect(f.hook.result.current).toMatchObject({
      pending: false,
      permission: null,
    });
    expect(f.methods.requestConsent).not.toHaveBeenCalled();
    expect(f.methods.requestChoicePlugin).not.toHaveBeenCalled();
    expect(f.methods.requestSetting).not.toHaveBeenCalled();
  });

  it('activates Sources in user scope without changing the Discover scope preference', async () => {
    const f = fixture();
    const run = await begin(f.hook, 'user', false);
    expect((await finish(run)).ok).toBe(true);
    expect(f.methods.installExtension.mock.calls[0][5]).toEqual({
      scope: 'user',
    });
    expect(f.methods.setExtensionScope).not.toHaveBeenCalled();
    expect(f.context.reload).toHaveBeenCalledTimes(1);
  });

  it('requests consent and settings afresh for each operation with distinct owned signals', async () => {
    const f = fixture();
    const values: string[] = [];
    f.methods.installExtension.mockImplementation(
      async (_metadata, askConsent, askSetting) => {
        await askConsent!(consent);
        values.push(await askSetting!(setting));
        return extension;
      },
    );
    const ids: number[] = [];
    const signals: AbortSignal[] = [];
    for (const value of ['first-token', 'second-token']) {
      const run = await begin(f.hook);
      const question = permission(f.hook, 'consent');
      ids.push(question.id);
      const args = f.methods.installExtension.mock.calls.at(-1)!;
      signals.push(args[6]!);
      expect(args[6]!.aborted).toBe(false);
      await act(async () => {
        question.resolve(true);
      });
      await act(async () => {
        permission(f.hook, 'setting').resolve(value);
      });
      expect((await finish(run)).ok).toBe(true);
      expect(args[6]!.aborted).toBe(true);
    }
    expect(values).toEqual(['first-token', 'second-token']);
    expect(signals[0]).not.toBe(signals[1]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(f.methods.installExtension).toHaveBeenCalledTimes(2);
    expect(f.context.reload).toHaveBeenCalledTimes(2);
  });

  it('cancels actual choice before invoking install', async () => {
    const f = fixture(marketplaceMetadata());
    const run = await begin(f.hook);
    await act(async () => {
      permission(f.hook, 'choice').cancel();
    });
    expectCancelled(await finish(run), 'Plugin selection cancelled.');
    expect(f.methods.installExtension).not.toHaveBeenCalled();
    expect(f.context.reload).not.toHaveBeenCalled();
    expect(f.hook.result.current).toMatchObject({
      pending: false,
      permission: null,
    });
  });

  it.each(['absent', 'duplicate'] as const)(
    'rejects a %s choice instead of installing an ambiguous plugin',
    async (kind) => {
      const input = marketplaceMetadata();
      if (kind === 'duplicate')
        input.marketplaceConfig!.plugins.push({
          name: 'chosen',
          version: '1.0.0',
          source: './another',
        });
      const f = fixture(input);
      const run = await begin(f.hook);
      await act(async () => {
        permission(f.hook, 'choice').resolve(
          kind === 'absent' ? 'not-present' : 'chosen',
        );
      });
      expectCancelled(
        await finish(run),
        'Select a unique plugin from the marketplace.',
      );
      expect(f.methods.installExtension).not.toHaveBeenCalled();
    },
  );

  it('denies real consent without requesting a setting, remembering scope or reloading', async () => {
    const f = fixture();
    const settingsRead = vi.fn();
    f.methods.installExtension.mockImplementation(
      async (_metadata, askConsent, askSetting) => {
        await askConsent!(consent);
        settingsRead(await askSetting!(setting));
        return extension;
      },
    );
    const run = await begin(f.hook, 'project', true);
    await act(async () => {
      permission(f.hook, 'consent').resolve(false);
    });
    expectCancelled(await finish(run), 'Installation cancelled for "owned".');
    expect(settingsRead).not.toHaveBeenCalled();
    expect(f.methods.setExtensionScope).not.toHaveBeenCalled();
    expect(f.context.reload).not.toHaveBeenCalled();
    expect(f.hook.result.current.permission).toBeNull();
  });

  it('cancels a setting and ignores a late resolver from that request', async () => {
    const f = fixture();
    f.methods.installExtension.mockImplementation(
      async (_metadata, _consent, askSetting) => {
        await askSetting!(setting);
        return extension;
      },
    );
    const first = await begin(f.hook);
    const old = permission(f.hook, 'setting');
    await act(async () => {
      old.cancel();
    });
    expectCancelled(await finish(first), 'Setting input cancelled');
    const second = await begin(f.hook);
    const current = permission(f.hook, 'setting');
    expect(current.id).not.toBe(old.id);
    await act(async () => {
      old.resolve('stale');
      old.cancel();
    });
    expect(f.hook.result.current.permission).toBe(current);
    expect(f.hook.result.current.pending).toBe(true);
    await act(async () => {
      current.resolve('fresh');
      current.resolve('duplicate');
    });
    expect((await finish(second)).ok).toBe(true);
    expect(f.methods.installExtension).toHaveBeenCalledTimes(2);
    expect(f.context.reload).toHaveBeenCalledTimes(1);
  });

  it('retains the permission and pending operation on same-owner parent re-render', async () => {
    const f = fixture();
    f.methods.installExtension.mockImplementation(
      async (_metadata, askConsent) => {
        await askConsent!(consent);
        return extension;
      },
    );
    const run = await begin(f.hook);
    const shown = permission(f.hook, 'consent');
    f.hook.rerender({ owner: { ...f.context } });
    expect(f.hook.result.current.permission).toBe(shown);
    expect(f.hook.result.current.pending).toBe(true);
    await act(async () => {
      shown.resolve(true);
    });
    expect((await finish(run)).ok).toBe(true);
    expect(f.methods.installExtension).toHaveBeenCalledTimes(1);
  });

  it('aborts the replaced owner and prevents its old resolver from clearing the successor', async () => {
    const f = fixture();
    f.methods.installExtension.mockImplementation(
      async (_metadata, askConsent) => {
        await askConsent!(consent);
        return extension;
      },
    );
    const first = await begin(f.hook);
    const old = permission(f.hook, 'consent');
    const oldSignal = f.methods.installExtension.mock.calls[0][6]!;
    const successor = { ...f.context, isCurrent: () => true };
    f.hook.rerender({ owner: successor });
    expectCancelled(await finish(first), 'Extension installation cancelled.');
    expect(oldSignal.aborted).toBe(true);
    const second = await begin(f.hook);
    const current = permission(f.hook, 'consent');
    await act(async () => {
      old.resolve(true);
      old.resolve(false);
    });
    expect(f.hook.result.current.permission).toBe(current);
    expect(f.hook.result.current.pending).toBe(true);
    await act(async () => {
      current.resolve(true);
    });
    expect((await finish(second)).ok).toBe(true);
    expect(f.context.reload).toHaveBeenCalledTimes(1);
    expect(f.methods.installExtension).toHaveBeenCalledTimes(2);
  });

  it('rejects an in-flight parse after owner replacement without installing it', async () => {
    const f = fixture();
    const parsed = deferred<Metadata>();
    f.methods.parseInstallSource.mockImplementationOnce(() => parsed.promise);
    const run = await begin(f.hook);
    f.hook.rerender({ owner: { ...f.context, cwd: '/owned/successor' } });
    await act(async () => {
      parsed.resolve(metadata());
    });
    expectCancelled(await finish(run), 'Extension installation cancelled.');
    expect(f.methods.installExtension).not.toHaveBeenCalled();
    expect(f.context.reload).not.toHaveBeenCalled();
  });

  it('aborts a waiting setting on unmount and settles it only once', async () => {
    const f = fixture();
    const received = vi.fn();
    f.methods.installExtension.mockImplementation(
      async (_metadata, _consent, askSetting) => {
        received(await askSetting!(setting));
        return extension;
      },
    );
    const run = await begin(f.hook);
    const old = permission(f.hook, 'setting');
    const signal = f.methods.installExtension.mock.calls[0][6]!;
    f.hook.unmount();
    expectCancelled(await finish(run), 'Setting input cancelled');
    await act(async () => {
      old.resolve('late');
      old.cancel();
    });
    expect(signal.aborted).toBe(true);
    expect(received).not.toHaveBeenCalled();
    expect(f.context.reload).not.toHaveBeenCalled();
  });

  it('refuses a concurrent install without aborting or replacing the current permission', async () => {
    const f = fixture(marketplaceMetadata());
    const first = await begin(f.hook);
    const shown = permission(f.hook, 'choice');
    const second = await begin(f.hook);
    expectCancelled(await finish(second), 'Extension installation cancelled.');
    expect(f.hook.result.current.permission).toBe(shown);
    expect(f.hook.result.current.pending).toBe(true);
    expect(f.methods.parseInstallSource).toHaveBeenCalledTimes(1);
    await act(async () => {
      shown.cancel();
    });
    await finish(first);
  });

  it('returns committed, scope and reload failures as one warning without repeating installation', async () => {
    const f = fixture();
    f.methods.installExtension.mockRejectedValueOnce(
      Object.assign(new Error('Committed; activation incomplete'), {
        code: 'extension_committed_with_warnings',
        committed: true,
        identity: { id: 'actual-install-id', name: 'owned' },
        warnings: [{ code: 'activation', error: 'Activation incomplete' }],
      }),
    );
    f.methods.setExtensionScope.mockImplementationOnce(() => {
      throw new Error('Scope save failed');
    });
    vi.mocked(f.context.reload).mockRejectedValueOnce(
      new Error('Reload https://u:secret@example.invalid failed'),
    );
    const run = await begin(f.hook, 'project', true);
    const outcome = await finish(run);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.status.type).toBe('warning');
      expect(outcome.status.text).toContain('Installed extension "owned".');
      expect(outcome.status.text).toContain('Committed; activation incomplete');
      expect(outcome.status.text).toContain('Scope save failed');
      expect(outcome.status.text).toContain('Reload');
      expect(outcome.status.text).not.toContain('secret');
    }
    expect(f.methods.installExtension).toHaveBeenCalledTimes(1);
    expect(f.methods.setExtensionScope).toHaveBeenCalledExactlyOnceWith(
      'owned',
      'project',
    );
    expect(f.context.reload).toHaveBeenCalledTimes(1);
    expect(f.hook.result.current).toMatchObject({
      pending: false,
      permission: null,
    });
  });

  it('propagates a genuine install failure without recording scope or reloading', async () => {
    const f = fixture();
    f.methods.installExtension.mockRejectedValueOnce(
      new Error('Install failed before commit'),
    );
    const run = await begin(f.hook, 'project', true);
    expectCancelled(await finish(run), 'Install failed before commit');
    expect(f.methods.setExtensionScope).not.toHaveBeenCalled();
    expect(f.context.reload).not.toHaveBeenCalled();
    expect(f.hook.result.current.pending).toBe(false);
  });
});
