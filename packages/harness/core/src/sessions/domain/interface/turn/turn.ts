/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turn — one round of user input, keyed by {@link PromptId}.
 *
 * A turn starts when the user submits input and ends when the agent's work
 * for it settles. Everything the round produces — the human input message,
 * tool-result messages, assistant messages, subagent sidechains — belongs
 * to the turn:
 *
 * - The promptId is persisted on the user entries of the turn (the human
 *   input entry carries it alongside its requestSetId; tool-result messages
 *   repeat it), so turns are recoverable from disk — no in-memory grouping
 *   required.
 * - A turn references its owning session by {@link SessionId} alone — the
 *   id fully addresses the session (file name = id), so no other locator
 *   is needed on the entity.
 * - Assistant messages in the turn are linked through the message DAG
 *   (parentUuid), not through the promptId.
 * - Rewind targets are turns: rolling back to a turn means moving the active
 *   leaf before the turn's user message.
 */

import type { Message } from '../message/message.js';

/**
 * One user turn, keyed by {@link PromptId}.
 */
export interface Turn {
  getPromptId(): string;
  /** Owning session — the id alone fully addresses it (file name = id). */
  getSessionId(): string;
  /** Request-set grouping key for the model requests this turn issued. */
  getRequestSetId(): string | undefined;

  /** The human-authored anchor message that started the turn. Its uuid is
   * what a rewind plan targets.
   */
  getUserMessage(): Message;
  /** Original human input, used to prefill the editor after a rewind. */
  getPromptText(): string;
  /** How the input was entered. */
  getInputMode(): 'prompt' | 'bash';

  // ── Sidechain / rewind semantics ──
  /** Owning subagent, when this turn belongs to a sidechain. */
  getAgentId(): string | undefined;
  /** Whether this turn runs on a subagent sidechain. */
  isSidechain(): boolean;
  /** The user message uuid a rewind plan moves the active leaf before. */
  getRewindTargetUuid(): string;
  /** Whether this turn starts at a compact boundary head. */
  isCompactBoundary(): boolean;

  /** All messages produced during the turn, chain-ordered. */
  getMessages(): readonly Message[];
}
