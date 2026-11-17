/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { ManagedSessionRecordError } from './managed-session-records.js';

// PR watch + bound-session proactive delivery (slice 1, private-only): the pure
// construction side shared by the control plane and the Harness. A watched PR
// transition derives an idempotent input id and a durable envelope; the funnel
// commits `input.accepted` + `wake.requested` (source `pr_event`) into the bound
// Session via the existing submitInput primitive. No channel_delivery is planned
// from a pr_event input (private-only). See
// docs/design/2026-11-17-managed-github-pr-watch-bound-session.md.

/** The `source` of every PR-watch input, as the wake scheduler admits it. */
export const PR_EVENT_INPUT_SOURCE = 'pr_event';

/** The minimal slice-1 transition set (state_change is deferred). */
export const PR_WATCH_TRANSITIONS = [
  'ci_failure',
  'merge_conflict',
  'head_change',
] as const;
export type PrWatchTransition = (typeof PR_WATCH_TRANSITIONS)[number];

export const PR_WATCH_RESOURCE_KINDS = Object.freeze({
  input: 'managed-input',
} as const);

/** The inbound bounds of the PR-watch input envelope. */
export const MANAGED_PR_WATCH_LIMITS = Object.freeze({
  maxTextChars: 32_000,
  maxEnvelopeBytes: 64 * 1024,
  maxEvidenceChars: 4_000,
} as const);

const SEPARATOR = '\u0000';

function sha256(parts: ReadonlyArray<string | number>): string {
  return createHash('sha256')
    .update(parts.map(String).join(SEPARATOR), 'utf8')
    .digest('hex');
}

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function assertNoSeparator(value: string, label: string): string {
  if (value.length === 0 || value.includes(SEPARATOR)) {
    fail(`${label} must be non-empty and hold no NUL.`);
  }
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * The identity of one watched-PR transition occurrence. The head SHA pins
 * ci_failure and head_change; merge_conflict is edge-triggered and re-arms when
 * the PR becomes mergeable again. `episode` is the adapter's durable per-PR
 * occurrence counter: a legitimate recurrence (dirty→clean→dirty on the same
 * head, or head A→B→A) is a NEW episode and must derive a new input id, while a
 * redelivery of the SAME occurrence reuses the episode and derives the same id.
 * Without the episode the control plane would dedupe a legitimate recurrence
 * into the first admission.
 */
export interface PrWatchEventIdentity {
  readonly tenantId: string;
  readonly channelInstanceId: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly transition: PrWatchTransition;
  readonly headSha: string;
  readonly episode: number;
}

export function prWatchInputId(identity: PrWatchEventIdentity): string {
  return `prw-${sha256([
    assertNoSeparator(identity.tenantId, 'tenantId'),
    assertNoSeparator(identity.channelInstanceId, 'channelInstanceId'),
    assertNoSeparator(identity.owner, 'owner'),
    assertNoSeparator(identity.repo, 'repo'),
    positive(identity.prNumber, 'prNumber'),
    assertNoSeparator(identity.transition, 'transition'),
    assertNoSeparator(identity.headSha, 'headSha'),
    positive(identity.episode, 'episode'),
  ])}:input`;
}

/** The stable identity of a PR-watch binding (one per PR per channel). */
export function prWatchBindingId(params: {
  readonly tenantId: string;
  readonly channelInstanceId: string;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}): string {
  return `prb-${sha256([
    assertNoSeparator(params.tenantId, 'tenantId'),
    assertNoSeparator(params.channelInstanceId, 'channelInstanceId'),
    assertNoSeparator(params.owner, 'owner'),
    assertNoSeparator(params.repo, 'repo'),
    positive(params.prNumber, 'prNumber'),
  ])}`;
}

export function isPrWatchTransition(
  value: unknown,
): value is PrWatchTransition {
  return (
    typeof value === 'string' &&
    (PR_WATCH_TRANSITIONS as readonly string[]).includes(value)
  );
}

/** The durable envelope pinned before the input+wake commit. */
export interface PrWatchInputEnvelope {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly transition: PrWatchTransition;
  readonly headSha: string;
  /** Untrusted provider evidence (check names / mergeable_state), presentation only. */
  readonly evidence: string;
  readonly text: string;
}

function decodeEnvelopeValue(value: unknown): PrWatchInputEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('PR-watch input envelope must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  const transition = record['transition'];
  if (!isPrWatchTransition(transition)) {
    fail('PR-watch input envelope transition is not a known transition.');
  }
  const text = record['text'];
  if (typeof text !== 'string' || text.length === 0) {
    fail('PR-watch input envelope text must be a non-empty string.');
  }
  if (text.length > MANAGED_PR_WATCH_LIMITS.maxTextChars) {
    fail('PR-watch input envelope text exceeds the character bound.');
  }
  const evidence = record['evidence'];
  if (
    typeof evidence !== 'string' ||
    evidence.length > MANAGED_PR_WATCH_LIMITS.maxEvidenceChars
  ) {
    fail('PR-watch input envelope evidence exceeds the character bound.');
  }
  const owner = record['owner'];
  const repo = record['repo'];
  const headSha = record['headSha'];
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof headSha !== 'string' ||
    owner.length === 0 ||
    repo.length === 0 ||
    headSha.length === 0
  ) {
    fail(
      'PR-watch input envelope owner/repo/headSha must be non-empty strings.',
    );
  }
  const prNumber = record['prNumber'];
  if (typeof prNumber !== 'number') {
    fail('PR-watch input envelope prNumber must be a number.');
  }
  return Object.freeze({
    owner,
    repo,
    prNumber: positive(prNumber, 'prNumber'),
    transition,
    headSha,
    evidence,
    text,
  });
}

export function encodePrWatchInputEnvelope(
  envelope: PrWatchInputEnvelope,
): Buffer {
  const bytes = Buffer.from(
    JSON.stringify(decodeEnvelopeValue(envelope)),
    'utf8',
  );
  if (bytes.byteLength > MANAGED_PR_WATCH_LIMITS.maxEnvelopeBytes) {
    fail(
      `PR-watch input envelope exceeds ${MANAGED_PR_WATCH_LIMITS.maxEnvelopeBytes} bytes (byte_limit).`,
    );
  }
  return bytes;
}

export function decodePrWatchInputEnvelope(
  bytes: Buffer,
): PrWatchInputEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('PR-watch input envelope is not valid JSON.');
  }
  return decodeEnvelopeValue(parsed);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The model-facing prompt of one PR-watch input. The evidence is untrusted
 * presentation; the binding decided the target Session already. Private-only:
 * this injects into the bound Session, it is never posted to the PR.
 */
export function prWatchInputText(envelope: PrWatchInputEnvelope): string {
  const lines = [
    '<pr-watch-event>',
    `<pr>${escapeXml(`${envelope.owner}/${envelope.repo}#${envelope.prNumber}`)}</pr>`,
    `<transition>${escapeXml(envelope.transition)}</transition>`,
    `<head-sha>${escapeXml(envelope.headSha)}</head-sha>`,
  ];
  if (envelope.evidence.length > 0) {
    lines.push(
      `<evidence untrusted="true">${escapeXml(envelope.evidence)}</evidence>`,
    );
  }
  lines.push('</pr-watch-event>', envelope.text);
  return lines.join('\n');
}
