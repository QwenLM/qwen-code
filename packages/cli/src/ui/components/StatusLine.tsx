/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StatusLineDataContext } from '../contexts/StatusLineDataContext.js';
import { Box, Text, Ansi } from 'ink';
import {
  executeStatusLineCommand,
  buildStatusLineInput,
  getDisplayString,
  getRawContextWindowSize,
} from '@qwen-code/core';
import type { Model, StatusLineConfig } from '@qwen-code/core';
import { useSettings } from '../contexts/SettingsContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { StatusLineDefault } from './StatusLineDefault.js';
import type { HistoryItem } from '../types.js';

/** Debounce delay in ms before executing the command after a trigger. */
const DEBOUNCE_MS = 300;

/**
 * Resolve the effective model ID, falling back to the server default model
 * when the current model is empty (for example after settings change during
 * an active session).
 */
function resolveModelId(listed: Model | undefined, model: string): string {
  return model || listed?.key || model;
}

/**
 * The id of the most recent completed assistant message, or `undefined` when
 * the assistant has not produced one yet.
 *
 * Streaming partials live in `pendingHistoryItems`; a block is committed to
 * `history` only once it is complete, so reading from `history` gives exactly
 * one trigger per assistant message rather than one per stream chunk.
 */
function findLastAssistantMessageId(
  history: readonly HistoryItem[],
): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type === 'gemini' || item.type === 'gemini_content') {
      return item.id;
    }
  }
  return undefined;
}

/**
 * Custom StatusLine component.
 *
 * When a user-configured shell command is present, runs it, pipes rich JSON
 * session data on stdin, and renders the stdout (including ANSI colors).
 *
 * When no custom command is configured — or when `disableAllHooks` is set —
 * falls back to the built-in default status line, which shows
 * model · workspace · diff stats.
 *
 * Updates are debounced at 300 ms and the command has a 5 s timeout.
 */
