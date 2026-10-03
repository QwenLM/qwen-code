/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { HookEventName } from './types.js';

/** How a consumer should present hook progress for one event. */
export interface HookEventDisplayMeta {
  /**
   * The event fires many times within one turn, so a consumer must not add one
   * line per execution. Only MessageDisplay today: it fires for each debounced
   * chunk of a streaming reply (MESSAGE_DISPLAY_DEBOUNCE_MS, 200 ms), so up to
   * about five start/end pairs a second for every configured hook.
   */
  highFrequency: boolean;
  /**
   * A blocked outcome on this event already produces its own visible message,
   * so a consumer that also renders the hook's blocked outcome would say the
   * same thing twice. Each `true` below names the code that renders it.
   */
  hasDedicatedMessage: boolean;
}

function meta(
  highFrequency: boolean,
  hasDedicatedMessage: boolean,
): Readonly<HookEventDisplayMeta> {
  return Object.freeze({ highFrequency, hasDedicatedMessage });
}

const ORDINARY = meta(false, false);

/**
 * Display metadata for every hook event. The Record type makes a new event a
 * compile error until it is classified here.
 */
export const HOOK_EVENT_DISPLAY: Readonly<
  Record<HookEventName, Readonly<HookEventDisplayMeta>>
> = Object.freeze({
  // message-display-dispatcher.ts requests the event once per debounced chunk.
  [HookEventName.MessageDisplay]: meta(true, false),
  // use-llm-stream.ts adds a `stop_hook_loop` history item.
  [HookEventName.Stop]: meta(false, true),
  // use-llm-stream.ts adds a `user_prompt_submit_blocked` history item.
  [HookEventName.UserPromptSubmit]: meta(false, true),
  // coreToolScheduler.ts fails the call with EXECUTION_DENIED and the reason.
  [HookEventName.PreToolUse]: meta(false, true),
  // formatUserPromptExpansionBlockedMessage is shown by every slash command
  // dispatcher (Ink, OpenTUI and non-interactive).
  [HookEventName.UserPromptExpansion]: meta(false, true),
  // todoWrite.ts returns createBlockedTodoResult for the new item.
  [HookEventName.TodoCreated]: meta(false, true),
  // todoWrite.ts returns createBlockedTodoResult for the completed item.
  [HookEventName.TodoCompleted]: meta(false, true),
  // coreToolScheduler.ts shows an error only when the hook sets
  // `continue: false`, while progress reports `blocked` for `decision: block`
  // or `deny`. The two tests differ, so a blocked outcome has no message.
  [HookEventName.PostToolUse]: ORDINARY,
  [HookEventName.PostToolUseFailure]: ORDINARY,
  [HookEventName.PostToolBatch]: ORDINARY,
  [HookEventName.Notification]: ORDINARY,
  [HookEventName.SessionStart]: ORDINARY,
  [HookEventName.SubagentStart]: ORDINARY,
  [HookEventName.SubagentStop]: ORDINARY,
  [HookEventName.PreCompact]: ORDINARY,
  [HookEventName.PostCompact]: ORDINARY,
  [HookEventName.SessionEnd]: ORDINARY,
  [HookEventName.SessionDelete]: ORDINARY,
  [HookEventName.PermissionRequest]: ORDINARY,
  [HookEventName.PermissionDenied]: ORDINARY,
  [HookEventName.StopFailure]: ORDINARY,
  [HookEventName.InstructionsLoaded]: ORDINARY,
  [HookEventName.MemoryChanged]: ORDINARY,
});

/**
 * Display metadata for one event. An event name this build does not know,
 * for example one that arrived over a protocol, is treated as ordinary: shown
 * once per execution, with no dedicated message.
 */
export function hookEventDisplay(
  eventName: HookEventName,
): Readonly<HookEventDisplayMeta> {
  return HOOK_EVENT_DISPLAY[eventName] ?? ORDINARY;
}
