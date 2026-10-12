/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ChildAgentRun,
  type ChildAgentStopReason,
  type ChildCompletion,
  type ChildSessionRun,
  type ChildWorkspaceMode,
} from './managed-child-run-record.js';
import type { ChildAcceptance } from './managed-child-acceptance-record.js';
import type { DefinitionPin } from './managed-extension-record.js';
import {
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';

// H4b of #12827: the pure construction side of the six child operations —
// every revision body the child Session runtime commits, plus the launch
// admission bounds and the idempotency identities the control plane's relay
// derives from them. Writers go through the verb funnel
// (packages/cli/src/serve/hosted-child-agent-session.ts), which serializes
// these builders onto `commitExtensionRecord`; the Java store replays the
// same bodies for its own checks. See
// docs/design/2026-10-07-managed-child-session-runtime.md.

/** The launch admission and copy bounds of the first runtime slice. */
export const MANAGED_CHILD_LIMITS = Object.freeze({
  /** The contract cap is 8; the first runtime slice admits depth 1 only. */
  maxDepth: 1,
  maxActivePerScope: 4,
  /**
   * The launches one owner scope may make over the Session's lifetime
   * (H4c): every committed child Session run counts, ended or not, since
   * each one cost a creation attempt and grows the journal its rebuild
   * replays.
   */
  maxLaunchesPerScope: 64,
  maxEnvelopeBytes: 32 * 1024,
  maxDescriptionBytes: 512,
  // The result copy is pinned to the parent Session's durable inline
  // bound, never wider: a copy the resource store cannot inline takes the
  // relay's quota refusal with its proven classification instead of a
  // deterministic publish failure on every retry.
  maxResultBytes: 64 * 1024,
} as const);

/**
 * The workspace isolation policies a launch may name. `worktree` (#13753
 * I2) also needs a host that serves child Workspaces; `snapshot` waits for
 * I3.
 */
export const MANAGED_CHILD_ADMITTED_WORKSPACE_MODES: readonly ChildWorkspaceMode[] =
  Object.freeze(['shared', 'worktree']);

export interface ChildLaunchEnvelope {
  readonly description: string;
  readonly prompt: string;
  readonly definition: DefinitionPin;
}

/**
 * The `inputRef` content: the launch input a child Session's first turn
 * receives, bounded JSON. Defined at commit time and immutable for the
 * whole chain, so the bytes here are the chain's only launch evidence.
 */
export function encodeChildLaunchEnvelope(
  envelope: ChildLaunchEnvelope,
): Buffer {
  if (
    Buffer.byteLength(envelope.description, 'utf8') >
    MANAGED_CHILD_LIMITS.maxDescriptionBytes
  ) {
    throw new ManagedSessionRecordError(
      `Child launch description exceeds ${MANAGED_CHILD_LIMITS.maxDescriptionBytes} bytes (byte_limit).`,
    );
  }
  const bytes = Buffer.from(
    JSON.stringify({
      description: envelope.description,
      prompt: envelope.prompt,
      definition: envelope.definition,
    }),
    'utf8',
  );
  if (bytes.byteLength > MANAGED_CHILD_LIMITS.maxEnvelopeBytes) {
    throw new ManagedSessionRecordError(
      `Child launch envelope exceeds ${MANAGED_CHILD_LIMITS.maxEnvelopeBytes} bytes (byte_limit).`,
    );
  }
  return bytes;
}

/** Decodes one launch envelope, as the child Session's creation reads it. */
export function decodeChildLaunchEnvelope(bytes: Buffer): ChildLaunchEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ManagedSessionRecordError('Child launch envelope must be JSON.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ManagedSessionRecordError(
      'Child launch envelope must be a JSON object.',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'definition,description,prompt') {
    throw new ManagedSessionRecordError(
      'Child launch envelope must have exactly description, prompt and definition.',
    );
  }
  if (
    typeof record['description'] !== 'string' ||
    typeof record['prompt'] !== 'string'
  ) {
    throw new ManagedSessionRecordError(
      'Child launch description and prompt must be text.',
    );
  }
  const definition = record['definition'];
  if (
    typeof definition !== 'object' ||
    definition === null ||
    typeof (definition as Record<string, unknown>)['definitionId'] !==
      'string' ||
    typeof (definition as Record<string, unknown>)['definitionRevision'] !==
      'number' ||
    typeof (definition as Record<string, unknown>)['definitionDigest'] !==
      'string'
  ) {
    throw new ManagedSessionRecordError(
      'Child launch definition must pin an id, a revision and a digest.',
    );
  }
  return Object.freeze({
    description: record['description'],
    prompt: record['prompt'],
    definition: Object.freeze({ ...(definition as DefinitionPin) }),
  });
}

