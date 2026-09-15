/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How big a dynamic workflow should be, and when a running one is
 * big enough to flag.
 *
 * Two surfaces read this, and both have to agree on every number:
 *
 * - the model, which gets a guideline paragraph in the Workflow tool
 *   description (and a reminder when the user changes it mid-session), so it
 *   sizes a fan-out before writing it rather than after the user objects;
 * - the user, who gets a one-per-run "Large workflow" flag when a run
 *   schedules more agents, or projects more output tokens, than expected.
 *
 * The guideline is advisory by design. Nothing here stops a run: the hard caps
 * (agent count, wall clock, token budget) live with the runtime, and a user
 * who asked for an exhaustive sweep should get one.
 */

import { parsePositiveIntegerEnv } from '../../utils/env.js';

export type WorkflowSizeGuideline =
  | 'unrestricted'
  | 'small'
  | 'medium'
  | 'large';

export const WORKFLOW_SIZE_GUIDELINES: readonly WorkflowSizeGuideline[] = [
  'unrestricted',
  'small',
  'medium',
  'large',
];

export const DEFAULT_WORKFLOW_SIZE_GUIDELINE: WorkflowSizeGuideline = 'medium';

/** Agents each guideline aims to stay under. `unrestricted` sends none. */
export const WORKFLOW_SIZE_GUIDELINE_AGENTS: Readonly<
  Record<Exclude<WorkflowSizeGuideline, 'unrestricted'>, number>
> = { small: 5, medium: 15, large: 50 };

/** The settings label the guideline text points the user at. */
export const WORKFLOW_SIZE_GUIDELINE_SETTING_LABEL = 'Dynamic Workflow Size';

/** Env override for the agent threshold of the large-run warning. */
export const WORKFLOW_SIZE_WARNING_AGENTS_ENV =
  'QWEN_CODE_WORKFLOW_SIZE_WARNING_AGENTS';
/** Env override for the output-token threshold of the large-run warning. */
export const WORKFLOW_SIZE_WARNING_TOKENS_ENV =
  'QWEN_CODE_WORKFLOW_SIZE_WARNING_TOKENS';

/** Agent threshold when the guideline is `unrestricted` and no env is set. */
export const DEFAULT_WORKFLOW_SIZE_WARNING_AGENTS = 25;
/** Output-token threshold when no env is set. */
export const DEFAULT_WORKFLOW_SIZE_WARNING_TOKENS = 1_500_000;
/**
 * Output tokens assumed per agent before any agent has settled, so a fan-out
 * that queues everything up front can be flagged before it has spent much.
 * Replaced by the run's own average as soon as one agent settles.
 */
export const WORKFLOW_SIZE_TOKENS_PER_AGENT_ASSUMPTION = 70_000;

/** The guideline in effect, and whether the user chose it. */
export interface WorkflowSizeGuidelineSetting {
  readonly size: WorkflowSizeGuideline;
  /** True when nothing was configured and the default applies. */
  readonly isDefault: boolean;
}

export function isWorkflowSizeGuideline(
  value: unknown,
): value is WorkflowSizeGuideline {
  return (
    typeof value === 'string' &&
    (WORKFLOW_SIZE_GUIDELINES as readonly string[]).includes(value)
  );
}

/**
 * The guideline for a raw settings value. An unset or unrecognised value is
 * the default — a typo in a settings file must not silently drop the guideline.
 */
export function resolveWorkflowSizeGuidelineSetting(
  raw: unknown,
): WorkflowSizeGuidelineSetting {
  return isWorkflowSizeGuideline(raw)
    ? { size: raw, isDefault: false }
    : { size: DEFAULT_WORKFLOW_SIZE_GUIDELINE, isDefault: true };
}

function guidelineSentence(
  size: Exclude<WorkflowSizeGuideline, 'unrestricted'>,
): string {
  return (
    `${size} — keep workflows under ${WORKFLOW_SIZE_GUIDELINE_AGENTS[size]} agents. ` +
    "This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale."
  );
}

/**
 * The paragraph appended to the Workflow tool description, or `null` when the
 * guideline is `unrestricted`. The default version also tells the model where
 * the user can change it, so a model asked "why only 15 agents?" can answer.
 */
export function buildWorkflowSizeGuidelineParagraph(
  setting: WorkflowSizeGuidelineSetting,
): string | null {
  if (setting.size === 'unrestricted') return null;
  if (setting.isDefault) {
    return (
      `This session has the default workflow size guideline: ${guidelineSentence(setting.size)} ` +
      `The user can raise or remove it with "${WORKFLOW_SIZE_GUIDELINE_SETTING_LABEL}" in /settings.`
    );
  }
  return `A workflow size guideline is configured for this session: ${guidelineSentence(setting.size)}`;
}

/**
 * The reminder sent when the user changes the guideline mid-session. The tool
 * description was built at startup and still states the old value, so the
 * reminder has to say that it replaces it.
 */
export function buildWorkflowSizeGuidelineChangeNotice(
  next: WorkflowSizeGuidelineSetting,
): string {
  if (next.size === 'unrestricted') {
    return 'Workflow size is now unrestricted — no size guideline applies, whatever the Workflow tool description says.';
  }
  return (
    `The workflow size guideline for this session changed: ${guidelineSentence(next.size)} ` +
    'It replaces the guideline stated in the Workflow tool description.'
  );
}

