/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MANAGED_AUTOMATION_LIMITS,
  assertAutomationDefinition,
  type AutomationDefinition,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type {
  ManagedAutomationDefinitionInput,
  ManagedAutomationPage,
  ManagedAutomationResult,
  ManagedPublicAutomation,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type {
  HostedLoopClassifier,
  HostedLoopSession,
} from './hosted-loop-session.js';

// The fixed-interval arm of /loop for Managed Sessions: cron_create creates
// an H6 definition through the control plane's internal Session-scoped route
// (never the funnel alone — the scanner only reads the mirror row), and the
// union cron_list/cron_delete cover both the definitions and the self-paced
// sibling's pending wakeup. See docs/design/2026-11-10-managed-loop-schedule.md.

/** The narrow store-channel slice the cron funnel commits through. */
export interface HostedCronStore {
  automationsCreate(
    definition: ManagedAutomationDefinitionInput,
    idempotencyKey: string,
  ): Promise<ManagedAutomationResult>;
  automationsList(
    cursor?: string,
    limit?: number,
  ): Promise<ManagedAutomationPage>;
  automationsRetire(
    automationId: string,
    idempotencyKey: string,
  ): Promise<ManagedAutomationResult>;
}

/** The local cron_create tool's arguments, mapped onto the definition. */
export interface HostedCronCreateParams {
  readonly cron: string;
  readonly prompt: string;
  readonly recurring?: boolean;
  readonly durable?: boolean;
  readonly timezone?: string;
  readonly gate?: string;
}

/** A refusal the model can act on, carrying the typed message. */
export class HostedCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedCronError';
  }
}

export interface HostedCronSessionOptions {
  /** The active turn's permission classifier (the sibling's decision 9). */
  readonly classify: HostedLoopClassifier;
}

/** The union list answer: the bound Session's definitions plus the pending
 * unfired wakeup, each wakeup id rendered as cron_delete accepts it. */
export interface HostedCronList {
  readonly definitions: readonly ManagedPublicAutomation[];
  readonly wakeups: ReadonlyArray<{
    id: string;
    fireAt: number | null;
    prompt: string;
  }>;
}

/** A delete answer routed by id: a definition retire or a wakeup cancel. */
export type HostedCronDelete =
  | { readonly kind: 'definition'; readonly result: ManagedAutomationResult }
  | { readonly kind: 'wakeup'; readonly cancelled: boolean };

/** The page size covers the per-Session capacity (decision 2); the walk still
 * drains every page so a larger future capacity cannot truncate the union. */
const LIST_PAGE_LIMIT = 100;
const LIST_MAX_PAGES = 64;

export class HostedCronSession {
  constructor(
    private readonly store: HostedCronStore,
    private readonly loops: HostedLoopSession | undefined,
    private readonly options: HostedCronSessionOptions,
  ) {}

  /**
   * Creates a durable recurring definition bound to this Session. The
   * Idempotency-Key derives from the tool execution's identity so a re-drive
   * meets the claim or the replay instead of minting a second definition.
   */
  async create(
    params: HostedCronCreateParams,
    executionCallId: string,
  ): Promise<ManagedAutomationResult> {
    // The deployment gate (automation.enabled) is enforced by the control
    // plane's create route, which answers automation_mode_disabled; list and
    // retire stay available with the gate off (design decision 2).
    if (params.recurring === false) {
      throw new HostedCronError(
        'A Managed cron schedule must be recurring; one-shot schedules are not supported. Use loop_wakeup for a single future wakeup.',
      );
    }
    if (params.durable === false) {
      throw new HostedCronError(
        'A Managed cron schedule is always durable; durable:false is not supported. Omit durable to keep the schedule until it is cancelled.',
      );
    }
    const prompt = params.prompt.trim();
    if (prompt.length === 0) {
      throw new HostedCronError('Cron schedule prompt must not be empty.');
    }
    // The goal is a display label derived from the prompt, bounded
    // independently of the prompt's own (larger) budget.
    const goal = byteTruncate(prompt, MANAGED_AUTOMATION_LIMITS.maxGoalBytes);
    let definition: AutomationDefinition;
    try {
      definition = assertAutomationDefinition({
        goal,
        cron: params.cron,
        timezone: params.timezone ?? 'UTC',
        prompt,
        sessionMode: 'persistent',
        gate: params.gate ?? null,
      });
    } catch (cause) {
      if (cause instanceof ManagedSessionRecordError) {
        throw new HostedCronError(cause.message);
      }
      throw cause;
    }

    // Arm-time review (decision 4): scheduling future model input is
    // side-effectful, so the continuation and the gate command are vetted
    // before the definition is admitted.
    const classifierText =
      definition.gate === null
        ? definition.prompt
        : `${definition.prompt}\nGate command: ${definition.gate}`;
    const verdict = await this.options.classify({
      delaySeconds: 0,
      prompt: classifierText,
      reason: 'cron schedule arm-time review',
    });
    if (!verdict.allowed) {
      throw new HostedCronError(
        `Cron schedule admission denied: ${verdict.reason ?? 'classifier refused the continuation.'}`,
      );
    }

    const wire: ManagedAutomationDefinitionInput = {
      cron: definition.cron,
      prompt: definition.prompt,
      goal: definition.goal,
      timezone: definition.timezone,
      session_mode: 'persistent',
      gate: definition.gate,
    };
    return this.store.automationsCreate(wire, `loop:${executionCallId}:create`);
  }

  /**
   * The union list: every definition of the bound Session (walking every
   * ledger page) plus the pending unfired loop wakeup. A create mirrors
   * before it answers, so a list after a create is consistent.
   */
  async list(): Promise<HostedCronList> {
    const definitions: ManagedPublicAutomation[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const answer: ManagedAutomationPage = await this.store.automationsList(
        cursor,
        LIST_PAGE_LIMIT,
      );
      definitions.push(...answer.data);
      if (!answer.hasMore || answer.nextCursor === null) break;
      cursor = answer.nextCursor;
    }
    const wakeups = this.loops ? await this.loops.list() : [];
    return { definitions, wakeups };
  }

  /**
   * Routes by id: a `loop:<wakeupId>` id cancels the pending wakeup through
   * the sibling's journal-only consume; any other id retires the definition
   * (a retired id answers the replay). The retire key derives from the
   * execution identity like the create key.
   */
  async delete(id: string, executionCallId: string): Promise<HostedCronDelete> {
    if (id.startsWith('loop:')) {
      const cancelled = this.loops ? await this.loops.cancel(id) : false;
      return { kind: 'wakeup', cancelled };
    }
    const result = await this.store.automationsRetire(
      id,
      `loop:${executionCallId}:retire`,
    );
    return { kind: 'definition', result };
  }
}

/** A byte-safe truncation for a display label; a split code point renders as
 * the replacement character, which is acceptable for a goal. */
function byteTruncate(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8');
}
