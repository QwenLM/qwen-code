/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import { useEffect, useReducer } from 'react';
import type { ModelQueueProps } from '../types.js';
import { getTuiEnvironment } from '../utils/tuiEnvironment.js';

const MODEL_QUEUE_SCENARIO = 'model-queue';
const SCENARIO_STEP_MS = 2_500;
const MODEL_QUEUE_STEPS: readonly ModelQueueProps[] = [
  {
    status: 'queued',
    requestSetId: 'dev-model-queue',
    waitTimeMs: 300_000,
    progress: 3,
  },
  {
    status: 'queued',
    requestSetId: 'dev-model-queue',
    waitTimeMs: 180_000,
    progress: 35,
  },
  {
    status: 'queued',
    requestSetId: 'dev-model-queue',
    waitTimeMs: 60_000,
    progress: 75,
  },
  {
    status: 'ready',
    requestSetId: 'dev-model-queue',
    progress: 100,
  },
];

/**
 * Deterministic visual fixture for a backend state that is otherwise hard to
 * reproduce locally. It is inert unless both DEV=true and the explicit
 * scenario name are present.
 */
export function useModelQueueDevScenario(): ModelQueueProps | null {
  const enabled =
    process.env['DEV'] === 'true' &&
    getTuiEnvironment().devScenario === MODEL_QUEUE_SCENARIO;
  const [step, advance] = useReducer(
    (current: number) => (current + 1) % MODEL_QUEUE_STEPS.length,
    0,
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(advance, SCENARIO_STEP_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  return enabled ? MODEL_QUEUE_STEPS[step] : null;
}
