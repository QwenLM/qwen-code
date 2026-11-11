/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The host's permission vocabulary: why a call was judged the way it was, and
 * what change the prompt may offer to remember.
 *
 * The permission component (`permissions/manager/decision`) carries both verbatim
 * and reads neither — `reason` is its `TReason`, suggestions its `TSuggestion`.
 * Both shapes are therefore ours to define, and both are consumed by the ask
 * handler that renders the prompt.
 */

import type {
  AskHandler,
  PermissionBehavior,
  PermissionMode,
  PermissionRule,
  PermissionRuleValue,
  ToolCheckContext,
} from '../../permissions/manager/decision/index.js';
import type { PermissionPolicySnapshot } from '../../permissions/manager/policy.js';
import type { ToolPermissionDenialKind } from '../../protocol/schemas/common.js';
import type { AutoModeClassifierDetails } from '../../permissions/permission-modes/auto/classifier.js';
import { READ_FILE_TOOL_NAME } from '../tool-names.js';
import {
  directoryPermissionPattern,
  toPosixPath,
} from '../filesystem-permissions/pathRules.js';

/**
 * The decision point the auto-mode circuit breaker stamps on its ask.
 * Single source: the resolver stamps it, the channels render the dedicated
 * breaker dialog from it, and the gate recognises a breaker approval by it.
 */
export const AUTO_MODE_BREAKER_DECISION_POINT = 'mode.auto_denial_limit.keep_ask';

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * What decided a permission check. Kept structured rather than folded into the
 * message so reports can group by cause and the prompt can cite the exact
 * rule.
 */
export type PermissionAttribution =
  | { type: 'rule'; rule: PermissionRule }
  | {
      /** Host-owned provenance; not a component rule source. */
      type: 'managedRule';
    }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'classifier'; classifier: string; reason: string }
  | { type: 'hook'; hookName: string; hookSource?: string; reason?: string }
  | { type: 'workingDir'; reason: string }
  | {
      /**
       * The prompt is the tool's purpose — asking the user a question, reviewing
       * a plan. Neither a rule nor a mode may skip it, because what the dialog
       * collects has no other source.
       */
      type: 'interaction';
      reason: string;
    }
  | {
      type: 'safetyCheck';
      reason: string;
      /** Which safety rule tripped, e.g. a dangerous file or directory. */
      safetyCheckKind?: string;
      /** Whether the auto-mode classifier is allowed to approve this. */
      classifierApprovable?: boolean;
      /**
       * No permission mode, ask rule or hook ask may replace this ask. Yolo
       * keeps the prompt; a channel with nobody to ask denies. Set only by
       * checks whose finding is catastrophic — a removal that would take the
       * workspace, the home directory or a system root with it.
       */
      bypassImmune?: boolean;
    }
  | { type: 'other'; reason: string };

/**
 * The host's `TReason`. Travels with `ask` results — where it is the prompt copy
 * — and with denials the host wants attributed.
 */
export interface ToolPermissionReason {
  /** Prompt copy, or the denial text shown to the model. */
  message: string;
  attribution: PermissionAttribution;
  /** Set on denials so summaries need not parse the message. */
  denialKind?: ToolPermissionDenialKind;
  /**
   * Which branch of which check produced this, e.g. `fs_write.rule.deny`. An
   * existing reason taxonomy — the counters group by it.
   */
  decisionPoint?: string;
  /**
   * The path that fell outside the workspace. Present on asks raised purely by
   * the boundary, which is what lets a mode refuse them without prompting.
   */
  blockedPath?: string;
}

/**
 * The host's `TExtra`. A `deny` result has no `reason` slot — the component
 * refuses to carry copy it cannot be sure is host-authored — so a refusal that
 * wants to explain itself rides here instead. An `allow` uses it to report
 * which branch allowed the call.
 */
export interface ToolPermissionExtra {
  /** Per-check classifier route, carried with the result through rechecks. */
  autoClassifier?: AutoModeClassifierDetails;
  /** Host analysis of this invocation only; never derived from model input. */
  acceptEditsEligible?: boolean;
  denialReason?: ToolPermissionReason;
  decisionPoint?: string;
  /**
   * The projection of the input the prompt should render, when showing the raw
   * input would be unsafe. The question tool sets it: a model that pre-fills the
   * answer fields must not have them displayed as though the user had chosen
   * them, and the handler cannot tell the difference by looking at the input.
   */
  promptInput?: Record<string, unknown>;
  /**
   * True for a gap-shaped ask: nobody objected, the prompt exists only
   * because nobody vouched. A recorded tool-level allow fills it; other
   * asks are findings an allow may not erase.
   */
  fillableByAllow?: boolean;
  /**
   * Auto mode must judge this ask with the classifier even when AcceptEdits
   * would cover it. Other modes ignore the flag, so it adds no prompts.
   */
  autoModeReview?: boolean;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** Where a remembered permission change is written. */
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session';

/** 宿主给会话权限的 ask handler：携带宿主的原因、草稿与规则更新词汇。 */
export type HostAskHandler = AskHandler<
  ToolPermissionReason,
  ToolPermissionExtra,
  PermissionUpdate
>;

/**
 * A permission change the prompt can offer — "always allow this command",
 * "trust this directory". The ask handler applies it by writing the host's own
 * settings and calling the module's setters; the module never applies one.
 */
export type PermissionUpdate =
  | {
      type: 'addRules';
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: 'replaceRules';
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: 'removeRules';
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: 'setMode';
      destination: PermissionUpdateDestination;
      mode: PermissionMode;
    }
  | {
      type: 'addDirectories';
      destination: PermissionUpdateDestination;
      directories: string[];
    }
  | {
      type: 'removeDirectories';
      destination: PermissionUpdateDestination;
      directories: string[];
    };

/** Offer to always allow one exact rule value, remembered for this project. */
export function suggestAllow(rule: PermissionRuleValue): PermissionUpdate {
  return {
    type: 'addRules',
    destination: 'localSettings',
    rules: [rule],
    behavior: 'allow',
  };
}

/**
 * What path and shell judgements read: local rules, managed constraints, and
 * directories trusted beyond the cwd. A `Pick` of the component's context so
 * every real context satisfies it and no second vocabulary appears.
 */
export type PathPermissionContext = Pick<
  ToolCheckContext<ToolPermissionReason>,
  'rules' | 'additionalDirectories' | 'internalPaths' | 'toolName'
> & { readonly globalRules?: PermissionPolicySnapshot['rules'] };

/**
 * Offer to always allow reads under `dirPath`. Returns undefined for the
 * filesystem root, which is too broad to be a meaningful grant.
 *
 * Absolute paths get the extra leading slash that marks an absolute pattern:
 * `/repo/docs` becomes `Read(//repo/docs/**)`.
 */
export function createReadRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  if (toPosixPath(dirPath) === '/') {
    return undefined;
  }

  return {
    type: 'addRules',
    destination,
    rules: [
      {
        toolName: READ_FILE_TOOL_NAME,
        ruleContent: directoryPermissionPattern(dirPath),
      },
    ],
    behavior: 'allow',
  };
}
