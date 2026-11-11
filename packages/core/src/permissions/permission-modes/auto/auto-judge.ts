/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  classifyAutoModeAction,
  type AutoModeClassifierResult,
  type ClassifierInvokeFn,
  type ClassifierSnapshot,
} from './classifier.js';
import { classifyJevAutoModeAction } from './jev-classifier.js';
import type { JevQuestionMode } from './jev-settings.js';
import type { Judge } from '../../../judgment/types.js';

export interface AutoJudge {
  judge(
    snapshot: ClassifierSnapshot,
    signal: AbortSignal,
    collectRequestMetadata?: boolean,
  ): Promise<AutoModeClassifierResult>;
}

export interface AutoSessionJudges {
  readonly llm?: AutoJudge;
  readonly jev?: JevAutoJudge;
  readonly shadow?: JevAutoJudge;
}

export class LlmAutoJudge implements AutoJudge {
  constructor(private readonly invoke: ClassifierInvokeFn) {}

  judge(
    snapshot: ClassifierSnapshot,
    signal: AbortSignal,
    collectRequestMetadata = false,
  ) {
    return classifyAutoModeAction(
      {
        ...snapshot,
        runtime: { ...snapshot.runtime, invokeFn: this.invoke },
      },
      signal,
      collectRequestMetadata,
    );
  }
}

export class JevAutoJudge implements AutoJudge {
  private readonly judges = new Map<string, Promise<Judge | undefined>>();

  constructor(
    private readonly options: {
      createJudge: () => Promise<Judge | undefined>;
      getSessionId: () => string;
      getWorkspace: () => string;
      getQuestionMode?: () => JevQuestionMode | undefined;
      executionMode?: 'primary' | 'shadow';
    },
  ) {}

  getJudge(): Promise<Judge | undefined> {
    const sessionId = this.options.getSessionId();
    let judge = this.judges.get(sessionId);
    if (!judge) {
      judge = this.options.createJudge().catch((error: unknown) => {
        this.judges.delete(sessionId);
        throw error;
      });
      this.judges.set(sessionId, judge);
    }
    return judge;
  }

  judge(snapshot: ClassifierSnapshot, signal: AbortSignal) {
    return classifyJevAutoModeAction(
      () => this.getJudge(),
      snapshot,
      signal,
      this.options.getWorkspace(),
      this.options.getQuestionMode?.(),
      this.options.executionMode,
    );
  }
}
