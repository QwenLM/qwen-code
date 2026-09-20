/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DAEMON_REASONING_SELECTIONS } from './types.js';

import type {
  DaemonSession,
  ReasoningSelection,
  SessionStartupConfig,
} from './types.js';

const REASONING_EFFORTS = DAEMON_REASONING_SELECTIONS.filter(
  (selection) => selection !== 'none' && selection !== 'default',
);

function isSelection(value: unknown): value is ReasoningSelection {
  return (
    typeof value === 'string' &&
    (DAEMON_REASONING_SELECTIONS as readonly string[]).includes(value)
  );
}

export function validateStartupConfigRequest(request: {
  startupConfig?: SessionStartupConfig;
  modelServiceId?: string;
  sessionScope?: string;
}): void {
  const config = request.startupConfig;
  if (config === undefined) return;
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (key) => key !== 'modelServiceId' && key !== 'reasoningEffort',
    ) ||
    typeof config.modelServiceId !== 'string' ||
    !config.modelServiceId.trim() ||
    config.modelServiceId.length > 256 ||
    (config.reasoningEffort !== undefined &&
      !isSelection(config.reasoningEffort)) ||
    request.modelServiceId !== undefined ||
    request.sessionScope === 'single'
  ) {
    throw new TypeError(
      'Invalid startupConfig: provide modelServiceId (1-256 characters) and an optional valid reasoningEffort without legacy modelServiceId or single session scope.',
    );
  }
}

export function assertStartupConfigApplied(
  session: DaemonSession,
  requested: SessionStartupConfig | undefined,
): void {
  if (!requested) return;
  const applied = session.startupConfigApplied;
  const effective = applied?.effectiveReasoning;
  const effectiveValid =
    effective &&
    (effective.state === 'disabled' ||
      effective.state === 'provider-default' ||
      (effective.state === 'enabled' &&
        (effective.effort === undefined ||
          REASONING_EFFORTS.includes(effective.effort))));
  if (
    session.modelApplied !== true ||
    !applied ||
    typeof applied.modelServiceId !== 'string' ||
    !applied.modelServiceId.trim() ||
    applied.reasoningEffort !== requested.reasoningEffort ||
    ((requested.reasoningEffort !== undefined || effective !== undefined) &&
      !effectiveValid) ||
    (requested.reasoningEffort === 'none' && effective?.state !== 'disabled') ||
    (requested.reasoningEffort !== undefined &&
      requested.reasoningEffort !== 'default' &&
      requested.reasoningEffort !== 'none' &&
      (effective?.state !== 'enabled' ||
        effective.effort !== requested.reasoningEffort))
  ) {
    throw new Error(
      'The daemon did not confirm the requested session startup configuration.',
    );
  }
}
