/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Component, type ReactNode, act } from 'react';
import { renderHook, render } from '../../test-utils/render.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useModel } from './ConfigContext.js';
import { testListedModel } from '../../../../core/src/test-utils/listed-model.js';

import {
  coreEvents,
  CoreEvent,
  runLogger,
  type Config,
  type Model,
} from '@qwen-code/core';
import { SettingsContext, useSettingsStore } from './SettingsContext.js';
import {
  SettingScope,
  createTestMergedSettings,
  type LoadedSettings,
  type LoadedSettingsSnapshot,
  type SettingsFile,
} from '../../config/settings.js';

const createMockSettingsFile = (path: string): SettingsFile => ({
  path,
  settings: {},
  originalSettings: {},
});

const mockSnapshot: LoadedSettingsSnapshot = {
  user: createMockSettingsFile('/user'),
  project: createMockSettingsFile('/workspace'),
  local: createMockSettingsFile('/local'),
  flag: createMockSettingsFile(''),
  isTrusted: true,
  errors: [],
  merged: createTestMergedSettings({
    ui: { theme: 'default-theme' },
  }),
};

class ErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onError: (error: Error) => void }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error) {
    return { hasError: true };
  }

  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  override render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

const TestHarness = () => {
  useSettingsStore();
  return null;
};

describe('SettingsContext', () => {
  let mockLoadedSettings: LoadedSettings;
  let listeners: Array<() => void> = [];

  beforeEach(() => {
    listeners = [];

    mockLoadedSettings = {
      subscribe: vi.fn((listener: () => void) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((l) => l !== listener);
        };
      }),
      getSnapshot: vi.fn(() => mockSnapshot),
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SettingsContext.Provider value={mockLoadedSettings}>
      {children}
    </SettingsContext.Provider>
  );

  it('should provide the correct initial state', async () => {
    const { result } = await renderHook(() => useSettingsStore(), { wrapper });

    expect(result.current.settings.merged).toEqual(mockSnapshot.merged);
    expect(result.current.settings.isTrusted).toBe(true);
  });

  it('should allow accessing settings for a specific scope', async () => {
    const { result } = await renderHook(() => useSettingsStore(), { wrapper });

    const userSettings = result.current.settings.forScope(SettingScope.User);
    expect(userSettings).toBe(mockSnapshot.user);

    const projectSettings = result.current.settings.forScope(
      SettingScope.Project,
    );
    expect(projectSettings).toBe(mockSnapshot.project);
  });

  it('should trigger re-renders when settings change (external event)', async () => {
    const { result } = await renderHook(() => useSettingsStore(), { wrapper });

    expect(result.current.settings.merged.ui?.theme).toBe('default-theme');

    const newSnapshot = {
      ...mockSnapshot,
      merged: { ui: { theme: 'new-theme' } },
    };
    (
      mockLoadedSettings.getSnapshot as ReturnType<typeof vi.fn>
    ).mockReturnValue(newSnapshot);

    // Trigger the listeners (simulate coreEvents emission)
    act(() => {
      listeners.forEach((l) => l());
    });

    expect(result.current.settings.merged.ui?.theme).toBe('new-theme');
  });

  it('should call store.setValue when setSetting is called', async () => {
    const { result } = await renderHook(() => useSettingsStore(), { wrapper });

    act(() => {
      result.current.setSetting(SettingScope.User, 'ui.theme', 'dark');
    });

    expect(mockLoadedSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'ui.theme',
      'dark',
    );
  });

  it('propagates persistence failures', async () => {
    vi.mocked(mockLoadedSettings.setValue).mockImplementation(() => {
      throw new Error('write failed');
    });
    const { result } = await renderHook(() => useSettingsStore(), { wrapper });

    expect(() => {
      act(() => {
        result.current.setSetting(SettingScope.User, 'ui.theme', 'dark');
      });
    }).toThrow('write failed');
  });

  it('should throw error if used outside provider', async () => {
    const onError = vi.fn();
    // Suppress console.error (React logs error boundary info)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await render(
      <ErrorBoundary onError={onError}>
        <TestHarness />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'useSettingsStore must be used within a SettingsProvider',
      }),
    );

    consoleSpy.mockRestore();
  });
});

