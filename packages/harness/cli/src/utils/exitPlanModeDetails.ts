/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  runLogger,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';

export function withExitPlanContent<
  T extends SerializableConfirmationDetails | undefined,
>(details: T, source = 'cli'): T {
  if (
    !details ||
    typeof details !== 'object' ||
    !('type' in details) ||
    details.type !== EXIT_PLAN_MODE_TOOL_NAME
  ) {
    return details;
  }

  const existingPlanContent = getExitPlanContent(details);
  if (existingPlanContent !== undefined) {
    return details;
  }

  const planPath = (details as { planPath?: unknown }).planPath;
  if (typeof planPath !== 'string' || planPath.length === 0) {
    return details;
  }

  try {
    const planContent = readFileSync(planPath, 'utf8').trim();
    if (!planContent) {
      return details;
    }

    return {
      ...details,
      planContent,
    } as T;
  } catch (error) {
    runLogger.debug(
      `[${source}] Failed to read exit plan content for control_request: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return details;
  }
}

function getExitPlanContent(
  details: SerializableConfirmationDetails | { title?: string } | undefined,
): string | undefined {
  if (
    !details ||
    typeof details !== 'object' ||
    !('type' in details) ||
    details.type !== EXIT_PLAN_MODE_TOOL_NAME
  ) {
    return undefined;
  }

  const planContent = (details as { planContent?: unknown }).planContent;
  return typeof planContent === 'string' && planContent.length > 0
    ? planContent
    : undefined;
}
