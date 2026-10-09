/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { stripAnsiAndControl } from '../utils/textUtils.js';
import {
  AUTOMATION_RUN_KIND,
  SCHEDULE_CATCH_UP_POLICIES,
  SCHEDULE_KIND,
  SCHEDULE_OVERLAP_POLICIES,
  SCHEDULE_SESSION_MODES,
  parseAutomationRunRecord,
  parseScheduleRecord,
  type AutomationRun,
  type Schedule,
  type ScheduleCatchUpPolicy,
  type ScheduleOverlapPolicy,
  type ScheduleSessionMode,
} from './managed-automation-record.js';
import type { ExtensionRun } from './managed-extension-record.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

// H6b/H6c of #12827: the pure construction side of the automation runtime
// — the identities the control plane and the Harness derive alike, the
// definition digest, the input envelope, the turn text, and every revision
// body the automation funnel commits. Writers go through the verb funnel
// (packages/cli/src/serve/hosted-automation-session.ts), which serializes
// these builders onto `commitExtensionRecord`. See
// docs/design/2026-10-07-managed-automation-runtime.md.

export const MANAGED_AUTOMATION_LIMITS = Object.freeze({
  /** The raw prompt bound; the real budget is the final input's. */
  maxPromptBytes: 64 * 1024,
  /** The largest instant `Date` can render; `firedAt` beyond it unwedges no run. */
  maxFiredAtMs: 8_640_000_000_000_000,
  /**
   * The bound of the wrapped execution input, matching the inline
   * resource bound of the hosted Session store (`http-managed-session-store.ts`'s
   * `maxInlineResourceBytes`). A definition whose worst-case input envelope
   * exceeds it fires into an unpublishable resource and strands the run, so
   * it is refused at admission instead.
   */
  maxInputBytes: 64 * 1024,
  maxGoalBytes: 4096,
  /**
   * The declared cron bound the control plane's mirror column carries
   * (V56 `cron VARCHAR(400)`) and the public contract publishes
   * (`maxLength: 400`): a longer cron would commit a definition the
   * mirror can never hold, so it is refused at admission.
   */
  maxCronBytes: 400,
  maxDefinitionsPerSession: 32,
} as const);

/** The `source` of every automation input, as the wake scheduler admits it. */
export const AUTOMATION_INPUT_SOURCE = 'automation';

export const AUTOMATION_RESOURCE_KINDS = Object.freeze({
  prompt: 'managed-automation-prompt',
  input: 'managed-input',
} as const);

export const AUTOMATION_RUN_TRIGGERS = Object.freeze([
  'scheduled',
  'manual',
  'catch_up',
] as const);
export type AutomationRunTrigger = (typeof AUTOMATION_RUN_TRIGGERS)[number];

/** Model-facing control sentence, the Legacy scheduled-run wording. */
export const AUTOMATION_RUN_INSTRUCTION =
  'This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.';

const SEPARATOR = '\u0000';
const RUN_ID_PREFIX = 'arun_';
const INPUT_SUFFIX = ':input';

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function sha256(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.join(SEPARATOR), 'utf8')
    .digest('hex');
}

function assertNoSeparator(value: string, label: string): string {
  if (value.length === 0 || value.includes(SEPARATOR)) {
    fail(`${label} must be non-empty and hold no NUL.`);
  }
  return value;
}

/**
 * The run identity of one occurrence of one definition: derived, so two
 * claimants collide on the record key (decision 2). The Java scanner
 * derives the same value (`ManagedAutomationService.automationRunId`).
 */
export function automationRunId(
  scheduleId: string,
  occurrenceKey: string,
): string {
  return `${RUN_ID_PREFIX}${sha256([
    assertNoSeparator(scheduleId, 'scheduleId'),
    assertNoSeparator(occurrenceKey, 'occurrenceKey'),
  ])}`;
}

/** The input (and turn) of a run: one per run, derived from its id. */
export function automationInputId(runId: string): string {
  return `${runId}${INPUT_SUFFIX}`;
}

