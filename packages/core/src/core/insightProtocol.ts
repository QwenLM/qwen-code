/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface InsightProgressPayload {
  insight_progress: {
    stage: string;
    progress: number;
    detail?: string;
  };
}

export interface InsightReadyPayload {
  insight_ready: {
    path: string;
  };
}

export type ParsedInsightMessage =
  | {
      type: 'insight_progress';
      stage: string;
      progress: number;
      detail?: string;
    }
  | {
      type: 'insight_ready';
      path: string;
    };

export function encodeInsightProgressMessage(
  stage: string,
  progress: number,
  detail?: string,
): string {
  const payload: InsightProgressPayload = {
    insight_progress: { stage, progress, detail },
  };
  return JSON.stringify(payload);
}

export function encodeInsightReadyMessage(path: string): string {
  const payload: InsightReadyPayload = {
    insight_ready: { path },
  };
  return JSON.stringify(payload);
}

export function parseInsightMessage(
  message: string,
): ParsedInsightMessage | null {
  try {
    const parsed = JSON.parse(message) as {
      insight_progress?: {
        stage?: unknown;
        progress?: unknown;
        detail?: unknown;
      };
      insight_ready?: { path?: unknown };
    };

    if (parsed.insight_progress) {
      const { stage, progress, detail } = parsed.insight_progress;
      if (typeof stage === 'string' && typeof progress === 'number') {
        return {
          type: 'insight_progress',
          stage,
          progress,
          detail: typeof detail === 'string' ? detail : undefined,
        };
      }
    }

    if (parsed.insight_ready) {
      const { path } = parsed.insight_ready;
      if (typeof path === 'string') {
        return { type: 'insight_ready', path };
      }
    }
  } catch {
    return null;
  }

  return null;
}
