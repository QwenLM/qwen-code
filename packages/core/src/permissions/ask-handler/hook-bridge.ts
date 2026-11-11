/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Connecting the host's PermissionRequest hook to the ask-handler bridge.
 *
 * The bridge (`withPermissionRequestHook`) is deliberately decoupled from the hook
 * system: it only needs a `getVerdict` function. This file is the one place that
 * knows both sides — it fires the host hook and translates its output class into
 * the structural verdict the bridge consumes. Keeping the translation here means the
 * ask-handler never imports the hooks module, so the layering stays one-directional.
 */

import type { Config } from '../../config/config.js';
import {
  NotificationType,
  PermissionRequestHookOutput,
} from '../../hooks/types.js';
import type { PermissionSuggestion } from '../../hooks/types.js';
import type { PermissionUpdate } from '../../tools/tool-checkers/checker-reasons.js';
import type {
  PermissionRequestHookBridge,
  PermissionRequestHookVerdict,
} from './ask-handler.js';
import type { AskPrompt } from './ask-handler.js';

/**
 * Convert prompt updates into the hook system's suggestion shape.
 *
 * The hook must receive the same suggestions the prompt was built from,
 * including the `ruleContent ?? ''` normalization.
 */
function permissionUpdatesToHookSuggestions(
  updates: PermissionUpdate[] | undefined,
): PermissionSuggestion[] | undefined {
  if (!updates || updates.length === 0) {
    return undefined;
  }
  return updates.map((update): PermissionSuggestion => {
    const suggestion: PermissionSuggestion = { type: update.type };
    if (
      update.type === 'addRules' ||
      update.type === 'replaceRules' ||
      update.type === 'removeRules'
    ) {
      suggestion.rules = update.rules.map((rule) => ({
        toolName: rule.toolName,
        ruleContent: rule.ruleContent ?? '',
      }));
      suggestion.behavior = update.behavior;
      suggestion.destination = update.destination;
    }
    if (update.type === 'setMode') {
      suggestion.mode = update.mode;
      suggestion.destination = update.destination;
    }
    if (
      update.type === 'addDirectories' ||
      update.type === 'removeDirectories'
    ) {
      suggestion.directories = update.directories;
      suggestion.destination = update.destination;
    }
    return suggestion;
  });
}

/**
 * Build a bridge from a live Config.
 *
 * The session permission module may not exist yet when a channel installs its
 * ask handler (the TUI builds its queue before the session is initialised), so
 * the bridge reads it lazily: a verdict can only be applied during a live
 * check, by which time the module exists.
 */
export function createPermissionRequestHookBridge(
  config: Config,
): PermissionRequestHookBridge {
  return {
    get permission() {
      const permission = config.permission;
      if (!permission) {
        throw new Error('Session permission module is not ready');
      }
      return permission;
    },
    get askMetrics() {
      return config.permissionTelemetry.askMetrics;
    },
    get settingsWriter() {
      return config.permission?.getSettingsWriter?.();
    },
    onModeChange: (mode) => config.setPermissionMode(mode, { trigger: 'hook' }),
    // A deny that asks to interrupt stops the turn through the session's slot,
    // which is where a host whose bridge predates its AbortController publishes
    // one. Optional-chained like the reads above: a stub Config has no slot.
    // A channel holding its controller already overrides this.
    onInterrupt: () => config.invokeTurnInterrupt?.(),

    async getVerdict({ toolName, input, suggestions, signal }) {
      // Optional chaining: a host without a hook system (or a test stub without
      // one) yields no verdict rather than throwing.
      const hookSystem = config.getHookSystem?.();
      if (!hookSystem) {
        return undefined;
      }

      const result = await hookSystem.firePermissionRequestEvent(
        toolName,
        input,
        permissionUpdatesToHookSuggestions(suggestions),
        signal,
        config.getModel?.(),
      );

      const output = result?.finalOutput;
      if (!(output instanceof PermissionRequestHookOutput)) {
        return undefined;
      }

      const decision = output.getDecision();
      if (!decision) {
        return undefined;
      }

      const verdict: PermissionRequestHookVerdict = {
        behavior: decision.behavior,
      };
      const updatedInput = output.getUpdatedInput();
      if (updatedInput) {
        verdict.updatedInput = updatedInput;
      }
      const updatedPermissions = output.getUpdatedPermissions();
      if (updatedPermissions) {
        verdict.updatedPermissions = updatedPermissions as PermissionUpdate[];
      }
      if (decision.message !== undefined) {
        verdict.message = decision.message;
      }
      if (decision.interrupt) {
        verdict.interrupt = true;
      }
      return verdict;
    },
  };
}

/**
 * Notify the `Notification/permission_prompt` event when a prompt is shown.
 * Fire-and-forget: the event never settles the ask.
 */
export function permissionPromptNotifier(
  config: Config,
): (prompt: AskPrompt) => void {
  return (prompt) => {
    const hookSystem = config.getHookSystem?.();
    if (!hookSystem) {
      return;
    }
    void hookSystem.fireNotificationEvent(
      NotificationType.PermissionPrompt,
      `Tool ${prompt.toolName} requires confirmation`,
      {
        toolName: prompt.toolName,
        toolUseId: prompt.toolUseId,
        input: prompt.input,
        message: prompt.reason.message,
      },
    );
  };
}
