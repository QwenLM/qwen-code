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
import type { SessionMetrics } from '../contexts/SessionContext.js';

/**
 * Structured JSON input passed to the status line command via stdin.
 * This allows status line commands to display context-aware information
 * (model, token usage, session, etc.) without running extra queries.
 */
export interface StatusLineCommandInput {
  session_id: string;
  version: string;
  model: {
    display_name: string;
  };
  context_window: {
    context_window_size: number;
    used_percentage: number;
    remaining_percentage: number;
    current_usage: number;
    total_input_tokens: number;
    total_output_tokens: number;
  };
  workspace: {
    current_dir: string;
  };
  git?: {
    branch: string;
  };
  metrics: {
    models: Record<
      string,
      {
        api: {
          total_requests: number;
          total_errors: number;
          total_latency_ms: number;
        };
        tokens: {
          prompt: number;
          completion: number;
          total: number;
          cached: number;
          thoughts: number;
        };
      }
    >;
    files: {
      total_lines_added: number;
      total_lines_removed: number;
    };
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
    typeof raw.command === 'string' &&
    raw.command.trim().length > 0
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

function buildMetricsPayload(
  m: SessionMetrics,
): StatusLineCommandInput['metrics'] {
  const models: StatusLineCommandInput['metrics']['models'] = {};
  for (const [id, mm] of Object.entries(m.models)) {
    models[id] = {
      api: {
        total_requests: mm.api.totalRequests,
        total_errors: mm.api.totalErrors,
        total_latency_ms: mm.api.totalLatencyMs,
      },
      tokens: {
        prompt: mm.tokens.prompt,
        completion: mm.tokens.candidates,
        total: mm.tokens.total,
        cached: mm.tokens.cached,
        thoughts: mm.tokens.thoughts,
      },
    };
  }
  return {
    models,
    files: {
      total_lines_added: m.files.totalLinesAdded,
      total_lines_removed: m.files.totalLinesRemoved,
    },
  };
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
  const { currentModel, branchName } = uiState;
  const totalToolCalls = uiState.sessionStats.metrics.tools.totalCalls;
  const totalLinesAdded = uiState.sessionStats.metrics.files.totalLinesAdded;
  const totalLinesRemoved =
    uiState.sessionStats.metrics.files.totalLinesRemoved;
  const effectiveVim = vimEnabled ? vimMode : undefined;
  const prevStateRef = useRef<{
    promptTokenCount: number;
    currentModel: string;
    effectiveVim: string | undefined;
    branchName: string | undefined;
    totalToolCalls: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
  }>({
    promptTokenCount: lastPromptTokenCount,
    currentModel,
    effectiveVim,
    branchName,
    totalToolCalls,
    totalLinesAdded,
    totalLinesRemoved,
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
    const stats = ui.sessionStats;
    const m = stats.metrics;

    const contextWindowSize =
      cfg.getContentGeneratorConfig()?.contextWindowSize || 0;
    const usedPercentage =
      contextWindowSize > 0
        ? Math.min(
            100,
            Math.max(
              0,
              Math.round(
                (stats.lastPromptTokenCount / contextWindowSize) * 1000,
              ) / 10,
            ),
          )
        : 0;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const mm of Object.values(m.models)) {
      totalInputTokens += mm.tokens.prompt;
      totalOutputTokens += mm.tokens.candidates;
    }

    const input: StatusLineCommandInput = {
      session_id: stats.sessionId,
      version: cfg.getCliVersion() || 'unknown',
      model: {
        display_name: ui.currentModel || cfg.getModel() || 'unknown',
      },
      context_window: {
        context_window_size: contextWindowSize,
        used_percentage: usedPercentage,
        remaining_percentage: Math.round((100 - usedPercentage) * 10) / 10,
        current_usage: stats.lastPromptTokenCount,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
      },
      workspace: {
        current_dir: cfg.getTargetDir(),
      },
      ...(ui.branchName && {
        git: {
          branch: ui.branchName,
        },
      }),
      metrics: buildMetricsPayload(m),
      ...(vimEnabledRef.current && {
        vim: { mode: vimModeRef.current },
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
      effectiveVim !== prev.effectiveVim ||
      branchName !== prev.branchName ||
      totalToolCalls !== prev.totalToolCalls ||
      totalLinesAdded !== prev.totalLinesAdded ||
      totalLinesRemoved !== prev.totalLinesRemoved
    ) {
      prev.promptTokenCount = lastPromptTokenCount;
      prev.currentModel = currentModel;
      prev.effectiveVim = effectiveVim;
      prev.branchName = branchName;
      prev.totalToolCalls = totalToolCalls;
      prev.totalLinesAdded = totalLinesAdded;
      prev.totalLinesRemoved = totalLinesRemoved;
      scheduleUpdate();
    }
  }, [
    statusLineCommand,
    lastPromptTokenCount,
    currentModel,
    effectiveVim,
    branchName,
    totalToolCalls,
    totalLinesAdded,
    totalLinesRemoved,
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
        debounceRef.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { text: output, padding };
}