/** The thresholds a run is checked against. Resolved once per run. */
export interface WorkflowSizeCaps {
  readonly agentCap: number;
  readonly tokenCap: number;
  /** True when `agentCap` came from the guideline rather than env or default. */
  readonly capFromGuideline: boolean;
}

export function resolveWorkflowSizeCaps(
  setting: WorkflowSizeGuidelineSetting,
  env: Record<string, string | undefined> = process.env,
): WorkflowSizeCaps {
  const envAgents = parsePositiveIntegerEnv(
    env[WORKFLOW_SIZE_WARNING_AGENTS_ENV],
    0,
  );
  const envTokens = parsePositiveIntegerEnv(
    env[WORKFLOW_SIZE_WARNING_TOKENS_ENV],
    0,
  );
  const guidelineAgents =
    setting.size === 'unrestricted'
      ? undefined
      : WORKFLOW_SIZE_GUIDELINE_AGENTS[setting.size];
  const agentCap =
    envAgents > 0
      ? envAgents
      : (guidelineAgents ?? DEFAULT_WORKFLOW_SIZE_WARNING_AGENTS);
  return {
    agentCap,
    tokenCap: envTokens > 0 ? envTokens : DEFAULT_WORKFLOW_SIZE_WARNING_TOKENS,
    capFromGuideline: envAgents <= 0 && guidelineAgents !== undefined,
  };
}

/** Recorded on the run the first time it crosses a threshold. */
export interface WorkflowSizeWarning {
  readonly axis: 'agents' | 'tokens';
  /** Dispatches issued by the run that were not replayed from the journal. */
  readonly scheduledAgents: number;
  /** Output tokens this run's agents had spent when the warning fired. */
  readonly totalTokens: number;
  /** `max(totalTokens, per-agent average × scheduledAgents)`. */
  readonly projectedTokens: number;
  readonly agentCap: number;
  readonly tokenCap: number;
  readonly capFromGuideline: boolean;
  readonly at: number;
}

export interface WorkflowSizeSample {
  /** Dispatches issued so far, excluding journal replays. */
  readonly scheduledAgents: number;
  /** Live dispatches that have settled (completed, failed or cancelled). */
  readonly settledAgents: number;
  /** Output tokens this run's agents have spent. */
  readonly tokensSpent: number;
}

/**
 * The warning for a run in this state, or `null` while it is within bounds.
 * The agent axis wins when both are crossed: "N agents" is the number the user
 * can act on from the prompt.
 */
export function evaluateWorkflowSize(
  sample: WorkflowSizeSample,
  caps: WorkflowSizeCaps,
  at: number = Date.now(),
): WorkflowSizeWarning | null {
  const perAgent =
    sample.settledAgents > 0
      ? sample.tokensSpent / sample.settledAgents
      : WORKFLOW_SIZE_TOKENS_PER_AGENT_ASSUMPTION;
  const projectedTokens = Math.max(
    sample.tokensSpent,
    Math.round(perAgent * sample.scheduledAgents),
  );
  let axis: WorkflowSizeWarning['axis'];
  if (sample.scheduledAgents > caps.agentCap) {
    axis = 'agents';
  } else if (
    sample.tokensSpent > caps.tokenCap ||
    projectedTokens > caps.tokenCap
  ) {
    axis = 'tokens';
  } else {
    return null;
  }
  return {
    axis,
    scheduledAgents: sample.scheduledAgents,
    totalTokens: sample.tokensSpent,
    projectedTokens,
    agentCap: caps.agentCap,
    tokenCap: caps.tokenCap,
    capFromGuideline: caps.capFromGuideline,
    at,
  };
}

/** The run-log line recorded with the warning. */
export function formatWorkflowSizeWarningLog(
  warning: WorkflowSizeWarning,
): string {
  const number = (value: number) => value.toLocaleString('en-US');
  if (warning.axis === 'agents') {
    const source = warning.capFromGuideline ? ', from the size guideline' : '';
    return (
      `[size] Large workflow: ${number(warning.scheduledAgents)} agents scheduled ` +
      `(warning threshold ${number(warning.agentCap)}${source}) — /workflows to stop.`
    );
  }
  return (
    `[size] Large workflow: ~${number(warning.projectedTokens)} output tokens projected ` +
    `(warning threshold ${number(warning.tokenCap)}) — /workflows to stop.`
  );
}

/** Shape check for a warning read back from a persisted snapshot. */
export function isWorkflowSizeWarning(
  value: unknown,
): value is WorkflowSizeWarning {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const finite = (key: string) =>
    typeof v[key] === 'number' && Number.isFinite(v[key]);
  return (
    (v['axis'] === 'agents' || v['axis'] === 'tokens') &&
    finite('scheduledAgents') &&
    finite('totalTokens') &&
    finite('projectedTokens') &&
    finite('agentCap') &&
    finite('tokenCap') &&
    typeof v['capFromGuideline'] === 'boolean' &&
    finite('at')
  );
}
