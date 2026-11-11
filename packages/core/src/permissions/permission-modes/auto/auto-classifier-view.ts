/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolCheckContext,
  AutoClassifierView as AutoClassifierViewContract,
} from '../../manager/decision/index.js';
import { createDenialTracker, type DenialTracker } from './denial-tracking.js';
import {
  AUTO_MODE_BREAKER_DECISION_POINT,
  type ToolPermissionReason,
} from '../../../tools/tool-checkers/checker-reasons.js';
import type { ToolPermissionResult } from '../../../tools/tool-checkers/rule-precedence.js';
import { createEmptyToolLookup, toClassifierMessages } from './classifier.js';
import type {
  AutoClassifier,
  AutoClassifierSession,
} from './auto-classifier.js';
import type { Message } from '../../../protocol/transcript/message.js';
import {
  COMPLETE_TASK_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
} from '../../../tools/tool-names.js';

type Ask = Extract<ToolPermissionResult, { kind: 'ask' }>;

/**
 * Tools auto mode lets through without the classifier. Read-only file access,
 * search, and task/knowledge bookkeeping: the worst case is reading something,
 * so the check is deliberately input-blind — an out-of-workspace target stays
 * listed rather than starting to cost a classifier call.
 */
const SAFE_AUTO_ALLOWLISTED_TOOLS = new Set([
  READ_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  COMPLETE_TASK_TOOL_NAME,
]);

/**
 * What the registration knows about a tool that the view cannot see on the
 * context. Both come from the check table, which is where a tool's nature is
 * declared.
 */
export interface AutoModeToolFacts {
  toolName: string;
  /** A file edit — the thing AcceptEdits, and therefore Auto, is about. */
  coveredByAcceptEdits: boolean;
}

/** 每个 Agent 独立保存拒绝计数，并把模型判断转换成权限结果。 */
export class AutoClassifierView
  implements AutoClassifierViewContract<ToolPermissionReason>
{
  private tracker: DenialTracker = createDenialTracker();

  constructor(private readonly classifier: AutoClassifier) {}

  resetTracker(): void {
    this.tracker = createDenialTracker();
  }

  readonly classify = async (
    facts: AutoModeToolFacts,
    input: Record<string, unknown>,
    ctx: ToolCheckContext<ToolPermissionReason>,
    ask: Ask,
    messages?: readonly unknown[],
    session?: AutoClassifierSession,
  ): Promise<ToolPermissionResult> => {
    const classifier = this.classifier;
    const tracker = this.tracker;

    if (SAFE_AUTO_ALLOWLISTED_TOOLS.has(facts.toolName)) {
      tracker.recordAllow();
      return {
        kind: 'allow',
        extra: { ...ask.extra, decisionPoint: 'mode.auto_allowlist.allow' },
      };
    }

    // Safety-check refusals and outside-workspace targets go to the
    // classifier rather than a hard deny; the flags only keep them off the
    // accept-edits fast path.
    const safetyFlagged =
      ask.reason.attribution.type === 'safetyCheck' ||
      Boolean(ask.reason.blockedPath) ||
      ask.extra?.autoModeReview === true;

    if (facts.coveredByAcceptEdits && !safetyFlagged) {
      tracker.recordAllow();
      return {
        kind: 'allow',
        extra: { ...ask.extra, decisionPoint: 'mode.auto_accept_edits.allow' },
      };
    }

    if (!classifier.isAvailable(session)) {
      return escalateToAsk(classifier, session, facts, input, ask, {
        message: unavailableMessage(facts.toolName),
        detail: 'Classifier invoke function not configured',
        decisionPoint: 'mode.auto_classifier_unavailable.keep_ask',
        denialKind: 'automode-unavailable',
      });
    }

    const verdict = await classifier.classify(
      session!,
      toClassifierMessages(
        (messages as readonly Message[] | undefined) ?? session!.getMessages(),
      ),
      facts.toolName,
      input,
      session!.getToolLookup() ?? createEmptyToolLookup(),
      ctx.signal ?? new AbortController().signal,
      {
        toolCallId: ctx.toolUseId,
        toolName: facts.toolName,
        isSubagent: ctx.agentId !== undefined,
      },
    );

    // Every result below preserves ask.extra, including failures and the
    // circuit breaker. Keep the guarded check on this path, never on session state.
    ask = {
      ...ask,
      extra: {
        ...ask.extra,
        autoClassifier: {
          route: verdict.route,
          ...(verdict.fallbackReason
            ? { fallbackReason: verdict.fallbackReason }
            : {}),
        },
      },
    };

    if (verdict.transcriptTooLong) {
      // The classifier never saw the action, so this is not a verdict about
      // it: hand it to the user and leave the denial streak alone. Checked
      // before `unavailable`, which would otherwise turn it into a deny.
      record(classifier, session, facts.toolName, input, verdict.reason);
      return {
        ...ask,
        reason: {
          message: verdict.reason,
          attribution: { type: 'other', reason: verdict.reason },
          decisionPoint: 'mode.auto_transcript_too_long.keep_ask',
        },
      };
    }

    if (verdict.unavailable) {
      return escalateToAsk(classifier, session, facts, input, ask, {
        message: unavailableMessage(facts.toolName),
        detail: verdict.reason,
        decisionPoint: 'mode.auto_classifier_unavailable.keep_ask',
        denialKind: 'automode-unavailable',
      });
    }

    if (verdict.parsingError) {
      return denyByClassifier(
        classifier,
        session,
        facts.toolName,
        input,
        verdict.reason,
        {
          message: rejectionMessage(verdict.reason),
          decisionPoint: 'mode.auto_classifier_parse_error.deny',
          denialKind: 'automode-parsing-error',
        },
        ask,
      );
    }

    if (verdict.shouldBlock) {
      const denial = denyByClassifier(
        classifier,
        session,
        facts.toolName,
        input,
        verdict.reason,
        {
          message: rejectionMessage(verdict.reason),
          decisionPoint: 'mode.auto_classifier_blocked.deny',
          denialKind: 'automode-blocked',
        },
        ask,
      );

      // Only a classifier block trips the breaker. An unavailable classifier or a
      // malformed answer is the tool failing, not the model looping, and tripping
      // on those would strand a session in a mode it cannot leave by retrying.
      tracker.recordDenial();
      const breaker = tracker.checkCircuitBreaker();
      if (breaker.tripped) {
        // Hand the decision back to the user rather than latching the mode
        // shut: a run that trips the limit is usually one the user wants to
        // look at. Taking over resets the streak either way, so a reject does
        // not immediately re-trip and an approve resumes cleanly. Suggestions
        // are stripped so the dialog is a plain gate, not a rule-granting
        // prompt.
        tracker.reset();
        return {
          ...ask,
          reason: {
            message: breaker.message,
            attribution: {
              type: 'classifier',
              classifier: 'auto-mode',
              reason: `${breaker.message}\n\nLatest blocked action: ${verdict.reason}`,
            },
            decisionPoint: AUTO_MODE_BREAKER_DECISION_POINT,
          },
          suggestions: undefined,
        };
      }

      return denial;
    }

    tracker.recordAllow();
    return {
      kind: 'allow',
      extra: { ...ask.extra, decisionPoint: 'mode.auto_classifier.allow' },
    };
  };
}

