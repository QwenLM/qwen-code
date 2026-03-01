/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { useKeypress } from './useKeypress.js';
import type { ModeDefinition } from '@qwen-code/modes';
import type { Config } from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import type { HistoryItemWithoutId } from '../types.js';
import { MessageType } from '../types.js';

// Fallback mode if mode manager is not available
const DEFAULT_FALLBACK_MODE: ModeDefinition = {
  id: 'code',
  name: 'Code',
  description: 'Code writing mode',
  icon: '💻',
  color: '#10B981',
  roleSystemPrompt: '',
  allowedTools: [],
  excludedTools: [],
  useCases: [],
  safetyConstraints: [],
};

// Unified mode cycle: plan → auto-edit → YOLO → Architect → Code → Ask → Debug → Review → Orchestrator → plan
const UNIFIED_MODE_CYCLE = [
  { type: 'approval', id: ApprovalMode.PLAN, name: 'Plan', icon: '📋' },
  {
    type: 'approval',
    id: ApprovalMode.AUTO_EDIT,
    name: 'Auto-accept edits',
    icon: '✅',
  },
  { type: 'approval', id: ApprovalMode.YOLO, name: 'YOLO', icon: '🚀' },
  { type: 'work', id: 'architect', name: 'Architect', icon: '📐' },
  { type: 'work', id: 'code', name: 'Code', icon: '💻' },
  { type: 'work', id: 'ask', name: 'Ask', icon: '❓' },
  { type: 'work', id: 'debug', name: 'Debug', icon: '🐛' },
  { type: 'work', id: 'review', name: 'Review', icon: '🔍' },
  { type: 'work', id: 'orchestrator', name: 'Orchestrator', icon: '🎯' },
];

export interface UseWorkModeCycleArgs {
  config: Config;
  addItem?: (item: HistoryItemWithoutId, timestamp: number) => void;
  onWorkModeChange?: (mode: ModeDefinition) => void;
  shouldBlockTab?: () => boolean;
}

/**
 * Hook для переключения унифицированных режимов по нажатию Shift+Tab:
 * plan mode → auto-accept edits → YOLO mode → Architect → Code → Ask → Debug → Review → Orchestrator → plan
 */
export function useWorkModeCycle({
  config,
  addItem,
  onWorkModeChange,
  shouldBlockTab,
}: UseWorkModeCycleArgs): ModeDefinition {
  const modeManager = config.getModeManager();
  const [currentWorkMode, setCurrentWorkMode] = useState<ModeDefinition>(
    () => modeManager?.getCurrentMode() || DEFAULT_FALLBACK_MODE,
  );

  // Update local state when mode changes externally
  useEffect(() => {
    const manager = config.getModeManager();
    if (manager) {
      setCurrentWorkMode(manager.getCurrentMode());
    }
  }, [config]);

  useKeypress(
    (key) => {
      // Handle Shift+Tab to cycle through all modes (approval + work)
      // On Windows, Shift+Tab is indistinguishable from Tab (\t) in some terminals,
      // so we allow Tab to switch modes as well to support the shortcut.
      const isShiftTab = key.shift && key.name === 'tab';
      const isWindowsTab =
        process.platform === 'win32' &&
        key.name === 'tab' &&
        !key.ctrl &&
        !key.meta;

      if (isShiftTab || isWindowsTab) {
        // On Windows, check if we should block Tab key when autocomplete is active
        if (isWindowsTab && shouldBlockTab?.()) {
          // Don't cycle work mode when autocomplete is showing
          return;
        }

        const modeManager = config.getModeManager();
        if (!modeManager) {
          return;
        }

        try {
          // Determine current position in unified cycle
          const currentApprovalMode = config.getApprovalMode();
          const currentWorkMode = modeManager.getCurrentMode();

          // Find current index in unified cycle - check approval modes first, then work modes
          let currentIndex = -1;
          
          // First check approval modes
          for (let i = 0; i < UNIFIED_MODE_CYCLE.length; i++) {
            const mode = UNIFIED_MODE_CYCLE[i];
            if (mode.type === 'approval' && mode.id === currentApprovalMode) {
              currentIndex = i;
              break;
            }
          }
          
          // If not in approval mode, check work modes
          if (currentIndex === -1) {
            for (let i = 0; i < UNIFIED_MODE_CYCLE.length; i++) {
              const mode = UNIFIED_MODE_CYCLE[i];
              if (mode.type === 'work' && mode.id === currentWorkMode.id) {
                currentIndex = i;
                break;
              }
            }
          }

          // Calculate next mode index (cycle through all modes)
          const nextIndex =
            currentIndex === -1 ? 0 : (currentIndex + 1) % UNIFIED_MODE_CYCLE.length;
          const nextModeConfig = UNIFIED_MODE_CYCLE[nextIndex];

          // Switch to the next mode based on type
          if (nextModeConfig.type === 'approval') {
            // Switch approval mode
            config.setApprovalMode(nextModeConfig.id as ApprovalMode);
          } else {
            // Switch work mode
            modeManager.switchMode(nextModeConfig.id);
          }

          // Update local state immediately for responsiveness
          if (nextModeConfig.type === 'work') {
            const nextModeDef =
              modeManager.getAvailableModes().find(
                (m) => m.id === nextModeConfig.id,
              ) || DEFAULT_FALLBACK_MODE;
            setCurrentWorkMode(nextModeDef);

            // Notify the central handler about the work mode change
            onWorkModeChange?.(nextModeDef);
          }

          // Show notification about mode change
          addItem?.(
            {
              type: MessageType.INFO,
              text: ` switched to ${nextModeConfig.icon} ${nextModeConfig.name} mode`,
            },
            Date.now(),
          );
        } catch (e) {
          addItem?.(
            {
              type: MessageType.ERROR,
              text: `Failed to switch mode: ${(e as Error).message}`,
            },
            Date.now(),
          );
        }
      }
    },
    { isActive: true },
  );

  return currentWorkMode;
}