/** The run an automation input belongs to, or undefined for other inputs. */
export function automationRunIdOfInput(inputId: string): string | undefined {
  return inputId.startsWith(RUN_ID_PREFIX) && inputId.endsWith(INPUT_SUFFIX)
    ? inputId.slice(0, -INPUT_SUFFIX.length)
    : undefined;
}

/** The definition fields a request carries, before they are pinned. */
export interface AutomationDefinition {
  readonly goal: string;
  readonly cron: string;
  readonly timezone: string;
  readonly prompt: string;
  readonly sessionMode: ScheduleSessionMode;
  readonly overlap: ScheduleOverlapPolicy;
  readonly catchUp: ScheduleCatchUpPolicy;
  readonly catchUpLimit: number | null;
  readonly enabled: boolean;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/**
 * A definition as a request carries it. Every contract rule (cron grammar,
 * timezone shape, goal bound, the catch-up limit pairing) is applied by
 * building the record body it would pin and parsing it; the prompt bound is
 * this module's own.
 */
export function assertAutomationDefinition(
  value: unknown,
  defaults: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  const record = plainObject(value, 'Automation definition');
  const known = [
    'goal',
    'cron',
    'timezone',
    'prompt',
    'sessionMode',
    'overlap',
    'catchUp',
    'catchUpLimit',
    'enabled',
  ];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      fail(`Automation definition has an unknown field ${key}.`);
    }
  }
  const prompt = record['prompt'] ?? defaults.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    fail('Automation definition prompt must be non-empty text.');
  }
  const goal = record['goal'] ?? defaults.goal;
  if (typeof goal !== 'string') {
    fail('Automation definition goal must be non-empty text.');
  }
  if (
    Buffer.byteLength(prompt, 'utf8') > MANAGED_AUTOMATION_LIMITS.maxPromptBytes
  ) {
    fail(
      `Automation definition prompt exceeds ${MANAGED_AUTOMATION_LIMITS.maxPromptBytes} UTF-8 bytes.`,
    );
  }
  const catchUp = oneOf(
    record['catchUp'] ?? defaults.catchUp ?? 'none',
    SCHEDULE_CATCH_UP_POLICIES,
    'Automation definition catchUp',
  );
  const definition: AutomationDefinition = {
    goal,
    cron: (record['cron'] ?? defaults.cron) as string,
    timezone: (record['timezone'] ?? defaults.timezone) as string,
    prompt,
    sessionMode: oneOf(
      record['sessionMode'] ?? defaults.sessionMode ?? 'persistent',
      SCHEDULE_SESSION_MODES,
      'Automation definition sessionMode',
    ),
    overlap: oneOf(
      record['overlap'] ?? defaults.overlap ?? 'skip',
      SCHEDULE_OVERLAP_POLICIES,
      'Automation definition overlap',
    ),
    catchUp,
    // A named limit (even null) is taken as given; an unnamed one follows
    // the policy: kept while catch-up stays bounded, cleared otherwise, so
    // a revision back to none or latest needs no explicit null.
    catchUpLimit: ('catchUpLimit' in record
      ? record['catchUpLimit']
      : catchUp === 'bounded'
        ? (defaults.catchUpLimit ?? null)
        : null) as number | null,
    enabled: (record['enabled'] ?? defaults.enabled ?? true) as boolean,
  };
  if (
    Buffer.byteLength(definition.goal, 'utf8') >
    MANAGED_AUTOMATION_LIMITS.maxGoalBytes
  ) {
    fail(
      `Automation definition goal exceeds ${MANAGED_AUTOMATION_LIMITS.maxGoalBytes} UTF-8 bytes.`,
    );
  }
  if (
    typeof definition.cron === 'string' &&
    Buffer.byteLength(definition.cron, 'utf8') >
      MANAGED_AUTOMATION_LIMITS.maxCronBytes
  ) {
    fail(
      `Automation definition cron exceeds ${MANAGED_AUTOMATION_LIMITS.maxCronBytes} UTF-8 bytes.`,
    );
  }
  // The contract validators decide the rest; a placeholder prompt
  // reference and identity make a body that only the definition can fail.
  parseScheduleRecord(
    scheduleOpenBody({
      scheduleId: 'asch_probe',
      ownerScopeId: 'probe',
      targetSessionId: 'probe',
      definition,
      promptRef: PROBE_REF,
      definitionDigest: '0'.repeat(64),
    }),
  );
  if (
    automationInputBudgetBytes(definition) >
    MANAGED_AUTOMATION_LIMITS.maxInputBytes
  ) {
    fail(
      `Automation definition's final execution input would exceed ${MANAGED_AUTOMATION_LIMITS.maxInputBytes} bytes once wrapped; shorten the prompt.`,
    );
  }
  return Object.freeze(definition);
}

