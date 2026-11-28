/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { setTimeout as delay } from 'node:timers/promises';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import {
  HOSTED_HARNESS_BOOT_ID_HEADER,
  HOSTED_HARNESS_PROTOCOL_HEADER,
  HOSTED_HARNESS_PROTOCOL_VERSION,
  HOSTED_HARNESS_WORK_URL_ENV,
  type HostedHarnessContract,
} from './hosted-harness-contract.js';
import { isLoopbackBind } from './loopback-binds.js';

const POLL_PATH = '/internal/managed-harness-work/v1/poll';
// The control plane holds a poll at most this long.
const WAIT_MILLIS = 20_000;
// Well inside the control plane's 30-second push fallback, so polling
// resumes in time once the control plane is reachable again.
const RETRY_CAP_MS = 5_000;

interface WorkClaim {
  readonly sessionId: string;
  readonly placementEpoch: number;
  readonly load: Record<string, unknown>;
}

type PollOutcome =
  | { readonly claims: readonly WorkClaim[] }
  | { readonly refused: string }
  | { readonly failed: string };

/** The poll carries the Harness token, so plain HTTP is allowed only on loopback. */
export function resolveHostedHarnessWorkUrl(raw: string): URL {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    // Reported below.
  }
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      `${HOSTED_HARNESS_WORK_URL_ENV} must be an HTTP(S) origin.`,
    );
  if (url.protocol === 'http:' && !isLoopbackBind(url.hostname))
    throw new Error(
      `${HOSTED_HARNESS_WORK_URL_ENV} must use HTTPS outside the loopback interface.`,
    );
  return url;
}

function isClaim(value: unknown): value is WorkClaim {
  const claim = value as Partial<WorkClaim> | null;
  return (
    typeof claim?.sessionId === 'string' &&
    Number.isSafeInteger(claim.placementEpoch) &&
    typeof claim.load === 'object' &&
    claim.load !== null &&
    !Array.isArray(claim.load)
  );
}

function reason(cause: unknown): string {
  const inner = cause instanceof Error ? (cause.cause ?? cause) : cause;
  return inner instanceof Error ? inner.message : String(inner);
}

/**
 * Claims released Sessions over the control plane's work poll (P1.1) and runs
 * each claim's load through this Harness's own load route, as if the control
 * plane had posted it. Returns a function that stops polling.
 */
export function startHostedHarnessWorkPoll(options: {
  readonly workUrl: URL;
  /** This Harness's own listener origin. */
  readonly selfUrl: () => string;
  readonly token: string;
  readonly contract: HostedHarnessContract & { readonly instanceId: string };
  /** Cold-open slots a claim's load could take now; 0 while draining. */
  readonly freeSlots: () => number;
  readonly pauseMs?: number;
  readonly refusedMs?: number;
}): () => Promise<void> {
  const { contract, token } = options;
  const pauseMs = options.pauseMs ?? 1_000;
  const refusedMs = options.refusedMs ?? 60_000;
  const pollUrl = new URL(POLL_PATH, options.workUrl);
  const stopping = new AbortController();
  // A reply that carries claims lists each live reservation of this process,
  // and one is re-offered until its load acquires the writer or it lapses. A
  // claim is therefore new only when the last such reply did not carry it; a
  // load that failed is left to lapse rather than retried. An empty reply may
  // be a deadline that passed while a reservation was being committed, so it
  // proves nothing about the reservations still live.
  let offered = new Set<string>();
  const loading = new Set<string>();
  let failure: string | undefined;

  const pause = (ms: number): Promise<void> =>
    delay(ms, undefined, { signal: stopping.signal }).catch(() => undefined);

  const note = (next: string | undefined): void => {
    if (next === failure) return;
    writeStderrLineSafe(
      next === undefined
        ? 'qwen serve: Harness work poll recovered'
        : `qwen serve: Harness work poll failed: ${next}`,
    );
    failure = next;
  };

  const load = async (claim: WorkClaim, key: string): Promise<void> => {
    loading.add(key);
    try {
      const response = await fetch(
        `${options.selfUrl()}/session/${encodeURIComponent(claim.sessionId)}/load`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            [HOSTED_HARNESS_PROTOCOL_HEADER]: String(
              HOSTED_HARNESS_PROTOCOL_VERSION,
            ),
            [HOSTED_HARNESS_BOOT_ID_HEADER]: contract.bootId,
          },
          body: JSON.stringify(claim.load),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        code?: unknown;
      };
      if (!response.ok)
        writeStderrLineSafe(
          `qwen serve: claimed Session ${claim.sessionId} at placement ${claim.placementEpoch} did not load: ${response.status} ${String(body.code ?? '')}`,
        );
    } catch (cause) {
      writeStderrLineSafe(
        `qwen serve: claimed Session ${claim.sessionId} at placement ${claim.placementEpoch} did not load: ${reason(cause)}`,
      );
    } finally {
      loading.delete(key);
    }
  };

  const poll = async (freeSlots: number): Promise<PollOutcome> => {
    try {
      const response = await fetch(pollUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          instanceId: contract.instanceId,
          bootId: contract.bootId,
          capabilityDigest: contract.capabilityDigest,
          features: contract.features,
          freeSlots,
          waitMillis: WAIT_MILLIS,
        }),
        signal: AbortSignal.any([
          stopping.signal,
          AbortSignal.timeout(WAIT_MILLIS + 10_000),
        ]),
      });
      const body = (await response.json().catch(() => ({}))) as {
        claims?: unknown;
        code?: unknown;
      };
      const status = `${response.status} ${String(body.code ?? '')}`.trim();
      if (response.status === 403) return { refused: status };
      if (!response.ok) return { failed: status };
      if (!Array.isArray(body.claims) || !body.claims.every(isClaim))
        return { failed: 'invalid reply' };
      return { claims: body.claims };
    } catch (cause) {
      return { failed: reason(cause) };
    }
  };

  const run = async (): Promise<void> => {
    let retryMs = pauseMs;
    while (!stopping.signal.aborted) {
      const freeSlots = options.freeSlots();
      // A claim's load takes a cold-open slot, so without one even a
      // re-offered claim could not run.
      if (freeSlots <= 0) {
        await pause(pauseMs);
        continue;
      }
      const outcome = await poll(freeSlots);
      if (stopping.signal.aborted) return;
      if ('refused' in outcome) {
        // The Harness and the control plane disagree on the contract.
        note(outcome.refused);
        await pause(refusedMs);
        continue;
      }
      if ('failed' in outcome) {
        note(outcome.failed);
        await pause(retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_CAP_MS);
        continue;
      }
      note(undefined);
      retryMs = pauseMs;
      const keys = new Set<string>();
      let fresh = 0;
      for (const claim of outcome.claims) {
        const key = `${claim.sessionId}:${claim.placementEpoch}`;
        keys.add(key);
        if (offered.has(key) || loading.has(key)) continue;
        fresh += 1;
        void load(claim, key);
      }
      if (outcome.claims.length === 0) continue;
      offered = keys;
      // A pending reservation is answered at once on every poll, so pace the
      // polls instead of spinning on it until its load acquires the writer.
      if (fresh === 0) await pause(pauseMs);
    }
  };

  const running = run();
  return async () => {
    stopping.abort();
    await running;
  };
}
