/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  hasModelRequestObservationListeners,
  publishModelRequestObservation,
  type ModelRequestProgressIdentity,
} from '../../model-request/request-scope.js';
import {
  observationElapsedMs,
  observationMonotonicNow,
  observationWaitFailureStatus,
} from '../../utils/observation-clock.js';
import type { CustomRequest } from '../request/customRequest.js';

interface ActualRequestIdentity {
  readonly sessionId: string;
  readonly requestSetId?: string;
  readonly requestId: string;
}

export interface ModelRequestPhysicalObservationContext {
  /** The initial Provider scope; a retry's current request ID is not its key. */
  readonly identity: ModelRequestProgressIdentity;
  readonly model: string;
  readonly attempt?: number;
}

interface Registration extends ModelRequestPhysicalObservationContext {
  readonly requestId: string;
}

interface RequestState {
  readonly registration: Registration;
  attemptIndex: number;
}

export interface ModelPhysicalSendObservation {
  readonly registration: Registration;
  readonly data: Record<string, unknown>;
  readonly startedAt?: number;
}

const registrations = new Map<string, Registration>();
const requests = new WeakMap<CustomRequest, RequestState>();

function key(identity: ActualRequestIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.requestSetId ?? identity.requestId,
    identity.requestId,
  ]);
}

/** Register one actual Provider submission without changing its request object. */
export function registerModelRequestPhysicalObservation(
  actualIdentity: ActualRequestIdentity,
  context: ModelRequestPhysicalObservationContext,
): () => void {
  try {
    if (!hasModelRequestObservationListeners(context.identity)) return () => {};
    const identity = { ...context.identity };
    const registration: Registration = {
      identity,
      requestId: actualIdentity.requestId,
      model: context.model,
      attempt: context.attempt,
    };
    const id = key(actualIdentity);
    registrations.set(id, registration);
    return () => {
      if (registrations.get(id) === registration) registrations.delete(id);
    };
  } catch {
    return () => {};
  }
}

/** Capture the immutable Provider scope before Client valves mutate the route. */
export function bindModelRequestPhysicalObservation(
  request: CustomRequest,
  actualIdentity: ActualRequestIdentity,
): void {
  try {
    const registration = registrations.get(key(actualIdentity));
    if (registration) requests.set(request, { registration, attemptIndex: 0 });
  } catch {
    // Optional metadata must not prevent Client dispatch.
  }
}

function emit(
  registration: Registration,
  data: () => Record<string, unknown>,
): void {
  try {
    if (!hasModelRequestObservationListeners(registration.identity)) return;
    publishModelRequestObservation(registration.identity, {
      kind: 'physical',
      request_id: registration.requestId,
      initial_request_id: registration.identity.requestId,
      model: registration.model,
      at_ms: Date.now(),
      ...(registration.attempt === undefined
        ? {}
        : { attempt: registration.attempt }),
      data: data(),
    });
  } catch {
    // Metadata, clock and subscriber failures never replace a network result.
  }
}

/** One call for every real fetch, including same-ID Client route/auth replays. */
export function beginModelPhysicalSend(
  request: CustomRequest,
): ModelPhysicalSendObservation | undefined {
  try {
    const state = requests.get(request);
    if (
      !state ||
      !hasModelRequestObservationListeners(state.registration.identity)
    ) {
      return undefined;
    }
    const data = {
      request_id: state.registration.requestId,
      attempt_index: ++state.attemptIndex,
      host: new URL(request.url).host,
      route_kind: request.ip ? 'resolved-ip' : 'domain',
    };
    emit(state.registration, () => ({ stage: 'physical_send', ...data }));
    return {
      registration: state.registration,
      data,
      startedAt: observationMonotonicNow(),
    };
  } catch {
    return undefined;
  }
}

export function finishModelPhysicalSend(
  observation: ModelPhysicalSendObservation | undefined,
  statusCode: () => number | undefined,
): void {
  if (!observation) return;
  emit(observation.registration, () => ({
    ...observation.data,
    stage: 'physical_response_headers',
    duration_ms: observationElapsedMs(observation.startedAt),
    status_code: statusCode(),
  }));
}

/** Capture an existing Client route wait; the caller still owns its delay. */
export function beginModelPhysicalRetry(
  request: CustomRequest,
  plannedDelayMs: number,
  details?: { readonly statusCode?: number; readonly failurePhase?: string },
): ModelPhysicalSendObservation | undefined {
  try {
    const state = requests.get(request);
    if (
      !state ||
      !hasModelRequestObservationListeners(state.registration.identity)
    ) {
      return undefined;
    }
    const data = {
      request_id: state.registration.requestId,
      attempt_index: state.attemptIndex,
      retry_kind: 'route',
      planned_delay_ms: plannedDelayMs,
      delay_source: 'backoff',
      ...(details?.statusCode === undefined
        ? {}
        : { status_code: details.statusCode }),
      ...(details?.failurePhase === undefined
        ? {}
        : { failure_phase: details.failurePhase }),
    };
    emit(state.registration, () => ({
      stage: 'physical_retry_scheduled',
      ...data,
    }));
    return {
      registration: state.registration,
      data,
      startedAt: observationMonotonicNow(),
    };
  } catch {
    return undefined;
  }
}

export type ModelPhysicalRetryStatus =
  | 'ready'
  | 'interrupted'
  | { readonly error: unknown; readonly signal?: AbortSignal };

export function finishModelPhysicalRetry(
  observation: ModelPhysicalSendObservation | undefined,
  status: ModelPhysicalRetryStatus,
): void {
  if (!observation) return;
  emit(observation.registration, () => ({
    ...observation.data,
    stage: 'physical_retry_finished',
    actual_wait_ms: observationElapsedMs(observation.startedAt),
    wait_status:
      typeof status === 'string'
        ? status
        : observationWaitFailureStatus(status.error, status.signal),
  }));
}

function read(error: unknown, field: string): unknown {
  try {
    return error !== null && typeof error === 'object'
      ? (error as Record<string, unknown>)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

export function failModelPhysicalSend(
  observation: ModelPhysicalSendObservation | undefined,
  error: unknown,
): void {
  if (!observation) return;
  emit(observation.registration, () => {
    const errorType = read(error, 'name');
    const errorCode = read(error, 'code');
    return {
      ...observation.data,
      stage: 'physical_send_error',
      duration_ms: observationElapsedMs(observation.startedAt),
      ...(typeof errorType === 'string'
        ? { error_type: errorType.slice(0, 128) }
        : {}),
      ...(typeof errorCode === 'string' || typeof errorCode === 'number'
        ? { error_code: String(errorCode).slice(0, 128) }
        : {}),
    };
  });
}
