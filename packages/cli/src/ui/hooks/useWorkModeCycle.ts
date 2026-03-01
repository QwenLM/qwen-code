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
  // Track whether we're currently in an approval mode or work mode
  const [lastModeType, setLastModeType] = useState<'approval' | 'work'>(() => {
    const currentApprovalMode = config.getApprovalMode();
    // If approval mode is not YOLO, we're likely in approval mode
    return currentApprovalMode !== ApprovalMode.YOLO ? 'approval' : 'work';
  });

  // Update local state when mode changes externally
  useEffect(() => {
    const manager = config.getModeManager();
    if (manager) {
      const currentWork = manager.getCurrentMode();
      setCurrentWorkMode(currentWork);
      
      // Sync lastModeType with actual state
      const workModes = manager.getAvailableModes();
      const isInWorkMode = workModes.some(m => m.id === currentWork.id);
      setLastModeType(isInWorkMode ? 'work' : 'approval');
    }
  }, [config]);

  useKeypress(
    async (key) => {
      // Handle Shift+Tab to cycle through all modes (approval + work)
      // On macOS, Shift+Tab may not be detected reliably, so we also check for just Tab
      const isShiftTab = key.shift && key.name === 'tab';
      const isMacTab = process.platform === 'darwin' && key.name === 'tab';

      if (isShiftTab || isMacTab) {
        // On macOS, check if we should block Tab key when autocomplete is active
        if (isMacTab && shouldBlockTab?.()) {
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
          const currentWorkModeState = currentWorkMode;

          // Debug logging
          console.log('[useWorkModeCycle] Tab pressed, cycling mode...');
          console.log('[useWorkModeCycle] Current approval mode:', currentApprovalMode);
          console.log('[useWorkModeCycle] Current work mode:', currentWorkModeState?.id);
          console.log('[useWorkModeCycle] Last mode type:', lastModeType);

          // Find current index in unified cycle
          // Use lastModeType to determine which type of mode we should look for
          let currentIndex = -1;
          
          if (lastModeType === 'approval') {
            // Look for current approval mode
            for (let i = 0; i < UNIFIED_MODE_CYCLE.length; i++) {
              const mode = UNIFIED_MODE_CYCLE[i];
              if (mode.type === 'approval' && mode.id === currentApprovalMode) {
                currentIndex = i;
                break;
              }
            }
          } else {
            // Look for current work mode
            for (let i = 0; i < UNIFIED_MODE_CYCLE.length; i++) {
              const mode = UNIFIED_MODE_CYCLE[i];
              if (mode.type === 'work' && mode.id === currentWorkModeState.id) {
                currentIndex = i;
                break;
              }
            }
          }
          
          // If we couldn't find the current mode, start from beginning
          if (currentIndex === -1) {
            currentIndex = 0;
          }

          // Calculate next mode index (cycle through all modes)
          const nextIndex = (currentIndex + 1) % UNIFIED_MODE_CYCLE.length;
          const nextModeConfig = UNIFIED_MODE_CYCLE[nextIndex];

          // Update the mode type tracker
          setLastModeType(nextModeConfig.type as 'approval' | 'work');

          // Switch to the next mode based on type
          if (nextModeConfig.type === 'approval') {
            // Switch approval mode
            config.setApprovalMode(nextModeConfig.id as ApprovalMode);
          } else {
            // Switch work mode
            await modeManager.switchMode(nextModeConfig.id);
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
          console.log('[useWorkModeCycle] Switched to:', nextModeConfig.id, nextModeConfig.name);
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
