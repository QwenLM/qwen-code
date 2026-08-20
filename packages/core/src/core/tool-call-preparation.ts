/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';

export interface ToolCallPreparation {
  callId: string;
  toolName: string;
}

const preparationsByResponse = new WeakMap<
  GenerateContentResponse,
  readonly ToolCallPreparation[]
>();

export function setToolCallPreparations(
  response: GenerateContentResponse,
  preparations: readonly ToolCallPreparation[],
): void {
  preparationsByResponse.set(response, preparations);
}

export function getToolCallPreparations(
  response: GenerateContentResponse,
): readonly ToolCallPreparation[] {
  return preparationsByResponse.get(response) ?? [];
}