const PROBE_REF: ManagedSessionDurableRef = Object.freeze({
  resourceId: 'probe',
  kind: AUTOMATION_RESOURCE_KINDS.prompt,
  schemaVersion: 1,
  byteLength: 1,
  digest: '0'.repeat(64),
});

/**
 * The digest of a definition's content at a revision: the pinned fields
 * and the prompt's bytes, in one fixed key order. An unchanged definition
 * resubmitted under a new key digests the same, so it appends nothing.
 */
export function automationDefinitionDigest(
  definition: AutomationDefinition,
): string {
  const promptDigest = createHash('sha256')
    .update(definition.prompt, 'utf8')
    .digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify([
        definition.goal,
        definition.cron,
        definition.timezone,
        promptDigest,
        definition.sessionMode,
        definition.overlap,
        definition.catchUp,
        definition.catchUpLimit,
        definition.enabled,
      ]),
      'utf8',
    )
    .digest('hex');
}

function logicalRun(state: ExtensionRun['state']): ExtensionRun {
  return Object.freeze({
    state,
    reason: null,
    definition: null,
    executionCallId: null,
    effectId: null,
    dispatchId: null,
    deliveryId: null,
    execution: null,
    runtime: null,
    delivery: null,
  });
}

function scheduleFields(
  definition: AutomationDefinition,
  promptRef: ManagedSessionDurableRef,
  definitionDigest: string,
) {
  return {
    goal: definition.goal,
    cron: definition.cron,
    timezone: definition.timezone,
    definitionDigest,
    promptRef,
    sessionMode: definition.sessionMode,
    overlap: definition.overlap,
    catchUp: definition.catchUp,
    catchUpLimit: definition.catchUpLimit,
    enabled: definition.enabled,
  };
}

/** Revision 1 of a definition: its logical run opens `admitted`. */
export function scheduleOpenBody(params: {
  readonly scheduleId: string;
  readonly ownerScopeId: string;
  readonly targetSessionId: string;
  readonly definition: AutomationDefinition;
  readonly promptRef: ManagedSessionDurableRef;
  readonly definitionDigest: string;
}): Schedule {
  return Object.freeze({
    kind: SCHEDULE_KIND,
    scheduleId: params.scheduleId,
    ownerScopeId: params.ownerScopeId,
    ...scheduleFields(
      params.definition,
      params.promptRef,
      params.definitionDigest,
    ),
    definitionRevision: 1,
    targetSessionId:
      params.definition.sessionMode === 'persistent'
        ? params.targetSessionId
        : null,
    run: logicalRun('admitted'),
  });
}

/** The next definition revision; the run stays where it is. */
export function scheduleRevisionBody(
  previous: Schedule,
  params: {
    readonly definition: AutomationDefinition;
    readonly promptRef: ManagedSessionDurableRef;
    readonly definitionDigest: string;
  },
): Schedule {
  if (params.definition.sessionMode !== previous.sessionMode) {
    fail(
      `Schedule ${previous.scheduleId} cannot change its target mode after it opened.`,
    );
  }
  return Object.freeze({
    ...previous,
    ...scheduleFields(
      params.definition,
      params.promptRef,
      params.definitionDigest,
    ),
    definitionRevision: previous.definitionRevision + 1,
  });
}

