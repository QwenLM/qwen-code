/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  CommittedExtensionOperation,
  ManagedSessionActor,
  ManagedSessionCommand,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import type {
  ManagedSessionDomain,
  ManagedSessionDurableRef,
  ManagedSessionKey,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  parseTeamState,
  parseTeamTask,
  type TeamState,
  type TeamTask,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-record.js';
import {
  teamJoinBody,
  teamLifecycleBody,
  teamOpenBody,
  teamTaskOpenBody,
  teamTaskRecordId,
  teamMemberOfRun,
  teamTaskReviseBody,
  type TeamTaskChange,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-team-operations.js';

// H4e-b1 of #12827: the lead's team funnel. Every team record of a Hosted
// Session commits here: one serial write chain, `trusted_entry`, and a
// command id derived from the tool call. Before computing a write, the
// funnel asks the authority whether that command already committed: a
// committed command is done and its record answers, so a replayed call
// never rebuilds a record from a state its own earlier commits changed
// (decision 11). See docs/design/2026-10-10-managed-agent-team-lead-runtime.md.

/** The narrow authority/resource pair the team funnel commits through. */
export interface HostedTeamStore {
  readonly authority: {
    extensionRecord(
      domain: ManagedSessionDomain,
      recordId: string,
    ): { readonly record: unknown; readonly revision: number } | undefined;
    extensionRecordsInDomain(
      domain: ManagedSessionDomain,
    ): ReadonlyArray<{ readonly record: unknown }>;
    committedExtensionOperation(
      operation: string,
      commandId: string,
    ): CommittedExtensionOperation | undefined;
    commitExtensionRecord(
      command: ManagedSessionCommand,
      request: {
        readonly domain: ManagedSessionDomain;
        readonly record: unknown;
      },
      actor: ManagedSessionActor,
    ): Promise<unknown>;
  };
  readonly resources: {
    publish(kind: string, bytes: Buffer): Promise<ManagedSessionDurableRef>;
    read(ref: ManagedSessionDurableRef): Promise<Buffer>;
  };
}

/** One commit of a multi-record task_update, in its fixed order. */
export interface HostedTeamTaskStep {
  readonly taskId: string;
  readonly change: TeamTaskChange;
}

const TRUSTED: ManagedSessionActor = { class: 'trusted_entry' };

/** The resource kind of a task's description and metadata. */
export const HOSTED_TEAM_CONTENT_KIND = 'managed-team-content';

/** The member a child run joined as, read from a lead's team records. */
export function hostedTeamMemberOfRun(
  authority: {
    extensionRecordsInDomain(
      domain: 'team_state',
    ): ReadonlyArray<{ readonly record: unknown }>;
  },
  childRunId: string,
): { readonly teamId: string; readonly name: string } | undefined {
  return teamMemberOfRun(
    authority
      .extensionRecordsInDomain('team_state')
      .map((entry) => parseTeamState(entry.record)),
    childRunId,
  );
}

function digest(record: unknown): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

export class HostedTeamSession {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: HostedTeamStore,
    private readonly key: ManagedSessionKey,
  ) {}

  /** The Session's one open team (`active` or `closing`), if any. */
  openTeam(): TeamState | undefined {
    return this.store.authority
      .extensionRecordsInDomain('team_state')
      .map((entry) => parseTeamState(entry.record))
      .find((team) => team.lifecycle !== 'deleted');
  }

  team(teamId: string): TeamState | undefined {
    const existing = this.store.authority.extensionRecord('team_state', teamId);
    return existing === undefined ? undefined : parseTeamState(existing.record);
  }

  /** Every task of one team, deleted ones included, by number. */
  tasksOf(teamId: string): readonly TeamTask[] {
    return this.store.authority
      .extensionRecordsInDomain('team_task')
      .map((entry) => parseTeamTask(entry.record))
      .filter((task) => task.teamId === teamId)
      .sort((left, right) => left.number - right.number);
  }

  task(taskId: string): TeamTask | undefined {
    const existing = this.store.authority.extensionRecord('team_task', taskId);
    return existing === undefined ? undefined : parseTeamTask(existing.record);
  }

  /** The member a child run joined as, in any team of this Session. */
  memberOf(
    childRunId: string,
  ): { readonly teamId: string; readonly name: string } | undefined {
    return hostedTeamMemberOfRun(this.store.authority, childRunId);
  }

  /** Whether the command a call commits under has already committed. */
  committed(operation: string, commandId: string): boolean {
    return this.committedRecordId(operation, commandId) !== undefined;
  }

  /** The record a committed command wrote, if it has committed. */
  committedRecordId(operation: string, commandId: string): string | undefined {
    const done = this.store.authority.committedExtensionOperation(
      operation,
      commandId,
    );
    return done?.kind === 'record' ? done.result.recordId : undefined;
  }

  /** Opens a team under the call's own key, which is also its id. */
  createTeam(callKey: string, name: string): Promise<TeamState> {
    return this.commitOnce('createTeam', callKey, 'team_state', async () => ({
      recordId: callKey,
      record: teamOpenBody({
        teamId: callKey,
        name,
        leadSessionId: this.key.sessionId,
      }),
    })).then((teamId) => this.team(teamId)!);
  }

  /** Appends one member, right after its child run launched. */
  joinTeam(
    teamId: string,
    member: { readonly name: string; readonly childRunId: string },
  ): Promise<TeamState> {
    return this.commitOnce(
      'joinTeam',
      `${member.childRunId}:join`,
      'team_state',
      async () => ({
        recordId: teamId,
        record: teamJoinBody(this.mustTeam(teamId), member),
      }),
    ).then(() => this.team(teamId)!);
  }

  /** Closes, then deletes, a team: two commits, each resumed on replay. */
  async deleteTeam(callKey: string, teamId: string): Promise<TeamState> {
    for (const lifecycle of ['closing', 'deleted'] as const) {
      await this.commitOnce(
        lifecycle === 'closing' ? 'closeTeam' : 'deleteTeam',
        `${callKey}:${lifecycle}`,
        'team_state',
        async () => {
          const team = this.mustTeam(teamId);
          return {
            recordId: teamId,
            // A team a later call already moved needs no second step.
            record:
              team.lifecycle === lifecycle ||
              (lifecycle === 'closing' && team.lifecycle === 'deleted')
                ? undefined
                : teamLifecycleBody(team, lifecycle),
          };
        },
      );
    }
    return this.team(teamId)!;
  }

  /**
   * Opens a task under the call's key. The number is allocated only for a
   * call that has not committed its task yet, so a replay answers with the
   * number the call already took.
   */
  createTask(
    callKey: string,
    params: {
      readonly teamId: string;
      readonly subject: string;
      readonly description: string;
      readonly activeForm: string | null;
      readonly metadata: Record<string, unknown> | null;
    },
  ): Promise<TeamTask> {
    return this.commitOnce('createTeamTask', callKey, 'team_task', async () => {
      const number =
        this.tasksOf(params.teamId).reduce(
          (highest, task) => Math.max(highest, task.number),
          0,
        ) + 1;
      return {
        recordId: teamTaskRecordId(params.teamId, number),
        record: teamTaskOpenBody({
          teamId: params.teamId,
          number,
          subject: params.subject,
          descriptionRef: await this.publishText(params.description),
          activeForm: params.activeForm,
          metadataRef:
            params.metadata === null
              ? null
              : await this.publishJson(params.metadata),
        }),
      };
    }).then((taskId) => this.task(taskId)!);
  }

  /**
   * Commits the revisions of one task_update in their fixed order. A step
   * whose command committed is skipped; the rest are built from the
   * current records, and a step that changes nothing commits nothing.
   */
  async updateTasks(
    callKey: string,
    steps: readonly HostedTeamTaskStep[],
  ): Promise<void> {
    for (const [index, step] of steps.entries()) {
      await this.commitOnce(
        'updateTeamTask',
        `${callKey}:${index}`,
        'team_task',
        async () => {
          const previous = this.task(step.taskId);
          if (previous === undefined) {
            throw new Error(
              `Team task ${step.taskId} has no record to revise.`,
            );
          }
          const next = teamTaskReviseBody(previous, step.change);
          return {
            recordId: step.taskId,
            record:
              JSON.stringify(next) === JSON.stringify(previous)
                ? undefined
                : next,
          };
        },
      );
    }
  }

  /** The text behind a task's description reference. */
  async readText(ref: ManagedSessionDurableRef): Promise<string> {
    return (await this.store.resources.read(ref)).toString('utf8');
  }

  /** The object behind a task's metadata reference. */
  async readJson(
    ref: ManagedSessionDurableRef,
  ): Promise<Record<string, unknown>> {
    return JSON.parse(await this.readText(ref)) as Record<string, unknown>;
  }

  publishText(text: string): Promise<ManagedSessionDurableRef> {
    return this.store.resources.publish(
      HOSTED_TEAM_CONTENT_KIND,
      Buffer.from(text, 'utf8'),
    );
  }

  publishJson(
    value: Record<string, unknown>,
  ): Promise<ManagedSessionDurableRef> {
    return this.publishText(JSON.stringify(value));
  }

  private mustTeam(teamId: string): TeamState {
    const team = this.team(teamId);
    if (team === undefined) throw new Error(`Team ${teamId} has no record.`);
    return team;
  }

  /**
   * One queued write: the committed-command lookup, the body, and the
   * commit. Answers the record id the command committed (or left alone,
   * when the body is undefined because nothing changes).
   */
  private commitOnce(
    operation: string,
    commandId: string,
    domain: 'team_state' | 'team_task',
    build: () => Promise<{
      readonly recordId: string;
      readonly record: TeamState | TeamTask | undefined;
    }>,
  ): Promise<string> {
    const write = this.writes.then(async () => {
      const done = this.store.authority.committedExtensionOperation(
        operation,
        commandId,
      );
      if (done !== undefined) {
        if (done.kind !== 'record') {
          throw new Error(`Team command ${commandId} committed no record.`);
        }
        return done.result.recordId;
      }
      const { recordId, record } = await build();
      if (record === undefined) return recordId;
      await this.store.authority.commitExtensionRecord(
        {
          operation,
          commandId,
          sessionKey: this.key,
          contentDigest: digest(record),
        },
        { domain, record },
        TRUSTED,
      );
      return recordId;
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
}