const StatusLineInner: React.FC = () => {
  const settings = useSettings();
  const uiState = useUIState();
  const config = useConfig();
  const { vimMode } = useVimMode();
  const additionalData = useContext(StatusLineDataContext);
  const additionalDataRef = useRef(additionalData);
  additionalDataRef.current = additionalData;
  // Polling can publish a new object with unchanged values. Only schedule a
  // command when the product fingerprint changes, using the existing debounce.
  const additionalDataFingerprint = additionalData?.fingerprint ?? '';

  const [statusText, setStatusText] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const logNextRef = useRef(true);

  const lastAssistantMessageId = useMemo(
    () => findLastAssistantMessageId(uiState.history),
    [uiState.history],
  );

  const statusLineConfig = settings.merged.statusLine;
  const isValidConfig = (
    cfg: unknown,
  ): cfg is StatusLineConfig & { type: 'command'; command: string } =>
    !!cfg &&
    typeof cfg === 'object' &&
    (cfg as { type?: unknown }).type === 'command' &&
    typeof (cfg as { command?: unknown }).command === 'string' &&
    ((cfg as { command?: string }).command ?? '').trim().length > 0;

  // `disableAllHooks` is documented as a top-level kill switch for anything
  // that spawns user-supplied code, which includes the status line command.
  // Treating it as "no custom command" also skips payload assembly and falls
  // back to the built-in status line, which needs no subprocess at all.
  //
  // Deliberately NOT `config.isAllHooksDisabled()`: that flag is also true when
  // `hooksConfig.enabled` is false, and disabling the hook subsystem should not
  // silently take the user's status line with it. The gate below and the one
  // inside `doUpdate` must stay on this same predicate — if they disagree, the
  // render path keeps the custom branch while execution is skipped, which
  // renders an empty line instead of falling back.
  //
  // `settingsNonce` is bumped by AppContainer on CoreEvent.SettingsChanged, so
  // this re-evaluates when the kill switch is flipped rather than relying on
  // incidental re-renders from unrelated UI state.
  const hooksDisabled = settings.merged.disableAllHooks === true;
  void uiState.settingsNonce;
  const hasCustomCommand = isValidConfig(statusLineConfig) && !hooksDisabled;

  // Track previous trigger values to detect changes.
  // `permissionMode` is in here because the payload carries it: without a
  // trigger of its own, a script showing "bypassPermissions" would keep
  // displaying the previous mode until the next assistant message — stale
  // exactly when being accurate matters most.
  const prevRef = useRef({
    messageId: lastAssistantMessageId,
    model: uiState.currentModel,
    contextWindow: uiState.currentContextWindow,
    vimMode,
    permissionMode: uiState.showPermissionModeIndicator,
    additionalDataFingerprint,
  });

  // INVARIANT: `doUpdate` must keep a stable identity.
  //
  // The "command changed" effect below lists `doUpdate` as a dependency so a
  // new command takes effect immediately. If `doUpdate` is recreated on every
  // render, that effect degrades into an undebounced `spawn` of the user's
  // shell command per render — and `uiState` changes at least once a second.
  // So every mutable input is mirrored into a ref here and read as
  // `*Ref.current` inside `doUpdate`, instead of going into its dependencies.
  const uiStateRef = useRef(uiState);
  uiStateRef.current = uiState;
  const configRef = useRef(config);
  configRef.current = config;
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const statusLineConfigRef = useRef(statusLineConfig);
  statusLineConfigRef.current = statusLineConfig;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const doUpdate = useCallback(async () => {
    if (!hasCustomCommand) {
      return;
    }

    // Runtime kill switch, on the same predicate as the render gate above.
    // `merged` is a live getter (config/settings.ts:385), so this sees a
    // hot-reloaded value even if this closure predates the change.
    if (settingsRef.current.merged.disableAllHooks === true) {
      return;
    }

    // Abort any in-flight execution
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const shouldLog = logNextRef.current;
    logNextRef.current = false;

    try {
      const currentUiState = uiStateRef.current;
      const currentConfig = configRef.current;
      const sessionStats = currentUiState.sessionStats;
      const identity = currentConfig.getModelRequestIdentity();
      const sessionId = currentConfig.getSessionId();
      const key = currentUiState.currentModel;
      const manager = currentConfig.getModelProviderManager();
      const listed = key
        ? await manager.getModel(key)
        : (await manager.listModels()).find(
            (entry) => entry.isDefault === true && entry.enabled !== false,
          );
      const stillCurrent = () =>
        !controller.signal.aborted &&
        configRef.current === currentConfig &&
        uiStateRef.current.currentModel === key &&
        currentConfig.getModelRequestIdentity() === identity &&
        currentConfig.getSessionId() === sessionId;
      if (!stillCurrent()) return;
      const modelId = resolveModelId(listed, key);
      const contextWindowSize = getRawContextWindowSize(
        listed,
        currentConfig.getEffectiveContextWindow(listed, modelId),
      );
      const promptTokenCount = sessionStats.lastPromptTokenCount;
      const usedPercentage =
        contextWindowSize > 0
          ? Math.round((promptTokenCount / contextWindowSize) * 100)
          : null;
      const remainingPercentage =
        usedPercentage !== null ? 100 - usedPercentage : null;

      const targetDir = currentConfig.getTargetDir();

      // Inside a worktree session the project the user started from is the
      // worktree's origin, not the worktree itself — that is the only case
      // where `project_dir` carries information `current_dir` does not.
      const worktreeSettings = currentConfig.getWorktreeSettings();
      const sessionName = currentConfig.topicState.getTopic();
      const agentName = currentConfig.getSessionAgent();
      const addedDirs = currentConfig.getWorkspaceContext().getDirectories();

      const input = buildStatusLineInput({
        // `config.getSessionId()` rather than core's module-level `sessionId`
        // constant: the latter is fixed at import time, while the config value
        // is reassigned on resume and on /clear. Using the constant here would
        // hand scripts a `session_id` that disagrees with `transcript_path`.
        sessionId: currentConfig.getSessionId(),
        ...(sessionName && { sessionName }),
        cwd: targetDir,
        transcriptPath: currentConfig.getActiveSessionTranscriptPath(),
        permissionMode: currentConfig.getPermissionMode(),
        projectDir: worktreeSettings?.originalCwd ?? targetDir,
        ...(addedDirs.length > 0 && { addedDirs }),
        version: currentConfig.getCliVersion(),
        modelId,
        modelDisplayName: getDisplayString(listed, modelId),
        totalLinesAdded: sessionStats.metrics.files.totalLinesAdded,
        totalLinesRemoved: sessionStats.metrics.files.totalLinesRemoved,
        // The *current* context occupancy, not a session total — same source
        // that drives the percentage fields below. `buildStatusLineInput` also
        // accepts `totalOutputTokens`, but there is no equivalent per-turn
        // output figure, so that field is deliberately not emitted and is not
        // advertised to scripts either (see statusline-setup-agent.ts).
        totalInputTokens: promptTokenCount,
        contextWindowSize,
        usedPercentage,
        remainingPercentage,
        vimMode: vimModeRef.current ?? undefined,
        ...(agentName && { agentName }),
        ...(worktreeSettings && {
          worktree: {
            name: worktreeSettings.name,
            path: worktreeSettings.path,
            // Omitted rather than emitted as '' — an empty string reads as a
            // real branch name to a jq script, a missing key does not.
            ...(worktreeSettings.worktreeBranch && {
              branch: worktreeSettings.worktreeBranch,
            }),
            ...(worktreeSettings.originalCwd && {
              original_cwd: worktreeSettings.originalCwd,
            }),
            ...(worktreeSettings.originalBranch && {
              original_branch: worktreeSettings.originalBranch,
            }),
          },
        }),
      });

      const text = await executeStatusLineCommand(
        statusLineConfigRef.current as StatusLineConfig,
        additionalDataRef.current?.buildInput(input) ?? input,
        controller.signal,
        5000,
        shouldLog,
      );

      if (stillCurrent()) {
        setStatusText(text);
      }
    } catch {
      // Silently swallow — the script failing should never break the UI
    }
    // Every other input is read through a ref — see the INVARIANT note above,
    // which is why this dependency list is exhaustive with a single entry.
  }, [hasCustomCommand]);

  // Debounced scheduler
  const scheduleUpdate = useCallback(() => {
    if (debounceRef.current !== undefined) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = undefined;
      void doUpdate();
    }, DEBOUNCE_MS);
  }, [doUpdate]);

  // Re-run when trigger values change
  useEffect(() => {
    const prev = prevRef.current;
    if (
      lastAssistantMessageId !== prev.messageId ||
      uiState.currentModel !== prev.model ||
      uiState.currentContextWindow !== prev.contextWindow ||
      vimMode !== prev.vimMode ||
      uiState.showPermissionModeIndicator !== prev.permissionMode ||
      additionalDataFingerprint !== prev.additionalDataFingerprint
    ) {
      prevRef.current = {
        messageId: lastAssistantMessageId,
        model: uiState.currentModel,
        contextWindow: uiState.currentContextWindow,
        vimMode,
        permissionMode: uiState.showPermissionModeIndicator,
        additionalDataFingerprint,
      };
      scheduleUpdate();
    }
  }, [
    lastAssistantMessageId,
    uiState.currentModel,
    uiState.currentContextWindow,
    uiState.showPermissionModeIndicator,
    vimMode,
    additionalDataFingerprint,
    scheduleUpdate,
  ]);

  // Drop stale output when the command goes away or is switched off, so
  // flipping the kill switch mid-session cannot leave the last rendered line
  // frozen on screen.
  useEffect(() => {
    if (!hasCustomCommand) {
      setStatusText(undefined);
    }
  }, [hasCustomCommand]);

  // Immediate update when the statusLine command itself changes
  const statusLineCommand = statusLineConfig?.command;
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    logNextRef.current = true;
    void doUpdate();
  }, [statusLineCommand, doUpdate]);

  // Initial execution + cleanup
  useEffect(() => {
    void doUpdate();
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current !== undefined) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // No custom command configured — render built-in default status line
  if (!hasCustomCommand) {
    return <StatusLineDefault />;
  }

  const paddingX = statusLineConfig.padding ?? 0;

  return (
    <Box paddingX={paddingX} flexDirection="column">
      {statusText
        ? // Ink's `truncate` wrap treats the whole string as one line, so each
          // output line must be its own <Text> to keep multi-line scripts intact.
          statusText.split('\n').map((line, index) => (
            <Text key={index} wrap="truncate">
              <Ansi dimColor>{line}</Ansi>
            </Text>
          ))
        : null}
    </Box>
  );
};

export const StatusLine = memo(StatusLineInner);