/** The reason a launch admission refuses, in the H0b quota vocabulary. */
export type ChildAdmissionRefusal =
  | 'closing'
  | 'depth_limit'
  | 'count_limit'
  | 'budget_exhausted'
  | 'byte_limit'
  | 'workspace_mode'
  | 'definition_scope';

/** What a launch admission answers: the refusal, or the admitted inputs. */
export type ChildAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: ChildAdmissionRefusal };

/** The launch checks that run before any record commits. */
export function admitChildLaunch(params: {
  readonly closing: boolean;
  readonly depth: number;
  readonly activeInScope: number;
  /** Every child Session run this scope ever committed, ended or not. */
  readonly launchedInScope: number;
  readonly envelopeBytes: number;
  readonly workspaceMode: ChildWorkspaceMode;
  /** The control plane serves child Workspaces, so `worktree` can run. */
  readonly childWorkspaces: boolean;
  readonly sameDefinition: boolean;
}): ChildAdmission {
  if (params.closing) return { admitted: false, reason: 'closing' };
  if (
    !MANAGED_CHILD_ADMITTED_WORKSPACE_MODES.includes(params.workspaceMode) ||
    (params.workspaceMode === 'worktree' && !params.childWorkspaces)
  ) {
    return { admitted: false, reason: 'workspace_mode' };
  }
  if (!params.sameDefinition) {
    return { admitted: false, reason: 'definition_scope' };
  }
  if (params.depth > MANAGED_CHILD_LIMITS.maxDepth) {
    return { admitted: false, reason: 'depth_limit' };
  }
  // The spent budget never recovers, so it is reported ahead of the
  // concurrency cap, which a later launch may find cleared.
  if (params.launchedInScope >= MANAGED_CHILD_LIMITS.maxLaunchesPerScope) {
    return { admitted: false, reason: 'budget_exhausted' };
  }
  if (params.activeInScope >= MANAGED_CHILD_LIMITS.maxActivePerScope) {
    return { admitted: false, reason: 'count_limit' };
  }
  if (params.envelopeBytes > MANAGED_CHILD_LIMITS.maxEnvelopeBytes) {
    return { admitted: false, reason: 'byte_limit' };
  }
  return { admitted: true };
}

export interface ChildRunBinding {
  readonly runtimeBindingId: string;
  /** Decimal text, so a 64-bit value never passes through Number. */
  readonly generation: string;
}

/** Revision 1 (`startChildRun`): the launch intent before any side effect. */
export function childLaunchBody(params: {
  readonly childRunId: string;
  readonly ownerScopeId: string;
  readonly rootSessionId: string;
  readonly completion: ChildCompletion;
  readonly inputRef: ManagedSessionDurableRef;
  readonly workspaceMode: ChildWorkspaceMode;
  readonly workingDirectory: string;
  readonly executionCallId: string;
  readonly definition: DefinitionPin;
}): ChildAgentRun {
  return Object.freeze({
    kind: 'child_agent',
    childRunId: params.childRunId,
    ownerScopeId: params.ownerScopeId,
    rootSessionId: params.rootSessionId,
    depth: 1,
    completion: params.completion,
    inputRef: params.inputRef,
    workspaceMode: params.workspaceMode,
    workingDirectory: params.workingDirectory,
    childSessionId: null,
    predecessorChildRunId: null,
    resultVersion: 1,
    resultRef: null,
    terminalReceiptRef: null,
    stopReason: null,
    stopRequested: false,
    run: Object.freeze({
      state: 'admitted',
      reason: null,
      definition: Object.freeze({ ...params.definition }),
      executionCallId: params.executionCallId,
      effectId: null,
      dispatchId: null,
      deliveryId: null,
      execution: 'intent',
      runtime: null,
      delivery: Object.freeze({ target: 'session', state: 'planned' }),
    }),
  });
}