/** The terminal revision: the chain ends `cancelled` and freezes. */
export function scheduleRetireBody(previous: Schedule): Schedule {
  return Object.freeze({
    ...previous,
    definitionRevision: previous.definitionRevision + 1,
    enabled: false,
    run: logicalRun('cancelled'),
  });
}

/**
 * Revision 1 of a run: the claim. Its id is the derivation of its own
 * identity, its dispatch is named from the start, nothing is dispatched.
 */
export function automationRunClaimBody(params: {
  readonly schedule: Schedule;
  readonly occurrenceKey: string;
}): AutomationRun {
  const runId = automationRunId(
    params.schedule.scheduleId,
    params.occurrenceKey,
  );
  // The intent names the effect it will have — the one input of this run,
  // derived from the same identity — so the H0b rule that an execution
  // names a call or an effect holds from the claim on.
  return parseAutomationRunRecord({
    kind: AUTOMATION_RUN_KIND,
    automationRunId: runId,
    scheduleId: params.schedule.scheduleId,
    definitionRevision: params.schedule.definitionRevision,
    occurrenceKey: params.occurrenceKey,
    sessionMode: params.schedule.sessionMode,
    targetSessionId: params.schedule.targetSessionId,
    run: {
      state: 'admitted',
      reason: null,
      definition: null,
      executionCallId: null,
      effectId: automationInputId(runId),
      dispatchId: runId,
      deliveryId: null,
      execution: 'intent',
      runtime: null,
      delivery: null,
    },
  });
}

/** Revision 2: the input is admitted, so the dispatch started. */
export function automationRunDispatchBody(
  previous: AutomationRun,
): AutomationRun {
  return Object.freeze({
    ...previous,
    run: Object.freeze({
      ...previous.run,
      state: 'running' as const,
      execution: 'dispatch_started' as const,
    }),
  });
}

/**
 * The terminal revision of a run the Harness stopped inside its turn:
 * whether any execution happened is unknowable from the journal, so the
 * execution ends `outcome_unknown` rather than guessed either way.
 */
export function automationRunFailedUnknownBody(
  previous: AutomationRun,
): AutomationRun {
  return Object.freeze({
    ...previous,
    run: Object.freeze({
      ...previous.run,
      state: 'failed' as const,
      execution: 'outcome_unknown' as const,
    }),
  });
}

export type AutomationRunOutcome = 'settled' | 'failed' | 'cancelled';

/**
 * The terminal revision. A turn that ran ended the execution; an input
 * settled model-free never started one.
 */
export function automationRunSettleBody(
  previous: AutomationRun,
  outcome: AutomationRunOutcome,
  started: boolean,
): AutomationRun {
  if (outcome === 'settled' && !started) {
    fail('An automation run cannot settle an execution that never started.');
  }
  return Object.freeze({
    ...previous,
    run: Object.freeze({
      ...previous.run,
      state: outcome,
      execution: started
        ? ('settled' as const)
        : ('not_started_proven' as const),
    }),
  });
}

/** The `contentRef` body of an automation input. */
export interface AutomationInputEnvelope {
  readonly automationRunId: string;
  readonly scheduleId: string;
  readonly definitionRevision: number;
  readonly occurrenceKey: string;
  readonly trigger: AutomationRunTrigger;
  /** Epoch ms when the scanner fired the occurrence. */
  readonly firedAt: number;
  /** The turn's text, so the wake pump reads it like any notification. */
  readonly text: string;
}

export function encodeAutomationInputEnvelope(
  envelope: AutomationInputEnvelope,
): Buffer {
  return Buffer.from(JSON.stringify(envelope), 'utf8');
}

