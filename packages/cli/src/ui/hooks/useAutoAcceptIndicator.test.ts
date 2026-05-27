/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockedFunction,
  type Mock,
} from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoAcceptIndicator } from './useAutoAcceptIndicator.js';

import { Config, ApprovalMode } from '@qwen-code/qwen-code-core';
import type { Config as ActualConfigType } from '@qwen-code/qwen-code-core';
import type { Key } from './useKeypress.js';
import { useKeypress } from './useKeypress.js';
import { MessageType } from '../types.js';
import { SettingScope } from '../../config/settings.js';
import { setLanguageAsync } from '../../i18n/index.js';

vi.mock('./useKeypress.js');

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actualServerModule = (await vi.importActual(
    '@qwen-code/qwen-code-core',
  )) as Record<string, unknown>;
  return {
    ...actualServerModule,
    Config: vi.fn(),
  };
});

interface MockConfigInstanceShape {
  getApprovalMode: Mock<() => ApprovalMode>;
  setApprovalMode: Mock<(value: ApprovalMode) => void>;
  isTrustedFolder: Mock<() => boolean>;
  getCoreTools: Mock<() => string[]>;
  getToolDiscoveryCommand: Mock<() => string | undefined>;
  getTargetDir: Mock<() => string>;
  getApiKey: Mock<() => string>;
  getModel: Mock<() => string>;
  getSandbox: Mock<() => boolean | string>;
  getDebugMode: Mock<() => boolean>;
  getQuestion: Mock<() => string | undefined>;
  getFullContext: Mock<() => boolean>;
  getUserAgent: Mock<() => string>;
  getUserMemory: Mock<() => string>;
  getGeminiMdFileCount: Mock<() => number>;
  getToolRegistry: Mock<() => { discoverTools: Mock<() => void> }>;
}

type UseKeypressHandler = (key: Key) => void;

