/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import stringify from 'json-stable-stringify';
import { runLogger } from '../utils/runLogger.js';
import type {
  WorkflowAgentResult,
  WorkflowJournalKeyInput,
} from './workflow-types.js';

export type WorkflowJournalRecord =
  | {
      type: 'started';
      key: string;
      agentId?: string;
      timestamp: number;
    }
  | {
      type: 'event';
      key: string;
      agentId?: string;
      event: WorkflowJournalEvent;
      timestamp: number;
    }
  | {
      type: 'result';
      key: string;
      agentId?: string;
      result: WorkflowAgentResult;
      timestamp: number;
    };

export interface WorkflowJournalEvent {
  kind: 'attempt_started' | 'retry' | 'skipped' | 'error';
  attempt?: number;
  maxAttempts?: number;
  reason?: 'stalled' | 'user-retry' | 'user-skip' | 'error';
  error?: string;
}

interface JournalResultRecord {
  key: string;
  result: WorkflowAgentResult;
}

export class WorkflowJournal {
  private readonly results = new Map<string, JournalResultRecord>();
  private previousKey = 'v2:';
  private prefixMissed = false;

  private constructor(
    private readonly readPath: string,
    private readonly appendPath: string,
  ) {}

  static async load(
    readPath: string,
    appendPath = readPath,
  ): Promise<WorkflowJournal> {
    const journal = new WorkflowJournal(readPath, appendPath);
    await journal.loadExisting();
    return journal;
  }

  async nextCachedResult(
    input: WorkflowJournalKeyInput,
  ): Promise<{ key: string; result?: WorkflowAgentResult }> {
    const key = computeWorkflowJournalKey(this.previousKey, input);
    this.previousKey = key;
    if (this.prefixMissed) return { key };

    const cached = this.results.get(key);
    if (!cached) {
      this.prefixMissed = true;
      return { key };
    }
    return {
      key,
      result: { ...cached.result, cached: true },
    };
  }

  async appendStarted(key: string, agentId?: string): Promise<void> {
    await this.append({ type: 'started', key, agentId, timestamp: Date.now() });
  }

  async appendEvent(
    key: string,
    event: WorkflowJournalEvent,
    agentId?: string,
  ): Promise<void> {
    await this.append({
      type: 'event',
      key,
      agentId,
      event,
      timestamp: Date.now(),
    });
  }

  async appendResult(
    key: string,
    result: WorkflowAgentResult,
    agentId?: string,
  ): Promise<void> {
    const liveResult = { ...result, cached: false };
    this.results.set(key, { key, result: liveResult });
    await this.append({
      type: 'result',
      key,
      agentId,
      result: liveResult,
      timestamp: Date.now(),
    });
  }

  private async loadExisting(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.readPath, 'utf8');
    } catch (error) {
      if (isFileNotFound(error)) return;
      throw error;
    }

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: WorkflowJournalRecord;
      try {
        parsed = JSON.parse(line) as WorkflowJournalRecord;
      } catch (error) {
        runLogger.warn(
          `WorkflowJournal: skipping unparseable line in ${this.readPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (parsed.type === 'result') {
        this.results.set(parsed.key, {
          key: parsed.key,
          result: parsed.result,
        });
      }
    }
  }

  private async append(record: WorkflowJournalRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.appendPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.appendFile(this.appendPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

export function computeWorkflowJournalKey(
  previousKey: string,
  input: WorkflowJournalKeyInput,
): string {
  const stableOptions =
    stringify({
      agentType: input.agentType,
      isolation: input.isolation,
      model: input.model,
      effort: input.effort,
      schema: input.schema,
      disallowedTools: input.disallowedTools,
      bashCommandClamp: input.bashCommandClamp,
    }) ?? '{}';
  return `v2:${createHash('sha256')
    .update(previousKey)
    .update('\0')
    .update(input.prompt)
    .update('\0')
    .update(stableOptions)
    .digest('hex')}`;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
