/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  ManagedSessionCommand,
  ManagedSessionInputRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionEvent,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  PR_EVENT_INPUT_SOURCE,
  PR_WATCH_RESOURCE_KINDS,
  encodePrWatchInputEnvelope,
  isPrWatchTransition,
  prWatchInputText,
  type PrWatchInputEnvelope,
  type PrWatchTransition,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-pr-watch-operations.js';

// Slice 1 of PR watch + bound-session proactive delivery: the hosted funnel that
// injects a watched-PR transition into the bound Session as an input + wake
// (source `pr_event`). Unlike the channel funnel it commits no route record and
// plans no delivery — private-only. The target Session is fixed by the control
// plane's binding before this funnel runs; it need not be a channel Session. See
// docs/design/2026-11-17-managed-github-pr-watch-bound-session.md.

/** The narrow Session slice the PR-watch funnel commits through. */
export interface HostedPrWatchStore {
  readonly authority: {
    readonly committedSequence: number;
    eventsInSequenceRange(
      from: number,
      to: number,
    ): readonly ManagedSessionEvent[];
    submitInput(
      command: ManagedSessionCommand,
      input: ManagedSessionInputRequest,
    ): Promise<unknown>;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
  };
}

export interface PrWatchSubmitParams {
  readonly inputId: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly transition: PrWatchTransition;
  readonly headSha: string;
  readonly evidence: string;
  readonly text: string;
  /** Durable per-PR occurrence number; already folded into the derived inputId. */
  readonly episode: number;
}

export interface PrWatchSubmitResult {
  readonly inputId: string;
  readonly turnId: string;
  readonly replayed: boolean;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The committed `input.accepted` for an id, if this input already landed. */
function acceptedPrWatchInput(
  store: HostedPrWatchStore,
  inputId: string,
): ManagedSessionEvent | undefined {
  return store.authority
    .eventsInSequenceRange(1, store.authority.committedSequence)
    .find(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['inputId'] === inputId &&
        event.payload['source'] === PR_EVENT_INPUT_SOURCE,
    );
}

/**
 * Inject one watched-PR transition into the bound Session. Idempotent by the
 * derived input id: a redelivery replays the committed admission, never a second
 * input. The envelope is pinned (published) before the input+wake commit.
 */
export async function submitPrEventInput(
  store: HostedPrWatchStore,
  key: ManagedSessionKey,
  params: PrWatchSubmitParams,
): Promise<PrWatchSubmitResult> {
  return serial(store, () => inject(store, key, params));
}

/**
 * One write lane per bound Session. The replay guard reads the journal and the
 * commit follows two awaits later, so a concurrent duplicate delivery of one
 * input id would otherwise pass the guard twice, orphan a second envelope pair
 * and report `replayed: false` for an admission that already happened. The
 * sibling channel funnel serializes the same read-then-commit shape.
 */
const lanes = new WeakMap<HostedPrWatchStore, Promise<unknown>>();

function serial<T>(
  store: HostedPrWatchStore,
  work: () => Promise<T>,
): Promise<T> {
  const run = (lanes.get(store) ?? Promise.resolve()).then(work);
  lanes.set(
    store,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function inject(
  store: HostedPrWatchStore,
  key: ManagedSessionKey,
  params: PrWatchSubmitParams,
): Promise<PrWatchSubmitResult> {
  if (acceptedPrWatchInput(store, params.inputId) !== undefined) {
    return {
      inputId: params.inputId,
      turnId: params.inputId,
      replayed: true,
    };
  }
  const envelope: PrWatchInputEnvelope = {
    owner: params.owner,
    repo: params.repo,
    prNumber: params.prNumber,
    transition: params.transition,
    headSha: params.headSha,
    evidence: params.evidence,
    text: prWatchInputText({
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      transition: params.transition,
      headSha: params.headSha,
      evidence: params.evidence,
      text: params.text,
    }),
  };
  const bytes = encodePrWatchInputEnvelope(envelope);
  const input: ManagedSessionInputRequest = {
    inputId: params.inputId,
    turnId: params.inputId,
    source: PR_EVENT_INPUT_SOURCE,
    contentRef: await store.resources.publish(
      PR_WATCH_RESOURCE_KINDS.input,
      bytes,
    ),
    deadline: null,
    admissionRef: await store.resources.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    ),
    wakeReason: 'input',
  };
  await store.authority.submitInput(
    {
      operation: 'submitPrEventInput',
      commandId: params.inputId,
      sessionKey: key,
      contentDigest: sha256(bytes),
    },
    input,
  );
  return {
    inputId: params.inputId,
    turnId: params.inputId,
    replayed: false,
  };
}

const PR_WATCH_INPUT_ID = /^prw-[0-9a-f]{64}:input$/u;

/** The closed shape of a `submit_pr_event_input` operation body. */
export function parsePrWatchSubmitInput(
  body: Record<string, unknown> | null | undefined,
): PrWatchSubmitParams | undefined {
  if (body === undefined || body === null) return undefined;
  const inputId = body['inputId'];
  const owner = body['owner'];
  const repo = body['repo'];
  const prNumber = body['prNumber'];
  const transition = body['transition'];
  const headSha = body['headSha'];
  const evidence = body['evidence'];
  const text = body['text'];
  const episode = body['episode'];
  if (
    typeof inputId !== 'string' ||
    !PR_WATCH_INPUT_ID.test(inputId) ||
    typeof owner !== 'string' ||
    owner.length === 0 ||
    typeof repo !== 'string' ||
    repo.length === 0 ||
    !Number.isSafeInteger(prNumber) ||
    (prNumber as number) < 1 ||
    !isPrWatchTransition(transition) ||
    typeof headSha !== 'string' ||
    headSha.length === 0 ||
    typeof evidence !== 'string' ||
    typeof text !== 'string' ||
    text.length === 0 ||
    !Number.isSafeInteger(episode) ||
    (episode as number) < 1
  ) {
    return undefined;
  }
  return {
    inputId,
    owner,
    repo,
    prNumber: prNumber as number,
    transition,
    headSha,
    evidence,
    text,
    episode: episode as number,
  };
}
