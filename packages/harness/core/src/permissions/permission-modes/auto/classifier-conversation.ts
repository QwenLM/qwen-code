/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { estimateTextTokens } from '../../../utils/tokenCalculation.js';
import { buildClassifierUserPrompt } from './classifier-prompt.js';
import { LLM_HISTORY_BUDGET } from './llm-transcript.js';

export interface ClassifierConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

interface ConversationState {
  readonly system: string;
  readonly instructions: string;
  readonly evidence: string;
  readonly action: string;
  readonly messages: readonly ClassifierConversationMessage[];
}

export interface ClassifierConversationTurn {
  readonly history: readonly ClassifierConversationMessage[];
  readonly userPrompt: string;
  complete(userPrompt: string, response: string): void;
}

/** Estimated tokens of one turn: the dialogue so far plus the prompt being sent. */
export function estimateDialogueTokens(
  history: readonly ClassifierConversationMessage[],
  prompt: string,
): number {
  return history.reduce(
    (sum, message) => sum + estimateTextTokens(message.content),
    estimateTextTokens(prompt),
  );
}

/** Per-agent approval dialogue; evidence selection remains owned by the transcript renderer. */
export class ClassifierConversation {
  private state?: ConversationState;

  prepare(
    system: string,
    instructions: string,
    evidence: string,
    action: string,
    rebuild = false,
  ): ClassifierConversationTurn {
    const previous = this.state;
    let history: readonly ClassifierConversationMessage[] = [];
    let userPrompt: string;
    if (
      !rebuild &&
      previous &&
      previous.system === system &&
      previous.instructions === instructions &&
      evidence.startsWith(previous.evidence) &&
      this.retainsAction(evidence, previous.action)
    ) {
      history = previous.messages;
      userPrompt = buildClassifierUserPrompt(
        '',
        evidence.slice(previous.evidence.length),
        action,
      );
      // Bound the added dialogue, never shorten or reselect the renderer's evidence.
      const tokens = estimateDialogueTokens(history, userPrompt);
      if (tokens > LLM_HISTORY_BUDGET.messageTokens) {
        const fullPrompt = buildClassifierUserPrompt(
          instructions,
          evidence,
          action,
        );
        if (tokens > estimateTextTokens(fullPrompt)) {
          history = [];
          userPrompt = fullPrompt;
        }
      }
    } else {
      userPrompt = buildClassifierUserPrompt(instructions, evidence, action);
    }
    return {
      history,
      userPrompt,
      complete: (sentPrompt, response) => {
        // Parallel approvals may share a prefix, but cannot overwrite a newer completed turn.
        if (this.state !== previous) return;
        this.state = {
          system,
          instructions,
          evidence,
          action,
          messages: [
            ...history,
            { role: 'user', content: sentPrompt },
            { role: 'assistant', content: response },
          ],
        };
      },
    };
  }

  private retainsAction(evidence: string, action: string): boolean {
    const reviewed = JSON.stringify(JSON.parse(action));
    return evidence
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const { id: _id, ...record } = JSON.parse(line);
        return JSON.stringify(record) === reviewed;
      });
  }
}