/**
 * `continueChildRun` (H4d): the launch intent of a new run that continues a
 * completed one. It keeps the predecessor's kind, scope, tree, workspace and
 * definition — the commit-time rules refuse anything else — and carries its
 * own launch input, the continuation's first prompt. A completed predecessor
 * was dispatched, so it carries its definition pin. The producer still owes
 * the launch admission (closing, quotas) before it commits.
 */
export function childContinuationBody(
  predecessor: ChildSessionRun,
  params: {
    readonly childRunId: string;
    readonly completion: ChildCompletion;
    readonly inputRef: ManagedSessionDurableRef;
    readonly executionCallId: string;
  },
): ChildSessionRun {
  const launch = childLaunchBody({
    childRunId: params.childRunId,
    ownerScopeId: predecessor.ownerScopeId,
    rootSessionId: predecessor.rootSessionId,
    completion: params.completion,
    inputRef: params.inputRef,
    workspaceMode: predecessor.workspaceMode,
    workingDirectory: predecessor.workingDirectory,
    executionCallId: params.executionCallId,
    definition: predecessor.run.definition!,
  });
  return Object.freeze({
    ...launch,
    kind: predecessor.kind,
    depth: predecessor.depth,
    predecessorChildRunId: predecessor.childRunId,
  });
}

/** Revision 2: the control plane admitted the idempotent creation. */
export function childDispatchBody(
  previous: ChildAgentRun,
  params: { readonly dispatchId: string; readonly runtime: ChildRunBinding },
): ChildAgentRun {
  return Object.freeze({
    ...previous,
    run: Object.freeze({
      ...previous.run,
      state: 'running',
      dispatchId: params.dispatchId,
      execution: 'dispatch_started',
      runtime: Object.freeze({ ...params.runtime }),
    }),
  });
}

/** Revision 3: the child Session's Harness is confirmed live. */
export function childAttachBody(
  previous: ChildAgentRun,
  params: { readonly childSessionId: string },
): ChildAgentRun {
  return Object.freeze({
    ...previous,
    childSessionId: params.childSessionId,
    run: Object.freeze({
      ...previous.run,
      execution: 'running_attached',
    }),
  });
}

/** `commitChildResult`: the unique logical terminal result, with the
 * parent-held copies and the delivery handed to accepting in one step. */
export function childSettleCompletedBody(
  previous: ChildAgentRun,
  params: {
    readonly resultRef: ManagedSessionDurableRef;
    readonly terminalReceiptRef: ManagedSessionDurableRef;
  },
): ChildAgentRun {
  return Object.freeze({
    ...previous,
    stopReason: 'completed',
    resultRef: params.resultRef,
    terminalReceiptRef: params.terminalReceiptRef,
    run: Object.freeze({
      ...previous.run,
      state: 'settled',
      execution: 'settled',
      delivery: Object.freeze({ target: 'session', state: 'accepting' }),
    }),
  });
}

/** Whether a settlement's naming of the minted Session is replay-safe:
 * the same id restates, a different one conflicts, never overwrites. */
function adoptChildSessionId(
  previous: ChildAgentRun,
  childSessionId: string | undefined,
  verb: string,
): string | null {
  if (childSessionId === undefined) return previous.childSessionId;
  if (
    previous.childSessionId !== null &&
    previous.childSessionId !== childSessionId
  ) {
    throw new ManagedSessionRecordError(
      `Child run ${verb} cannot rename the Session it already named.`,
    );
  }
  return childSessionId;
}