describe('useModel 异步展示', () => {
  let unmount: (() => void) | undefined;
  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.restoreAllMocks();
  });

  function context() {
    const manager = {
      getModel: vi.fn<(key: string) => Promise<Model | undefined>>(),
      listModels: vi.fn<() => Promise<Model[]>>().mockResolvedValue([]),
    };
    const getters = {
      getModel: vi.fn(() => 'model-a'),
      getModelRequestIdentity: vi.fn(() => 'account-a'),
      getSessionId: vi.fn(() => 'session-a'),
      getModelProviderManager: () => manager,
    };
    return { manager, getters, config: getters as unknown as Config };
  }

  it('首次加载等待查询，模型事件只刷新所属会话，并在退场时取消订阅', async () => {
    const f = context();
    let resolve!: (model: Model) => void;
    f.manager.getModel.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const hook = await renderHook(() => useModel(f.config));
    unmount = hook.unmount;
    expect(hook.result.current).toBeUndefined();
    const initial = testListedModel('model-a');
    await act(async () => resolve(initial));
    expect(hook.result.current).toBe(initial);
    await act(async () =>
      coreEvents.emit(CoreEvent.ModelChanged, {
        model: 'other-model',
        sessionId: 'other-session',
      }),
    );
    expect(f.manager.getModel).toHaveBeenCalledTimes(1);
    const updated = testListedModel('model-a', { display_name: 'updated' });
    f.manager.getModel.mockResolvedValue(updated);
    await act(async () =>
      coreEvents.emit(CoreEvent.ModelChanged, {
        model: 'model-a',
        sessionId: 'session-a',
      }),
    );
    expect(hook.result.current).toBe(updated);
    await act(async () => coreEvents.emit(CoreEvent.ModelInfoChanged));
    expect(f.manager.getModel).toHaveBeenCalledTimes(3);
    hook.unmount();
    unmount = undefined;
    coreEvents.emit(CoreEvent.ModelInfoChanged);
    expect(f.manager.getModel).toHaveBeenCalledTimes(3);
  });

  it.each(['config', 'model', 'identity', 'session'] as const)(
    '%s 变化后丢弃旧查询，不能覆盖新目标',
    async (target) => {
      const f = context();
      let resolveOld!: (model: Model) => void;
      f.manager.getModel.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveOld = done;
          }),
      );
      const hook = await renderHook((config: Config) => useModel(config), {
        initialProps: f.config,
      });
      unmount = hook.unmount;
      const next = target === 'config' ? context() : f;
      if (target === 'model') next.getters.getModel.mockReturnValue('model-b');
      if (target === 'identity')
        next.getters.getModelRequestIdentity.mockReturnValue('account-b');
      if (target === 'session')
        next.getters.getSessionId.mockReturnValue('session-b');
      const expected = testListedModel(next.config.getModel(), {
        display_name: 'new target',
      });
      next.manager.getModel.mockResolvedValue(expected);
      await act(async () => hook.rerender(next.config));
      expect(hook.result.current).toBe(expected);
      await act(async () =>
        resolveOld(testListedModel('model-a', { display_name: 'late result' })),
      );
      expect(hook.result.current).toBe(expected);
    },
  );

  it('默认模型从异步列表筛选，排除禁用条目', async () => {
    const f = context();
    f.getters.getModel.mockReturnValue('');
    const expected = testListedModel('default', { is_default: true });
    f.manager.listModels.mockResolvedValue([
      testListedModel('disabled', { is_default: true, enable: false }),
      expected,
    ]);
    const hook = await renderHook(() => useModel(f.config));
    unmount = hook.unmount;
    expect(hook.result.current).toBe(expected);
    expect(f.manager.getModel).not.toHaveBeenCalled();
  });

  it('查询失败清空展示，卸载后的迟到结果不提交', async () => {
    const f = context();
    const diagnostic = vi
      .spyOn(runLogger, 'debug')
      .mockImplementation(() => {});
    f.manager.getModel.mockResolvedValue(testListedModel('model-a'));
    const hook = await renderHook(() => useModel(f.config));
    unmount = hook.unmount;
    f.manager.getModel.mockRejectedValueOnce(new Error('offline'));
    await act(async () => coreEvents.emit(CoreEvent.ModelInfoChanged));
    expect(hook.result.current).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledWith(
      '[ui] 模型展示查询失败:',
      expect.any(Error),
    );
    let resolve!: (model: Model) => void;
    f.manager.getModel.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => coreEvents.emit(CoreEvent.ModelInfoChanged));
    hook.unmount();
    unmount = undefined;
    await act(async () => resolve(testListedModel('model-a')));
    expect(hook.result.current).toBeUndefined();
  });
});
