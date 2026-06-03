/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { exec, type ChildProcess } from 'child_process';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useVimModeState } from '../contexts/VimModeContext.js';
import type { SessionMetrics } from '../contexts/SessionContext.js';
import {
  aggregateModelTokens,
  buildStatusLinePresetData,
  buildStatusLinePresetLines,
  normalizeStatusLinePresetConfig,
  type StatusLinePresetConfig,
} from '../statusLinePresets.js';

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
  /**
   * Present when the session is inside an active worktree (created by
   * `enter_worktree`). Field names mirror claude-code's StatusLine payload
   * so users can share statusline scripts across both CLIs.
   */
  worktree?: {
    name: string;
    path: string;
    branch: string;
    original_cwd: string;
    original_branch: string;
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

interface StatusLineCommandConfig {
  type: 'command';
  command: string;
  // Re-run the command every N seconds so external data (git branch, quota,
  // clock) stays fresh even when no Agent state changes. Values < 1 are
  // rejected in getStatusLineConfig to avoid flooding the CLI with execs.
  refreshInterval?: number;
  // When true, ANSI color codes in the command output are preserved as-is.
  // The renderer will not apply dimColor or theme color overrides.
  respectUserColors?: boolean;
  // When true, the built-in context usage indicator in the footer right
  // section is hidden. Useful when the statusline already shows context info.
  hideContextIndicator?: boolean;
}

type StatusLineConfig = StatusLineCommandConfig | StatusLinePresetConfig;

const debugLog = createDebugLogger('STATUS_LINE');
// Footer's bottom row (hint/mode indicator) occupies 1 line, so the status
// line gets at most 2 to keep the total footer height at 3 rows max.
export const MAX_STATUS_LINES = 2;
const PULL_REQUEST_LOOKUP_COMMAND = 'gh pr view --json number --jq .number';

function parsePullRequestNumber(stdout: string): string | undefined {
  const prNumber = stdout.trim();
  return /^\d+$/.test(prNumber) ? prNumber : undefined;
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
      typeof raw.refreshInterval === 'number' &&
      Number.isFinite(raw.refreshInterval) &&
      raw.refreshInterval >= 1
    ) {
      config.refreshInterval = raw.refreshInterval;
    }
    if (typeof raw.respectUserColors === 'boolean') {
      config.respectUserColors = raw.respectUserColors;
    }
    if (typeof raw.hideContextIndicator === 'boolean') {
      config.hideContextIndicator = raw.hideContextIndicator;
    }
    return config;
  }
  return normalizeStatusLinePresetConfig(raw);
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
 * new messages, vim mode toggle) rather than blind polling. When the config
 * sets `refreshInterval` (seconds, >= 1), the command is additionally re-run
 * on a timer so external data (git branch, quota, clock) stays fresh even
 * when no Agent state has changed.
 */