export function decodeAutomationInputEnvelope(
  bytes: Buffer,
): AutomationInputEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('Automation input envelope must be JSON.');
  }
  const record = plainObject(parsed, 'Automation input envelope');
  const text = (label: string): string => {
    const value = record[label];
    if (typeof value !== 'string' || value.length === 0) {
      fail(`Automation input envelope ${label} must be text.`);
    }
    return value;
  };
  const count = (label: string): number => {
    const value = record[label];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      fail(`Automation input envelope ${label} must be a count.`);
    }
    return value as number;
  };
  return Object.freeze({
    automationRunId: text('automationRunId'),
    scheduleId: text('scheduleId'),
    definitionRevision: count('definitionRevision'),
    occurrenceKey: text('occurrenceKey'),
    trigger: oneOf(
      record['trigger'],
      AUTOMATION_RUN_TRIGGERS,
      'Automation input envelope trigger',
    ),
    firedAt: count('firedAt'),
    text: text('text'),
  });
}

// The Legacy run framing strips terminal control and bidi override marks
// from the metadata lines, so a goal cannot restyle or reorder the frame.
const BIDI_MARKS = /[؜‎‏‪-‮⁦-⁩]/g;

function cleanLine(value: string): string {
  return stripAnsiAndControl(value)
    .replace(BIDI_MARKS, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The text an automation turn runs: the Legacy run framing plus the prompt. */
export function automationTurnText(params: {
  readonly schedule: Pick<
    Schedule,
    'scheduleId' | 'goal' | 'cron' | 'timezone'
  >;
  readonly occurrenceKey: string;
  readonly trigger: AutomationRunTrigger;
  readonly firedAt: number;
  readonly prompt: string;
}): string {
  if (
    !Number.isSafeInteger(params.firedAt) ||
    params.firedAt < 0 ||
    params.firedAt > MANAGED_AUTOMATION_LIMITS.maxFiredAtMs
  ) {
    fail(
      `Automation run firedAt must be an epoch instant between 0 and ${MANAGED_AUTOMATION_LIMITS.maxFiredAtMs}.`,
    );
  }
  return [
    `Scheduled automation: ${cleanLine(params.schedule.goal) || params.schedule.scheduleId}`,
    `Automation ID: ${params.schedule.scheduleId}`,
    `Schedule: ${cleanLine(params.schedule.cron)} (${cleanLine(params.schedule.timezone)})`,
    `Occurrence: ${params.occurrenceKey}`,
    `Triggered at: ${new Date(params.firedAt).toISOString()}`,
    `Trigger: ${params.trigger}`,
    '',
    AUTOMATION_RUN_INSTRUCTION,
    '',
    params.prompt,
  ].join('\n');
}

/**
 * The byte size of the largest execution input this definition could
 * produce: the real turn text under the largest identity fields the
 * operations route admits (identity ids and number fields are longest
 * here; an occurrence key is at most 512 chars, each of which may JSON-escape
 * to six). Admission compares it against
 * {@link MANAGED_AUTOMATION_LIMITS.maxInputBytes}, so a definition never
 * commits whose `fire` could not publish the input.
 */
export function automationInputBudgetBytes(
  definition: Pick<
    AutomationDefinition,
    'goal' | 'cron' | 'timezone' | 'prompt'
  >,
): number {
  const scheduleId = `asch_${'0'.repeat(32)}`;
  // The latest representable instant, whose ISO text is longest.
  const firedAt = MANAGED_AUTOMATION_LIMITS.maxFiredAtMs;
  // Escapes maximally under JSON: control chars cost six bytes each.
  const occurrenceKey = '\u0001'.repeat(512);
  return encodeAutomationInputEnvelope({
    automationRunId: `arun_${'0'.repeat(64)}`,
    scheduleId,
    definitionRevision: Number.MAX_SAFE_INTEGER,
    occurrenceKey,
    trigger: 'scheduled',
    firedAt,
    text: automationTurnText({
      schedule: {
        scheduleId,
        goal: definition.goal,
        cron: definition.cron,
        timezone: definition.timezone,
      },
      occurrenceKey,
      trigger: 'scheduled',
      firedAt,
      prompt: definition.prompt,
    }),
  }).byteLength;
}
