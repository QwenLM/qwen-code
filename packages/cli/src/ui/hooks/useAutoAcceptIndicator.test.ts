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
  type MockedFunction,
  type Mock,
} from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoAcceptIndicator } from './useAutoAcceptIndicator.js';

import { Config, ApprovalMode } from '@qwen-code/qwen-code-core';
import type { Config as ActualConfigType } from '@qwen-code/qwen-code-core';

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

describe('useAutoAcceptIndicator', () => {
  let mockConfigInstance: MockConfigInstanceShape;

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockConfigInstance = new (Config as any)() as MockConfigInstanceShape;
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

  it('should call onApprovalModeChange when approval mode changes', () => {
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.DEFAULT);
    const onApprovalModeChangeMock = vi.fn();

    const { rerender } = renderHook(() =>
      useAutoAcceptIndicator({
        config: mockConfigInstance as unknown as ActualConfigType,
        onApprovalModeChange: onApprovalModeChangeMock,
      }),
    );

    // Initial call
    expect(onApprovalModeChangeMock).toHaveBeenCalledWith(ApprovalMode.DEFAULT);

    // Change approval mode
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.AUTO_EDIT);
    rerender();

    expect(onApprovalModeChangeMock).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
  });

  it('should update indicator when config value changes externally', () => {
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

    // Simulate external change
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.YOLO);
    rerender();

    expect(result.current).toBe(ApprovalMode.YOLO);
  });
});