/** A proven failure; a pre-creation failure lands on not_started_proven.
 * `quota_exceeded` must carry its quota reason; the other failures carry
 * none. A never-started settlement may name the Session the creation
 * minted — the lineage is what the close cascade and the relay owe their
 * close admissions to, and an unnamed mint would orphan it. */
export function childFailBody(
  previous: ChildAgentRun,
  params: {
    readonly stopReason: Extract<
      ChildAgentStopReason,
      'creation_failed' | 'child_failed' | 'quota_exceeded'
    >;
    readonly reason: ChildAgentRun['run']['reason'];
    readonly started: boolean;
    readonly childSessionId?: string;
  },
): ChildAgentRun {
  return Object.freeze({
    ...previous,
    stopReason: params.stopReason,
    childSessionId: adoptChildSessionId(
      previous,
      params.childSessionId,
      'failure',
    ),
    run: Object.freeze({
      ...previous.run,
      state: 'failed',
      reason: params.reason,
      execution: params.started ? 'settled' : 'not_started_proven',
      delivery: Object.freeze({ target: 'session', state: 'cancelled' }),
    }),
  });
}

/** A stop was requested of the owner; set once, never cleared. */
export function childStopRequestedBody(previous: ChildAgentRun): ChildAgentRun {
  return Object.freeze({ ...previous, stopRequested: true });
}

/**
 * `cancelChildRun`/`closeChildScope` settlement: the request was honored.
 * The stop request folds in (it may only ever be set, and the successorship
 * keeps earlier requests); a request the cascade wants durable early still
 * rides the separate {@link childStopRequestedBody} revision.
 */
export function childCancelBody(
  previous: ChildAgentRun,
  params: { readonly started: boolean; readonly childSessionId?: string },
): ChildAgentRun {
  return Object.freeze({
    ...previous,
    stopReason: 'stop_requested',
    stopRequested: true,
    childSessionId: adoptChildSessionId(
      previous,
      params.childSessionId,
      'close',
    ),
    run: Object.freeze({
      ...previous.run,
      state: 'cancelled',
      execution: params.started ? 'settled' : 'not_started_proven',
      delivery: Object.freeze({ target: 'session', state: 'cancelled' }),
    }),
  });
}

/** One delivery step on an ended run: accepting → accepted → consumed, or
 * a pre-acceptance step into unknown (the relay's retry vocabulary). */
export function childDeliveryBody(
  previous: ChildAgentRun,
  state: 'accepted' | 'consumed' | 'unknown',
): ChildAgentRun {
  return Object.freeze({
    ...previous,
    run: Object.freeze({
      ...previous.run,
      delivery: Object.freeze({ target: 'session', state }),
    }),
  });
}

/** `acceptChildResult` revision 1: the settled, already-accepted receipt. */
export function childAcceptanceBody(
  child: ChildAgentRun,
  params: {
    readonly contentRef: ManagedSessionDurableRef;
    readonly terminalReceiptRef: ManagedSessionDurableRef;
  },
): ChildAcceptance {
  return Object.freeze({
    childRunId: child.childRunId,
    parentScopeId: child.ownerScopeId,
    parentExecutionCallId:
      child.completion === 'tool' ? child.run.executionCallId : null,
    resultVersion: child.resultVersion,
    contentRef: params.contentRef,
    contentDigest: params.contentRef.digest,
    terminalReceiptRef: params.terminalReceiptRef,
    run: Object.freeze({
      state: 'settled',
      reason: null,
      definition: null,
      executionCallId: null,
      effectId: null,
      dispatchId: null,
      deliveryId: null,
      execution: null,
      runtime: null,
      delivery: Object.freeze({ target: 'session', state: 'accepted' }),
    }),
  });
}

/** The acceptance's only successor: the consumption of the original. */
export function childAcceptanceConsumedBody(
  previous: ChildAcceptance,
): ChildAcceptance {
  return Object.freeze({
    ...previous,
    run: Object.freeze({
      ...previous.run,
      delivery: Object.freeze({ target: 'session', state: 'consumed' }),
    }),
  });
}