export function useStatusLine(): {
  lines: string[];
  useThemeColors: boolean;
  respectUserColors: boolean;
  hideContextIndicator: boolean;
} {
  const settings = useSettings();
  const uiState = useUIState();
  const config = useConfig();
  const { vimEnabled, vimMode } = useVimModeState();

  const settingsStatusLineConfig = getStatusLineConfig(settings);
  const statusLineConfigOverride = uiState.statusLineConfigOverride;
  const statusLineConfig =
    statusLineConfigOverride &&
    settingsStatusLineConfig &&
    statusLineConfigOverride.type === settingsStatusLineConfig.type
      ? statusLineConfigOverride
      : settingsStatusLineConfig;
  const statusLineCommand =
    statusLineConfig?.type === 'command' ? statusLineConfig.command : undefined;
  const statusLinePreset =
    statusLineConfig?.type === 'preset' ? statusLineConfig : undefined;
  const statusLineSettingsVersion = uiState.statusLineSettingsVersion ?? 0;
  const hasStatusLinePreset = statusLinePreset !== undefined;
  const statusLinePresetUseThemeColors =
    statusLinePreset?.useThemeColors ?? false;
  const statusLinePresetItemsKey = statusLinePreset?.items.join('\0') ?? '';
  const refreshInterval =
    statusLineConfig?.type === 'command'
      ? statusLineConfig.refreshInterval
      : undefined;

  const [output, setOutput] = useState<string[]>([]);
  const [pullRequestNumber, setPullRequestNumber] = useState<
    string | undefined
  >(undefined);

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
  const statusLinePresetRef = useRef(statusLinePreset);
  statusLinePresetRef.current = statusLinePreset;
  const pullRequestNumberRef = useRef<string | undefined>(pullRequestNumber);
  pullRequestNumberRef.current = pullRequestNumber;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Track previous trigger values to detect actual changes.
  // Initialized with current values so the state-change effect
  // does not fire redundantly on mount.
  const { lastPromptTokenCount } = uiState.sessionStats;
  const { currentModel, branchName, activeWorktree, streamingState } = uiState;
  // Track only the slug — equality on the whole object would re-fire on
  // every render because `activeWorktree` is rebuilt by AppContainer's
  // useMemo each time the sidecar reloads.
  const worktreeSlug = activeWorktree?.slug;
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
    worktreeSlug: string | undefined;
    totalToolCalls: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
    streamingState: string;
  }>({
    promptTokenCount: lastPromptTokenCount,
    currentModel,
    effectiveVim,
    branchName,
    worktreeSlug,
    totalToolCalls,
    totalLinesAdded,
    totalLinesRemoved,
    streamingState,
  });

  // Guard: when true, the mount effect has already called doUpdate so the
  // command-change effect should skip its first run to avoid a double exec.
  const hasMountedRef = useRef(false);

  // Track the active child process so we can kill it on new updates / unmount.
  const activeChildRef = useRef<ChildProcess | undefined>(undefined);
  const generationRef = useRef(0);
  const pullRequestLookupChildRef = useRef<ChildProcess | undefined>(undefined);
  const pullRequestLookupGenerationRef = useRef(0);
  const pullRequestLookupKeyRef = useRef<string | undefined>(undefined);

  const updatePullRequestNumber = useCallback(
    (nextPullRequestNumber: string | undefined) => {
      if (pullRequestNumberRef.current === nextPullRequestNumber) {
        return;
      }
      pullRequestNumberRef.current = nextPullRequestNumber;
      setPullRequestNumber(nextPullRequestNumber);
    },
    [],
  );

  const clearPullRequestLookup = useCallback(() => {
    pullRequestLookupChildRef.current?.kill();
    pullRequestLookupChildRef.current = undefined;
    pullRequestLookupGenerationRef.current++;
    pullRequestLookupKeyRef.current = undefined;
    updatePullRequestNumber(undefined);
  }, [updatePullRequestNumber]);

  const ensurePullRequestNumber = useCallback(
    (
      preset: StatusLinePresetConfig,
      currentDir: string,
      branch: string | undefined,
    ) => {
      if (!preset.items.includes('pull-request-number') || !branch) {
        clearPullRequestLookup();
        return;
      }

      const lookupKey = `${currentDir}\0${branch}`;
      if (pullRequestLookupKeyRef.current === lookupKey) {
        return;
      }

      pullRequestLookupChildRef.current?.kill();
      pullRequestLookupChildRef.current = undefined;
      updatePullRequestNumber(undefined);

      const generation = ++pullRequestLookupGenerationRef.current;
      let child: ChildProcess;
      try {
        child = exec(
          PULL_REQUEST_LOOKUP_COMMAND,
          { cwd: currentDir, timeout: 2000, maxBuffer: 1024 },
          (error, stdout) => {
            if (
              generation !== pullRequestLookupGenerationRef.current ||
              pullRequestLookupKeyRef.current !== lookupKey
            ) {
              return;
            }
            pullRequestLookupChildRef.current = undefined;
            if (error) {
              debugLog.warn('statusline: gh pr view failed:', error.message);
              pullRequestLookupKeyRef.current = undefined;
              updatePullRequestNumber(undefined);
              return;
            }
            updatePullRequestNumber(parsePullRequestNumber(stdout));
          },
        );
      } catch (err) {
        debugLog.warn('statusline: gh pr view failed:', (err as Error).message);
        pullRequestLookupKeyRef.current = undefined;
        updatePullRequestNumber(undefined);
        return;
      }

      pullRequestLookupChildRef.current = child;
      pullRequestLookupKeyRef.current = lookupKey;
    },
    [clearPullRequestLookup, updatePullRequestNumber],
  );

  const doUpdate = useCallback(() => {
    const preset = statusLinePresetRef.current;
    if (preset) {
      if (activeChildRef.current) {
        activeChildRef.current.kill();
        activeChildRef.current = undefined;
        generationRef.current++;
      }

      const ui = uiStateRef.current;
      const cfg = configRef.current;
      const stats = ui.sessionStats;
      const m = stats.metrics;
      const currentDir = cfg.getTargetDir();
      ensurePullRequestNumber(preset, currentDir, ui.branchName);

      const { totalInputTokens, totalOutputTokens } = aggregateModelTokens(m);

      const contentGeneratorConfig = cfg.getContentGeneratorConfig();
      const contextWindowSize = contentGeneratorConfig?.contextWindowSize || 0;
      const data = buildStatusLinePresetData({
        sessionId: stats.sessionId,
        version: cfg.getCliVersion(),
        modelDisplayName: ui.currentModel || cfg.getModel(),
        reasoning: contentGeneratorConfig?.reasoning,
        currentDir,
        branch: ui.branchName,
        pullRequestNumber: pullRequestNumberRef.current,
        contextWindowSize,
        currentUsage: stats.lastPromptTokenCount,
        totalInputTokens,
        totalOutputTokens,
        totalLinesAdded: m.files.totalLinesAdded,
        totalLinesRemoved: m.files.totalLinesRemoved,
        streamingState: ui.streamingState,
      });
      setOutput(buildStatusLinePresetLines(preset, data));
      return;
    }

    clearPullRequestLookup();

    const cmd = statusLineCommandRef.current;
    if (!cmd) {
      setOutput([]);
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

    const { totalInputTokens, totalOutputTokens } = aggregateModelTokens(m);

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
      ...(ui.activeWorktree && {
        worktree: {
          name: ui.activeWorktree.slug,
          path: ui.activeWorktree.path,
          branch: ui.activeWorktree.branch,
          original_cwd: ui.activeWorktree.originalCwd,
          original_branch: ui.activeWorktree.originalBranch,
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

    // exec() can throw synchronously: libuv reports a handful of spawn
    // errors (EACCES, ENOENT, …) via the async 'error' event, but anything
    // else — including EBADF, reported on macOS Node 22 in issue #3264 — is
    // thrown from ChildProcess.spawn. Without this guard the throw escapes
    // the setTimeout callback and crashes the CLI as uncaughtException.
    let child: ChildProcess;
    try {
      child = exec(
        cmd,
        { cwd: cfg.getTargetDir(), timeout: 5000, maxBuffer: 1024 * 10 },
        (error, stdout) => {
          if (gen !== generationRef.current) return; // stale
          activeChildRef.current = undefined;
          const nextLines =
            !error && stdout
              ? stdout
                  .replace(/\r?\n$/, '')
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .slice(0, MAX_STATUS_LINES)
              : [];
          // Skip the state update if the output is unchanged — avoids a
          // Footer re-render each periodic tick, which cuts wasted work
          // and reduces the window for Ink to miscount rows in narrow
          // terminals when `refreshInterval` runs at 1s (see #3383).
          setOutput((prev) => {
            if (
              prev.length === nextLines.length &&
              prev.every((v, i) => v === nextLines[i])
            ) {
              return prev;
            }
            return nextLines;
          });
        },
      );
    } catch (err) {
      debugLog.error('statusline exec error:', (err as Error).message);
      setOutput([]);
      return;
    }

    activeChildRef.current = child;

    // Pass structured JSON context via stdin.
    // Guard against EPIPE if the child exits before we finish writing.
    if (child.stdin) {
      child.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          debugLog.error('statusline stdin error:', err.message);
        }
      });
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  }, [clearPullRequestLookup, ensurePullRequestNumber]);

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
    if (!statusLineCommand && !hasStatusLinePreset) {
      // Command removed — kill any in-flight process and discard callbacks.
      activeChildRef.current?.kill();
      activeChildRef.current = undefined;
      generationRef.current++;
      pullRequestLookupChildRef.current?.kill();
      pullRequestLookupChildRef.current = undefined;
      pullRequestLookupGenerationRef.current++;
      pullRequestLookupKeyRef.current = undefined;
      updatePullRequestNumber(undefined);
      if (debounceTimerRef.current !== undefined) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = undefined;
      }
      setOutput([]);
      return;
    }

    const prev = prevStateRef.current;
    if (
      lastPromptTokenCount !== prev.promptTokenCount ||
      currentModel !== prev.currentModel ||
      effectiveVim !== prev.effectiveVim ||
      branchName !== prev.branchName ||
      worktreeSlug !== prev.worktreeSlug ||
      totalToolCalls !== prev.totalToolCalls ||
      totalLinesAdded !== prev.totalLinesAdded ||
      totalLinesRemoved !== prev.totalLinesRemoved ||
      streamingState !== prev.streamingState
    ) {
      prev.promptTokenCount = lastPromptTokenCount;
      prev.currentModel = currentModel;
      prev.effectiveVim = effectiveVim;
      prev.branchName = branchName;
      prev.worktreeSlug = worktreeSlug;
      prev.totalToolCalls = totalToolCalls;
      prev.totalLinesAdded = totalLinesAdded;
      prev.totalLinesRemoved = totalLinesRemoved;
      prev.streamingState = streamingState;
      scheduleUpdate();
    }
  }, [
    statusLineCommand,
    hasStatusLinePreset,
    statusLinePresetUseThemeColors,
    statusLinePresetItemsKey,
    statusLineSettingsVersion,
    lastPromptTokenCount,
    currentModel,
    effectiveVim,
    branchName,
    worktreeSlug,
    totalToolCalls,
    totalLinesAdded,
    totalLinesRemoved,
    streamingState,
    scheduleUpdate,
    updatePullRequestNumber,
  ]);

  // File edits made during a turn bypass in-memory settings; reload the user
  // scope on idle, then re-render only if ui.statusLine changed.
  const [settingsReloadKey, setSettingsReloadKey] = useState(0);
  const prevStreamingForReloadRef = useRef(streamingState);
  useEffect(() => {
    const prev = prevStreamingForReloadRef.current;
    prevStreamingForReloadRef.current = streamingState;
    if (prev !== streamingState && streamingState === 'idle') {
      const before = JSON.stringify(settings.merged.ui?.statusLine);
      settings.reloadScopeFromDisk(SettingScope.User);
      const after = JSON.stringify(settings.merged.ui?.statusLine);
      if (before !== after) {
        setSettingsReloadKey((k) => k + 1);
      }
    }
  }, [streamingState, settings]);

  // Re-execute immediately when the command itself changes (hot reload).
  // Skip the first run — the mount effect below already handles it.
  useEffect(() => {
    if (!hasMountedRef.current) return;
    if (statusLineCommand || hasStatusLinePreset) {
      // Clear any pending debounce so we don't get a redundant second run.
      if (debounceTimerRef.current !== undefined) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = undefined;
      }
      doUpdate();
    }
    // Cleanup when command is removed is handled by the state-change effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    statusLineCommand,
    hasStatusLinePreset,
    statusLinePresetUseThemeColors,
    statusLinePresetItemsKey,
    statusLineSettingsVersion,
    settingsReloadKey,
  ]);

  // Re-render preset output once the async GitHub PR lookup returns.
  useEffect(() => {
    if (!hasMountedRef.current || !hasStatusLinePreset) return;
    scheduleUpdate();
  }, [
    pullRequestNumber,
    hasStatusLinePreset,
    statusLinePresetUseThemeColors,
    statusLinePresetItemsKey,
    statusLineSettingsVersion,
    scheduleUpdate,
  ]);

  // Periodic refresh — re-run the command every `refreshInterval` seconds.
  // The tick yields if a previous exec is still running: unlike state-change
  // triggers (which legitimately need to preempt stale data), the periodic
  // tick exists only to keep external data fresh, so killing an in-flight
  // child would starve commands that run longer than `refreshInterval` and
  // the statusline would never update. The 5s exec timeout still caps the
  // wait, and state-change triggers still go through `doUpdate` directly.
  useEffect(() => {
    if (!statusLineCommand || !refreshInterval) return;
    const timer = setInterval(() => {
      if (activeChildRef.current) return;
      doUpdate();
    }, refreshInterval * 1000);
    return () => {
      clearInterval(timer);
    };
  }, [statusLineCommand, refreshInterval, doUpdate]);

  // Initial execution + cleanup
  useEffect(() => {
    hasMountedRef.current = true;
    const genRef = generationRef;
    const debounceRef = debounceTimerRef;
    const childRef = activeChildRef;
    const pullRequestChildRef = pullRequestLookupChildRef;
    const pullRequestGenerationRef = pullRequestLookupGenerationRef;
    doUpdate();
    return () => {
      // Kill active child process and invalidate callbacks
      childRef.current?.kill();
      childRef.current = undefined;
      genRef.current++;
      pullRequestChildRef.current?.kill();
      pullRequestChildRef.current = undefined;
      pullRequestGenerationRef.current++;
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
        debounceRef.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    lines: output,
    useThemeColors: statusLinePreset?.useThemeColors === true,
    respectUserColors:
      statusLineConfig?.type === 'command' &&
      statusLineConfig.respectUserColors === true,
    hideContextIndicator: statusLineConfig?.hideContextIndicator === true,
  };
}
