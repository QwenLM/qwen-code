/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { exec, type ChildProcess } from 'child_process';
import { useSettings } from '../contexts/SettingsContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';

/**
 * Structured JSON input passed to the status line command via stdin.
 * This allows status line commands to display context-aware information
 * (model, token usage, session, etc.) without running extra queries.
 */
export interface StatusLineCommandInput {
  session_id: string;
  cwd: string;
  model: {
    id: string;
  };
  context_window: {
    context_window_size: number;
    last_prompt_token_count: number;
  };
  vim?: {
    mode: string;
  };
}

interface StatusLineConfig {
  type: 'command';
  command: string;
  padding?: number;
}

function getStatusLineConfig(
  settings: ReturnType<typeof useSettings>,
): StatusLineConfig | undefined {
  const raw = settings.merged.ui?.statusLine;
  if (
    raw &&
    typeof raw === 'object' &&
    'type' in raw &&
    raw.type === 'command' &&
    'command' in raw &&
    typeof raw.command === 'string'
  ) {
    const config: StatusLineConfig = {
      type: 'command',
      command: raw.command,
    };
    if (
      'padding' in raw &&
      typeof raw.padding === 'number' &&
      Number.isFinite(raw.padding)
    ) {
      config.padding = Math.max(0, raw.padding);
    }
    return config;
  }
  return undefined;
}

/**
 * Hook that executes a user-configured shell command and returns its output
 * for display in the status line. The command receives structured JSON context
 * via stdin.
 *
 * Updates are debounced (300ms) and triggered by state changes (model switch,
 * new messages, vim mode toggle) rather than blind polling.
 */
export function useStatusLine(): {
  text: string | null;
  padding: number;
} {
  const settings = useSettings();
  const uiState = useUIState();
  const config = useConfig();
  const { vimEnabled, vimMode } = useVimMode();

  const statusLineConfig = getStatusLineConfig(settings);
  const statusLineCommand = statusLineConfig?.command;
  const padding = statusLineConfig?.padding ?? 0;

  const [output, setOutput] = useState<string | null>(null);

  // Keep latest values in refs so the stable doUpdate callback can read them
  // without being recreated on every render.
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;
  const configRef = useRef(config);
  configRef.current = config;
  const vimEnabledRef = useRef(vimEnabled);
  vimEnabledRef.current = vimEnabled;
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const statusLineCommandRef = useRef(statusLineCommand);
  statusLineCommandRef.current = statusLineCommand;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Track previous trigger values to detect actual changes.
  // Initialized with current values so the state-change effect
  // does not fire redundantly on mount.
  const { lastPromptTokenCount } = uiState.sessionStats;
  const { currentModel } = uiState;
  const effectiveVim = vimEnabled ? vimMode : undefined;
  const prevStateRef = useRef<{
    promptTokenCount: number;
    currentModel: string;
    effectiveVim: string | undefined;
  }>({
    promptTokenCount: lastPromptTokenCount,
    currentModel,
    effectiveVim,
  });

  // Guard: when true, the mount effect has already called doUpdate so the
  // command-change effect should skip its first run to avoid a double exec.
  const hasMountedRef = useRef(false);

  // Track the active child process so we can kill it on new updates / unmount.
  const activeChildRef = useRef<ChildProcess | undefined>(undefined);
  const generationRef = useRef(0);

  const doUpdate = useCallback(() => {
    const cmd = statusLineCommandRef.current;
    if (!cmd) {
      setOutput(null);
      return;
    }

    const ui = uiStateRef.current;
    const cfg = configRef.current;

    const input: StatusLineCommandInput = {
      session_id: ui.sessionStats.sessionId,
      cwd: cfg.getTargetDir(),
      model: {
        id: ui.currentModel || cfg.getModel() || 'unknown',
      },
      context_window: {
        context_window_size:
          cfg.getContentGeneratorConfig()?.contextWindowSize || 0,
        last_prompt_token_count: ui.sessionStats.lastPromptTokenCount,
      },
      ...(vimEnabledRef.current && {
        vim: { mode: vimModeRef.current ?? 'INSERT' },
      }),
    };

    // Kill the previous child process if still running.
    if (activeChildRef.current) {
      activeChildRef.current.kill();
      activeChildRef.current = undefined;
    }

    // Bump generation so earlier in-flight callbacks are ignored.
    const gen = ++generationRef.current;

    const child = exec(
      cmd,
      { cwd: cfg.getTargetDir(), timeout: 5000, maxBuffer: 1024 * 10 },
      (error, stdout) => {
        if (gen !== generationRef.current) return; // stale
        activeChildRef.current = undefined;
        if (!error && stdout) {
          // Strip only the trailing newline to preserve intentional whitespace.
          const line = stdout.replace(/\r?\n$/, '').split(/\r?\n/, 1)[0];
          setOutput(line || null);
        } else {
          setOutput(null);
        }
      },
    );

    activeChildRef.current = child;

    // Pass structured JSON context via stdin.
    // Guard against EPIPE if the child exits before we finish writing.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  }, []); // No deps — reads everything from refs

  const scheduleUpdate = useCallback(() => {
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = undefined;
      doUpdate();
    }, 300);
  }, [doUpdate]);

  // Trigger update when meaningful state changes
  useEffect(() => {
    if (!statusLineCommand) {
      // Command removed — kill any in-flight process and discard callbacks.
      activeChildRef.current?.kill();
      activeChildRef.current = undefined;
      generationRef.current++;
      if (debounceTimerRef.current !== undefined) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = undefined;
      }
      setOutput(null);
      return;
    }

    const prev = prevStateRef.current;
    if (
      lastPromptTokenCount !== prev.promptTokenCount ||
      currentModel !== prev.currentModel ||
      effectiveVim !== prev.effectiveVim
    ) {
      prev.promptTokenCount = lastPromptTokenCount;
      prev.currentModel = currentModel;
      prev.effectiveVim = effectiveVim;
      scheduleUpdate();
    }
  }, [
    statusLineCommand,
    lastPromptTokenCount,
    currentModel,
    effectiveVim,
    scheduleUpdate,
  ]);

  // Re-execute immediately when the command itself changes (hot reload).
  // Skip the first run — the mount effect below already handles it.
  useEffect(() => {
    if (!hasMountedRef.current) return;
    if (statusLineCommand) {
      // Clear any pending debounce so we don't get a redundant second run.
      if (debounceTimerRef.current !== undefined) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = undefined;
      }
      doUpdate();
    }
    // Cleanup when command is removed is handled by the state-change effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusLineCommand]);

  // Initial execution + cleanup
  useEffect(() => {
    hasMountedRef.current = true;
    const genRef = generationRef;
    const debounceRef = debounceTimerRef;
    const childRef = activeChildRef;
    doUpdate();
    return () => {
      // Kill active child process and invalidate callbacks
      childRef.current?.kill();
      childRef.current = undefined;
      genRef.current++;
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { text: output, padding };
}