describe('useAutoAcceptIndicator', () => {
  let mockConfigInstance: MockConfigInstanceShape;
  let capturedUseKeypressHandler: UseKeypressHandler;
  let mockedUseKeypress: MockedFunction<typeof useKeypress>;

  beforeEach(() => {
    vi.resetAllMocks();

    (
      Config as unknown as MockedFunction<() => MockConfigInstanceShape>
    ).mockImplementation(() => {
      const instanceGetApprovalModeMock = vi.fn();
      const instanceSetApprovalModeMock = vi.fn();

      const instance: MockConfigInstanceShape = {
        getApprovalMode: instanceGetApprovalModeMock as Mock<
          () => ApprovalMode
        >,
        setApprovalMode: instanceSetApprovalModeMock as Mock<
          (value: ApprovalMode) => void
        >,
        isTrustedFolder: vi.fn().mockReturnValue(true) as Mock<() => boolean>,
        getCoreTools: vi.fn().mockReturnValue([]) as Mock<() => string[]>,
        getToolDiscoveryCommand: vi.fn().mockReturnValue(undefined) as Mock<
          () => string | undefined
        >,
        getTargetDir: vi.fn().mockReturnValue('.') as Mock<() => string>,
        getApiKey: vi.fn().mockReturnValue('test-api-key') as Mock<
          () => string
        >,
        getModel: vi.fn().mockReturnValue('test-model') as Mock<() => string>,
        getSandbox: vi.fn().mockReturnValue(false) as Mock<
          () => boolean | string
        >,
        getDebugMode: vi.fn().mockReturnValue(false) as Mock<() => boolean>,
        getQuestion: vi.fn().mockReturnValue(undefined) as Mock<
          () => string | undefined
        >,
        getFullContext: vi.fn().mockReturnValue(false) as Mock<() => boolean>,
        getUserAgent: vi.fn().mockReturnValue('test-user-agent') as Mock<
          () => string
        >,
        getUserMemory: vi.fn().mockReturnValue('') as Mock<() => string>,
        getGeminiMdFileCount: vi.fn().mockReturnValue(0) as Mock<() => number>,
        getToolRegistry: vi
          .fn()
          .mockReturnValue({ discoverTools: vi.fn() }) as Mock<
          () => { discoverTools: Mock<() => void> }
        >,
      };
      instanceSetApprovalModeMock.mockImplementation((value: ApprovalMode) => {
        instanceGetApprovalModeMock.mockReturnValue(value);
      });
      return instance;
    });

    mockedUseKeypress = useKeypress as MockedFunction<typeof useKeypress>;
    mockedUseKeypress.mockImplementation(
      (handler: UseKeypressHandler, _options) => {
        capturedUseKeypressHandler = handler;
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConfigInstance = new (Config as any)() as MockConfigInstanceShape;
  });

  afterEach(async () => {
    await setLanguageAsync('en');
  });

  it('should initialize with ApprovalMode.AUTO_EDIT if config.getApprovalMode returns ApprovalMode.AUTO_EDIT', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.AUTO_EDIT);
    const { result } = renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
      }),
    );
    expect(result.current).toBe(ApprovalMode.AUTO_EDIT);
    expect(mockConfigInstance.getApprovalMode).toHaveBeenCalledTimes(1);
  });

  it('should show AUTO entry notices on mount when initially in AUTO mode', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.AUTO);
    const mockAddItem = vi.fn();
    const mockSetValue = vi.fn();
    const mockSettings = {
      merged: {
        ui: {
          autoModeAcknowledged: false,
        },
      },
      setValue: mockSetValue,
    };

    const { result } = renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        settings: mockSettings as never,
        addItem: mockAddItem,
      }),
    );

    expect(result.current).toBe(ApprovalMode.AUTO);
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('Auto mode enabled.'),
      }),
      expect.any(Number),
    );
    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.User,
      'ui.autoModeAcknowledged',
      true,
    );
    expect(mockConfigInstance.getApprovalMode).toHaveBeenCalledTimes(1);
  });

  it('should initialize with ApprovalMode.DEFAULT if config.getApprovalMode returns ApprovalMode.DEFAULT', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    const { result } = renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
      }),
    );
    expect(result.current).toBe(ApprovalMode.DEFAULT);
    expect(mockConfigInstance.getApprovalMode).toHaveBeenCalledTimes(1);
  });

  it('should initialize with ApprovalMode.YOLO if config.getApprovalMode returns ApprovalMode.YOLO', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.YOLO);
    const { result } = renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
      }),
    );
    expect(result.current).toBe(ApprovalMode.YOLO);
    expect(mockConfigInstance.getApprovalMode).toHaveBeenCalledTimes(1);
  });

  it('should initialize with ApprovalMode.PLAN if config.getApprovalMode returns ApprovalMode.PLAN', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.PLAN);
    const { result } = renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
      }),
    );
    expect(result.current).toBe(ApprovalMode.PLAN);
    expect(mockConfigInstance.getApprovalMode).toHaveBeenCalledTimes(1);
  });

  it('should cycle approval modes when Shift+Tab is pressed', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    const { result } = renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
      }),
    );
    expect(result.current).toBe(ApprovalMode.DEFAULT);

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );
    expect(result.current).toBe(ApprovalMode.AUTO_EDIT);

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO,
    );
    expect(result.current).toBe(ApprovalMode.AUTO);

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.YOLO,
    );
    expect(result.current).toBe(ApprovalMode.YOLO);

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.PLAN,
    );
    expect(result.current).toBe(ApprovalMode.PLAN);

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.DEFAULT,
    );
    expect(result.current).toBe(ApprovalMode.DEFAULT);
  });

  it('should not toggle if only one key or other keys combinations are pressed', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
      }),
    );

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: false,
      } as Key);
    });
    if (process.platform === 'win32') {
      // On Windows, Tab alone toggles approval mode
      expect(mockConfigInstance.setApprovalMode).toHaveBeenCalled();
      mockConfigInstance.setApprovalMode.mockClear();
    } else {
      expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();
    }

    act(() => {
      capturedUseKeypressHandler({
        name: 'unknown',
        shift: true,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();

    act(() => {
      capturedUseKeypressHandler({
        name: 'a',
        shift: false,
        ctrl: false,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();

    act(() => {
      capturedUseKeypressHandler({ name: 'y', ctrl: false } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();

    act(() => {
      capturedUseKeypressHandler({ name: 'a', ctrl: true } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();

    act(() => {
      capturedUseKeypressHandler({ name: 'y', shift: true } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();

    act(() => {
      capturedUseKeypressHandler({
        name: 'a',
        ctrl: true,
        shift: true,
      } as Key);
    });
    expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();
  });

  it('should update indicator when config value changes externally (useEffect dependency)', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    const { result, rerender } = renderHook(
      (props: { config: ActualConfigType; addItem: () => void }) =>
        useAutoAcceptIndicator(props),
      {
        initialProps: {
          config: mockConfigInstance as unknown as ActualConfigType,
          addItem: vi.fn(),
        },
      },
    );
    expect(result.current).toBe(ApprovalMode.DEFAULT);

    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.AUTO_EDIT);

    rerender({
      config: mockConfigInstance as unknown as ActualConfigType,
      addItem: vi.fn(),
    });
    expect(result.current).toBe(ApprovalMode.AUTO_EDIT);
    expect(mockConfigInstance.getApprovalMode).toHaveBeenCalledTimes(3);
  });

  describe('in untrusted folders', () => {
    beforeEach(() => {
      mockConfigInstance.isTrustedFolder.mockReturnValue(false);
    });

    it('should show a warning when cycling from DEFAULT to AUTO_EDIT', () => {
      const errorMessage =
        'Cannot enable privileged approval modes in an untrusted folder.';
      mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
      mockConfigInstance.setApprovalMode.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      const mockAddItem = vi.fn();
      renderHook(() =>
        useAutoAcceptIndicator({
          config: mockConfigInstance as unknown as ActualConfigType,
          addItem: mockAddItem,
        }),
      );

      act(() => {
        capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
      });

      expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.AUTO_EDIT,
      );
      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: errorMessage,
        },
        expect.any(Number),
      );
    });

    it('should show a warning when cycling from AUTO_EDIT to AUTO', () => {
      const errorMessage =
        'Cannot enable privileged approval modes in an untrusted folder.';
      mockConfigInstance.getApprovalMode.mockReturnValue(
        ApprovalMode.AUTO_EDIT,
      );
      mockConfigInstance.setApprovalMode.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      const mockAddItem = vi.fn();
      renderHook(() =>
        useAutoAcceptIndicator({
          config: mockConfigInstance as unknown as ActualConfigType,
          addItem: mockAddItem,
        }),
      );

      act(() => {
        capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
      });

      expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.AUTO,
      );
      expect(mockAddItem).toHaveBeenCalledWith(
        {
          type: MessageType.INFO,
          text: errorMessage,
        },
        expect.any(Number),
      );
    });

    it('should cycle from YOLO to PLAN when Shift+Tab is pressed', () => {
      mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.YOLO);
      const mockAddItem = vi.fn();
      renderHook(() =>
        useAutoAcceptIndicator({
          config: mockConfigInstance as unknown as ActualConfigType,
          addItem: mockAddItem,
        }),
      );

      act(() => {
        capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
      });

      expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.PLAN,
      );
      expect(mockConfigInstance.getApprovalMode()).toBe(ApprovalMode.PLAN);
      expect(mockAddItem).not.toHaveBeenCalled();
    });
  });

  it('should call onApprovalModeChange when switching to AUTO_EDIT mode', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);

    const mockOnApprovalModeChange = vi.fn();

    renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        onApprovalModeChange: mockOnApprovalModeChange,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
    });

    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );
    expect(mockOnApprovalModeChange).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );
  });

  it('should not call onApprovalModeChange when callback is not provided', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);

    renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
    });

    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );
    // Should not throw an error when callback is not provided
  });

  it('should handle multiple mode changes correctly', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);

    const mockOnApprovalModeChange = vi.fn();

    renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        onApprovalModeChange: mockOnApprovalModeChange,
      }),
    );

    // Switch to AUTO_EDIT
    act(() => {
      capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
    });

    // Switch to AUTO
    act(() => {
      capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
    });

    expect(mockOnApprovalModeChange).toHaveBeenCalledTimes(2);
    expect(mockOnApprovalModeChange).toHaveBeenNthCalledWith(
      1,
      ApprovalMode.AUTO_EDIT,
    );
    expect(mockOnApprovalModeChange).toHaveBeenNthCalledWith(
      2,
      ApprovalMode.AUTO,
    );
  });

  it('should not cycle approval mode on Windows when shouldBlockTab returns true', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
    });

    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    const mockShouldBlockTab = vi.fn(() => true);

    renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
        shouldBlockTab: mockShouldBlockTab,
      }),
    );

    // Simulate Tab key press on Windows
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: false,
        ctrl: false,
        meta: false,
      } as Key);
    });

    // Should call shouldBlockTab to check if autocomplete is active
    expect(mockShouldBlockTab).toHaveBeenCalled();
    // Should NOT cycle approval mode when shouldBlockTab returns true
    expect(mockConfigInstance.setApprovalMode).not.toHaveBeenCalled();

    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });

  it('should cycle approval mode on Windows when shouldBlockTab returns false', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
    });

    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    const mockShouldBlockTab = vi.fn(() => false);

    renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        addItem: vi.fn(),
        shouldBlockTab: mockShouldBlockTab,
      }),
    );

    // Simulate Tab key press on Windows
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: false,
        ctrl: false,
        meta: false,
      } as Key);
    });

    // Should call shouldBlockTab to check if autocomplete is active
    expect(mockShouldBlockTab).toHaveBeenCalled();
    // Should cycle approval mode when shouldBlockTab returns false
    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO_EDIT,
    );

    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });

  it('localizes AUTO entry notices and stripped allow-rule sources', async () => {
    await setLanguageAsync('zh');
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.AUTO_EDIT);
    const mockAddItem = vi.fn();
    const mockSettings = {
      merged: {
        ui: {
          autoModeAcknowledged: true,
        },
      },
    };
    const mockPermissionManager = {
      getStrippedDangerousRules: vi.fn(() => ({
        persistent: [{ raw: 'Bash(npm run *)' }],
        session: [{ raw: 'Bash(node *)' }],
      })),
    };
    const configWithPermissionManager = {
      ...mockConfigInstance,
      getPermissionManager: vi.fn(() => mockPermissionManager),
    };

    renderHook(() =>
      useAutoAcceptIndicator({
        config: configWithPermissionManager as unknown as ActualConfigType,
        settings: mockSettings as never,
        addItem: mockAddItem,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
    });

    const noticeText = mockAddItem.mock.calls.at(-1)?.[0].text as string;
    expect(noticeText).toContain('自动模式已临时禁用以下允许规则');
    expect(noticeText).toContain('（它们会绕过分类器）：');
    expect(noticeText).toContain('Bash(npm run *) （来自用户设置）');
    expect(noticeText).toContain('Bash(node *) （会话）');
    expect(noticeText).toContain('退出自动模式时将恢复这些规则。');
    expect(noticeText).not.toContain('Auto mode temporarily disabled');
    expect(noticeText).not.toContain('from user settings');
    expect(noticeText).not.toContain('These will be restored');
  });

  it('persists the first-time AUTO notice when cycling into AUTO mode', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.AUTO_EDIT);
    const mockAddItem = vi.fn();
    const mockSetValue = vi.fn();
    const mockSettings = {
      merged: {
        ui: {
          autoModeAcknowledged: false,
        },
      },
      setValue: mockSetValue,
    };

    renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        settings: mockSettings as never,
        addItem: mockAddItem,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({ name: 'tab', shift: true } as Key);
    });

    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(
      ApprovalMode.AUTO,
    );
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('Auto mode enabled.'),
      }),
      expect.any(Number),
    );
    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.User,
      'ui.autoModeAcknowledged',
      true,
    );
  });
});
