/**
 * @license
 * Copyright 2026 Qmode
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
import { renderHook, act } from '@testing-library/react';
import { useWorkModeCycle } from './useWorkModeCycle.js';
import type { ModeDefinition } from '@qwen-code/modes';
import { Config, ApprovalMode } from '@qwen-code/qwen-code-core';
import type { Key } from './useKeypress.js';
import { useKeypress } from './useKeypress.js';
import { MessageType } from '../types.js';

vi.mock('./useKeypress.js');

// Mock ModeDefinition instances
const MOCK_ARCHITECT_MODE: ModeDefinition = {
  id: 'architect',
  name: 'Architect',
  description: 'Architecture and planning mode',
  icon: '📐',
  color: '#9333EA',
  roleSystemPrompt: 'You are an architect...',
  allowedTools: ['read_file', 'todo_write'],
  excludedTools: ['write_file', 'edit'],
  useCases: ['Planning'],
  safetyConstraints: ['No code writing'],
};

const MOCK_CODE_MODE: ModeDefinition = {
  id: 'code',
  name: 'Code',
  description: 'Code writing mode',
  icon: '💻',
  color: '#10B981',
  roleSystemPrompt: 'You are a coder...',
  allowedTools: ['read_file', 'write_file', 'edit'],
  excludedTools: [],
  useCases: ['Implementation'],
  safetyConstraints: [],
};

const MOCK_ASK_MODE: ModeDefinition = {
  id: 'ask',
  name: 'Ask',
  description: 'Question answering mode',
  icon: '❓',
  color: '#3B82F6',
  roleSystemPrompt: 'You are an assistant...',
  allowedTools: ['read_file'],
  excludedTools: ['write_file', 'edit'],
  useCases: ['Questions'],
  safetyConstraints: [],
};

const MOCK_DEBUG_MODE: ModeDefinition = {
  id: 'debug',
  name: 'Debug',
  description: 'Debugging mode',
  icon: '🐛',
  color: '#F59E0B',
  roleSystemPrompt: 'You are a debugger...',
  allowedTools: ['read_file', 'write_file'],
  excludedTools: [],
  useCases: ['Debugging'],
  safetyConstraints: [],
};

const MOCK_REVIEW_MODE: ModeDefinition = {
  id: 'review',
  name: 'Review',
  description: 'Code review mode',
  icon: '🔍',
  color: '#EF4444',
  roleSystemPrompt: 'You are a reviewer...',
  allowedTools: ['read_file'],
  excludedTools: ['write_file'],
  useCases: ['Review'],
  safetyConstraints: [],
};

const MOCK_ORCHESTRATOR_MODE: ModeDefinition = {
  id: 'orchestrator',
  name: 'Orchestrator',
  description: 'Orchestrator mode',
  icon: '🎯',
  color: '#8B5CF6',
  roleSystemPrompt: 'You are an orchestrator...',
  allowedTools: ['read_file', 'todo_write'],
  excludedTools: [],
  useCases: ['Orchestration'],
  safetyConstraints: [],
};

interface MockConfigInstanceShape {
  getModeManager: Mock<
    () => {
      getCurrentMode: Mock<() => ModeDefinition>;
      getAvailableModes: Mock<() => ModeDefinition[]>;
      switchMode: Mock<(modeId: string) => Promise<ModeDefinition>>;
    } | null
  >;
  getApprovalMode: Mock<() => ApprovalMode>;
  setApprovalMode: Mock<(mode: ApprovalMode) => void>;
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
  getToolRegistry: Mock<
    () => { discoverTools: Mock<() => void>; getToolNames: Mock<() => string[]> }
  >;
}

type UseKeypressHandler = (key: Key) => void;

describe('useWorkModeCycle', () => {
  let capturedUseKeypressHandler: UseKeypressHandler;
  let mockedUseKeypress: MockedFunction<typeof useKeypress>;
  let mockModeManager: {
    getCurrentMode: Mock<() => ModeDefinition>;
    getAvailableModes: Mock<() => ModeDefinition[]>;
    switchMode: Mock<(modeId: string) => Promise<ModeDefinition>>;
  };
  let mockConfigInstance: MockConfigInstanceShape;

  beforeEach(() => {
    vi.resetAllMocks();

    mockModeManager = {
      getCurrentMode: vi.fn().mockReturnValue(MOCK_CODE_MODE),
      getAvailableModes: vi.fn().mockReturnValue([
        MOCK_ARCHITECT_MODE,
        MOCK_CODE_MODE,
        MOCK_ASK_MODE,
        MOCK_DEBUG_MODE,
        MOCK_REVIEW_MODE,
        MOCK_ORCHESTRATOR_MODE,
      ]),
      switchMode: vi.fn().mockResolvedValue(MOCK_ARCHITECT_MODE),
    };

    mockConfigInstance = {
      getModeManager: vi.fn().mockReturnValue(mockModeManager) as Mock<
        () => typeof mockModeManager | null
      >,
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT) as Mock<
        () => ApprovalMode
      >,
      setApprovalMode: vi.fn() as Mock<(mode: ApprovalMode) => void>,
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
      getGeminiMdFileCount: vi.fn().mockReturnValue(0) as Mock<
        () => number
      >,
      getToolRegistry: vi.fn().mockReturnValue({
        discoverTools: vi.fn(),
        getToolNames: vi.fn().mockReturnValue([]),
      }) as Mock<
        () => {
          discoverTools: Mock<() => void>;
          getToolNames: Mock<() => string[]>;
        }
      >,
    };

    (
      Config as unknown as MockedFunction<() => MockConfigInstanceShape>
    ).mockImplementation(() => mockConfigInstance);

    capturedUseKeypressHandler = () => {};
    mockedUseKeypress = useKeypress as MockedFunction<typeof useKeypress>;
    mockedUseKeypress.mockImplementation(
      (handler: (key: Key) => void) => {
        capturedUseKeypressHandler = handler;
        return {
          isFocused: true,
          lastKeyInput: null,
        };
      },
    );
  });

  it('should initialize with current work mode from mode manager', () => {
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);

    const { result } = renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: vi.fn(),
      }),
    );

    expect(result.current).toEqual(MOCK_CODE_MODE);
    expect(mockModeManager.getCurrentMode).toHaveBeenCalled();
  });

  it('should cycle work modes when Shift+Tab is pressed', () => {
    // Start in Code mode (work mode)
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.YOLO);

    const { result } = renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: vi.fn(),
      }),
    );

    expect(result.current).toEqual(MOCK_CODE_MODE);

    // Cycle from Code -> Ask (next work mode in unified cycle)
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });

    expect(mockModeManager.switchMode).toHaveBeenCalledWith('ask');
  });

  it('should cycle from approval modes to work modes', () => {
    // Start in Plan mode (approval mode)
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.PLAN);

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: vi.fn(),
      }),
    );

    // Cycle from Plan -> Auto-edit (next approval mode)
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });

    expect(mockConfigInstance.setApprovalMode).toHaveBeenCalledWith(ApprovalMode.AUTO_EDIT);
  });

  it('should cycle from YOLO to Architect mode', () => {
    // Start in YOLO mode (last approval mode)
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.YOLO);

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: vi.fn(),
      }),
    );

    // Cycle from YOLO -> Architect (first work mode)
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });

    expect(mockModeManager.switchMode).toHaveBeenCalledWith('architect');
  });

  it('should cycle through all modes in unified cycle', () => {
    const modes = [
      MOCK_ARCHITECT_MODE,
      MOCK_CODE_MODE,
      MOCK_ASK_MODE,
      MOCK_DEBUG_MODE,
      MOCK_REVIEW_MODE,
      MOCK_ORCHESTRATOR_MODE,
    ];
    let currentModeIndex = 0;

    mockModeManager.getCurrentMode.mockImplementation(
      () => modes[currentModeIndex],
    );
    mockModeManager.getAvailableModes.mockReturnValue(modes);
    mockModeManager.switchMode.mockImplementation(async (modeId: string) => {
      const nextMode = modes.find((m) => m.id === modeId);
      if (nextMode) {
        currentModeIndex = modes.indexOf(nextMode);
        return nextMode;
      }
      return modes[0];
    });

    const addItemMock = vi.fn();
    const { result } = renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: addItemMock,
      }),
    );

    // Start with ARCHITECT (first work mode after approval modes)
    currentModeIndex = 0;
    mockConfigInstance.getApprovalMode.mockReturnValue(ApprovalMode.YOLO);
    expect(result.current).toEqual(MOCK_ARCHITECT_MODE);

    // Cycle to CODE
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockModeManager.switchMode).toHaveBeenCalledWith('code');

    // Cycle to ASK
    currentModeIndex = 1;
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockModeManager.switchMode).toHaveBeenCalledWith('ask');

    // Cycle to DEBUG
    currentModeIndex = 2;
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockModeManager.switchMode).toHaveBeenCalledWith('debug');

    // Cycle to REVIEW
    currentModeIndex = 3;
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockModeManager.switchMode).toHaveBeenCalledWith('review');

    // Cycle to ORCHESTRATOR
    currentModeIndex = 4;
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockModeManager.switchMode).toHaveBeenCalledWith('orchestrator');

    // Cycle back to ARCHITECT (wrap around from work modes)
    currentModeIndex = 5;
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });
    expect(mockModeManager.switchMode).toHaveBeenCalledWith('architect');
  });

  it('should not cycle work mode when autocomplete is showing (shouldBlockTab)', () => {
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: vi.fn(),
        shouldBlockTab: () => true, // Autocomplete is showing
      }),
    );

    // Simulate Windows Tab key (which would normally cycle)
    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: false,
        ctrl: false,
        meta: false,
      } as Key);
    });

    // Should NOT switch mode when autocomplete is showing
    expect(mockModeManager.switchMode).not.toHaveBeenCalled();
  });

  it('should cycle work mode on Windows with Tab key when autocomplete is not showing', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });

    try {
      mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);

      renderHook(() =>
        useWorkModeCycle({
          config: mockConfigInstance as unknown as Config,
          addItem: vi.fn(),
          shouldBlockTab: () => false, // Autocomplete not showing
        }),
      );

      // Simulate Windows Tab key
      act(() => {
        capturedUseKeypressHandler({
          name: 'tab',
          shift: false,
          ctrl: false,
          meta: false,
        } as Key);
      });

      // Should switch mode on Windows with Tab
      expect(mockModeManager.switchMode).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
      });
    }
  });

  it('should call onWorkModeChange callback when mode changes', () => {
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);
    const onWorkModeChangeMock = vi.fn();

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: vi.fn(),
        onWorkModeChange: onWorkModeChangeMock,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });

    expect(onWorkModeChangeMock).toHaveBeenCalled();
    expect(onWorkModeChangeMock.mock.calls[0][0]).toEqual(MOCK_ASK_MODE);
  });

  it('should call addItem with info message when mode changes', () => {
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);
    const addItemMock = vi.fn();

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: addItemMock,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });

    expect(addItemMock).toHaveBeenCalled();
    const notification = addItemMock.mock.calls[0][0];
    expect(notification.type).toBe(MessageType.INFO);
    expect(notification.text).toContain('switched to');
  });

  it('should handle errors gracefully when mode switch fails', () => {
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);
    mockModeManager.switchMode.mockRejectedValue(
      new Error('Mode not found'),
    );
    const addItemMock = vi.fn();

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: addItemMock,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });

    // Should call addItem with error message
    expect(addItemMock).toHaveBeenCalled();
    const errorNotification = addItemMock.mock.calls[0][0];
    expect(errorNotification.type).toBe(MessageType.ERROR);
    expect(errorNotification.text).toContain('Failed to switch work mode');
  });

  it('should not cycle if mode manager is not available', () => {
    mockConfigInstance.getModeManager = vi.fn().mockReturnValue(null);
    const addItemMock = vi.fn();

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: addItemMock,
      }),
    );

    act(() => {
      capturedUseKeypressHandler({
        name: 'tab',
        shift: true,
      } as Key);
    });

    // Should not throw or call addItem
    expect(addItemMock).not.toHaveBeenCalled();
  });

  it('should not respond to non-Tab keys', () => {
    mockModeManager.getCurrentMode.mockReturnValue(MOCK_CODE_MODE);

    renderHook(() =>
      useWorkModeCycle({
        config: mockConfigInstance as unknown as Config,
        addItem: vi.fn(),
      }),
    );

    // Press Enter (should not trigger mode switch)
    act(() => {
      capturedUseKeypressHandler({
        name: 'return',
        shift: false,
      } as Key);
    });

    // Press 'a' (should not trigger mode switch)
    act(() => {
      capturedUseKeypressHandler({
        name: 'a',
        shift: false,
      } as Key);
    });

    expect(mockModeManager.switchMode).not.toHaveBeenCalled();
  });
});