function escalateToAsk(
  classifier: AutoClassifier,
  session: AutoClassifierSession | undefined,
  facts: AutoModeToolFacts,
  input: Record<string, unknown>,
  ask: Ask,
  reason: {
    message: string;
    detail: string;
    decisionPoint: string;
    denialKind: ToolPermissionReason['denialKind'];
  },
): Ask {
  const fallback = denyByClassifier(
    classifier,
    session,
    facts.toolName,
    input,
    reason.detail,
    reason,
    ask,
  );
  return {
    ...ask,
    reason: {
      ...ask.reason,
      message: `${ask.reason.message}\n\nAuto mode could not evaluate this action; approval is required.`,
      decisionPoint: reason.decisionPoint,
      denialKind: reason.denialKind,
    },
    // An unanswered ask needs the failure reason, not a fabricated user rejection.
    extra: fallback.extra,
  };
}

function denyByClassifier(
  classifier: AutoClassifier,
  session: AutoClassifierSession | undefined,
  toolName: string,
  input: Record<string, unknown>,
  classifierReason: string,
  refusal: {
    message: string;
    decisionPoint: string;
    denialKind: ToolPermissionReason['denialKind'];
  },
  ask: Ask,
): ToolPermissionResult {
  // No denial counting here: only a classifier block records the streak (the
  // breaker trips on the model looping, not on the classifier being broken).
  record(classifier, session, toolName, input, classifierReason);
  return refuse(ask, {
    ...refusal,
    attribution: {
      type: 'classifier',
      classifier: 'auto-mode',
      reason: classifierReason,
    },
  });
}

function refuse(
  ask: Ask,
  reason: {
    message: string;
    decisionPoint: string;
    denialKind: ToolPermissionReason['denialKind'];
    attribution: ToolPermissionReason['attribution'];
  },
): ToolPermissionResult {
  return {
    kind: 'deny',
    extra: {
      ...ask.extra,
      decisionPoint: reason.decisionPoint,
      denialReason: {
        message: reason.message,
        attribution: reason.attribution,
        denialKind: reason.denialKind,
        decisionPoint: reason.decisionPoint,
      },
    },
  };
}

function record(
  classifier: AutoClassifier,
  session: AutoClassifierSession | undefined,
  toolName: string,
  input: Record<string, unknown>,
  reason: string,
): void {
  if (!session) return;
  classifier.recordDenial(session.getSessionId(), {
    toolName,
    display: JSON.stringify(input).slice(0, 200),
    reason,
    timestamp: Date.now(),
  });
}

function unavailableMessage(toolName: string): string {
  return (
    `Auto mode could not determine whether ${toolName} is safe right now, ` +
    `because the classifier is temporarily unavailable. This is not a judgement ` +
    `about the action. Wait a moment and try the same action again. If it keeps ` +
    `failing, continue with other work that does not depend on it and come back ` +
    `later. Reading files and searching code do not need the classifier and still work.`
  );
}

function rejectionMessage(reason: string): string {
  return `Auto mode: action blocked by classifier — ${reason}`;
}
