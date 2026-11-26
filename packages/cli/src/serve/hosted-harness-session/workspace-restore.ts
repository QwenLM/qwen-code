/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import {
  HOSTED_RECOVERY_RESOURCE_KINDS,
  hostedRecoveryReferences,
  parseHostedRecoveryResource,
} from '@qwen-code/qwen-code-core/managed-runtime/hosted-recovery-records.js';
import {
  collectNestedResourceRefs,
  HTTP_MANAGED_SESSION_STORE_CONTRACT,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { readHarnessCheckpoint } from '@qwen-code/qwen-code-core/managed-runtime/managed-checkpoint-history.js';
import {
  isChildSessionRun,
  parseChildRun,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-record.js';
import { parseMonitorRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { createManagedHarnessHandle } from '@qwen-code/qwen-code-core/managed-runtime/managed-harness-factory.js';
import { parseMcpConfiguration } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-record.js';
import { MANAGED_MESSAGE_KIND } from '@qwen-code/qwen-code-core/managed-runtime/managed-message-chunks.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  type ManagedSessionDurableRef,
  managedSessionDurableRefsEqual,
  type ManagedSessionEvent,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  isToolResultManifestChainLink,
  MANAGED_TOOL_RESULT_LIMITS,
  parseToolResultEnvelope,
  parseToolResultManifestBytes,
  type ToolResultManifest,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result.js';
import {
  type DurableToolResultResourceStore,
  ResourceToolResultSegmentStore,
} from '@qwen-code/qwen-code-core/managed-runtime/resource-tool-result-store.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import {
  parseHostedAgentDefinition,
  readHostedAgentInstructions,
} from '../hosted-agent-definition.js';
import { parseHostedFileHistoryState } from '../hosted-file-history-protocol.js';
import { HOSTED_UUID } from '../hosted-file-history.js';
import { parseHostedModelConfigDigest } from '../hosted-model-config.js';
import {
  HostedRestoreKeptBytes,
  readerWithVerified,
} from '../hosted-restore-kept-bytes.js';
import {
  parseSessionSkillsRef,
  readHostedSkills,
} from '../hosted-skill-catalog.js';
import { parseHostedTodoState } from '../hosted-todo-session.js';
import { parseHostedActionOptions } from '../hosted-tool-approval.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from '../hosted-workspace-broker.js';
import { object, record } from './session-http.js';
import type { HostedSession } from './session-state.js';
import { isWakeOwnedInput } from './wake-recovery.js';

/** References whose resources a cold Workspace load verifies at once. */
const RESTORE_READ_BATCH = 32;

/**
 * Resource kinds a cold Workspace load descends into. Of the resources that
 * opening the Session verified, those of these kinds are queued again, so
 * what they reference is verified too; the rest are not read again.
 */
const RESTORE_CONTAINER_KINDS = new Set([
  'managed-action-options',
  'hosted-approval-continuation',
  'hosted-model-request',
  'hosted-turn-cleanup',
  'managed-definition',
  'managed-session_metadata',
  'managed-config_install',
  'managed-extension-config-bundle',
  'managed-extension-contributions',
  'managed-extension-root',
  'managed-file_history',
  'managed-todo_state',
  'managed-tool-outcome',
  'managed-tool-result-manifest',
  'managed-checkpoint',
  'managed-checkpoint-history',
  'managed-hook-plan',
  'managed-hook-message-chunks',
]);

async function readShellReceipt(
  session: HostedSession,
  receipt: ManagedSessionEvent,
) {
  const executionCallId = receipt.payload['executionCallId'];
  if (typeof executionCallId !== 'string')
    throw new Error('Original Shell receipt has no execution identity.');
  const ref = assertManagedSessionDurableRef(
    receipt.payload['toolOutcomeRef'],
    'original Shell outcome',
  );
  const outcome = object(
    JSON.parse((await session.managed.resources.read(ref)).toString('utf8')),
  );
  const history = object(outcome?.['history']);
  const envelope = parseToolResultEnvelope(outcome?.['envelope']);
  const manifest = envelope.capture?.manifest ?? null;
  const decision: 'committed' | 'blocked' =
    envelope.capture?.captureStatus === 'complete' ? 'committed' : 'blocked';
  if (
    ref.kind !== 'managed-tool-outcome' ||
    outcome?.['schemaVersion'] !== 1 ||
    outcome['decision'] !== decision ||
    !isDeepStrictEqual(outcome['manifestRef'], manifest) ||
    !isDeepStrictEqual(
      receipt.payload['resultRef'],
      decision === 'committed' ? manifest : null,
    ) ||
    !isDeepStrictEqual(
      receipt.payload['resources'],
      manifest ? [manifest] : [],
    ) ||
    receipt.payload['historyRevision'] !== receipt.sequence ||
    typeof history?.['messageId'] !== 'string' ||
    !HOSTED_UUID.test(history['messageId']) ||
    typeof history['timestamp'] !== 'string' ||
    typeof history['model'] !== 'string' ||
    !Array.isArray(history['parts'])
  )
    throw new Error('Original Shell receipt or history conflicts.');
  return {
    executionCallId,
    ref,
    envelope,
    manifest,
    decision,
    history: {
      messageId: history['messageId'],
      timestamp: history['timestamp'],
      model: history['model'],
      parts: history['parts'],
    },
  };
}

export async function verifyWorkspaceRestore(
  session: HostedSession,
  preverified: ReadonlyMap<string, ManagedSessionDurableRef>,
  toolResults: DurableToolResultResourceStore,
  throughSequence: number,
): Promise<boolean> {
  const { incomplete, messages } = await checkWorkspaceRestore(
    session,
    preverified,
    toolResults,
    throughSequence,
  );
  // Every check passed. The message bodies the checks kept go to the
  // projection's cache, so projecting the history does not read them again.
  for (const { ref, bytes } of messages.entries())
    session.managed.sink.rememberMessageBody(ref, bytes);
  messages.clear();
  await session.managed.sink.project(throughSequence);
  return incomplete;
}

/**
 * The checks of `verifyWorkspaceRestore`. Returns whether a publication is
 * incomplete, and the verified message bodies it kept for the projection.
 * Everything else the checks hold, the kept manifests among it, is released
 * when they return, before the projection fills the shared body cache.
 */
async function checkWorkspaceRestore(
  session: HostedSession,
  preverified: ReadonlyMap<string, ManagedSessionDurableRef>,
  toolResults: DurableToolResultResourceStore,
  throughSequence: number,
): Promise<{ incomplete: boolean; messages: HostedRestoreKeptBytes }> {
  const { authority, resources } = session.managed;
  // Checkpoints are parsed from the bytes their verification read. The
  // verified bytes of manifests and of message bodies are kept, each within
  // its own budget: the manifests serve the manifest loop and the manifest
  // reads of the content checks below, and the message bodies are returned
  // for the projection.
  const keptManifests = new HostedRestoreKeptBytes();
  const keptMessages = new HostedRestoreKeptBytes();
  const segmentStore = new ResourceToolResultSegmentStore({
    // The checks only read through it.
    publish: () =>
      Promise.reject(new Error('The restore verification publishes nothing.')),
    read: (ref) => {
      const bytes = keptManifests.get(ref);
      return bytes !== undefined
        ? Promise.resolve(bytes)
        : toolResults.read(ref);
    },
  });
  const manifests = new Map<string, ManagedSessionDurableRef>();
  // What opening the Session verified is checked for conflicting references
  // but not read again, except the kinds this verification descends into,
  // which are queued with the other references below.
  const verified = new Map<
    string,
    { ref: ManagedSessionDurableRef; done: Promise<void> }
  >();
  const descend: ManagedSessionDurableRef[] = [];
  for (const [id, ref] of preverified) {
    if (RESTORE_CONTAINER_KINDS.has(ref.kind)) descend.push(ref);
    else verified.set(id, { ref, done: Promise.resolve() });
  }
  const publicationManifests = new Set<string>();
  let incomplete = false;
  function readRef(ref: ManagedSessionDurableRef): Promise<void> {
    const previous = verified.get(ref.resourceId);
    if (previous) {
      if (!managedSessionDurableRefsEqual(previous.ref, ref))
        return Promise.reject(
          new Error('Hosted resource references conflict.'),
        );
      return previous.done;
    }
    const done = verifyRef(ref);
    verified.set(ref.resourceId, { ref, done });
    return done;
  }
  async function verifyRef(ref: ManagedSessionDurableRef): Promise<void> {
    const bytes = await resources.read(ref);
    if (ref.kind === MANAGED_MESSAGE_KIND) keptMessages.keep(ref, bytes);
    if (ref.kind === 'managed-tool-result-manifest') {
      manifests.set(ref.resourceId, ref);
      keptManifests.keep(ref, bytes);
    }
    if (ref.kind === 'managed-todo_state') {
      parseHostedTodoState(bytes);
      const previous = object(JSON.parse(bytes.toString('utf8')))?.[
        'previousRecordRef'
      ];
      if (previous)
        await readRef(
          assertManagedSessionDurableRef(
            previous as ManagedSessionJsonValue,
            'previous Todo state',
          ),
        );
    }
    if (
      ref.kind === 'managed-session_metadata' ||
      ref.kind === 'managed-file_history'
    ) {
      const metadata = object(JSON.parse(bytes.toString('utf8')));
      if (
        !metadata ||
        (ref.kind === 'managed-session_metadata'
          ? typeof metadata['title'] !== 'string'
          : metadata['schemaVersion'] !== 1)
      )
        throw new Error('Hosted recovery layout is unsupported.');
      if (ref.kind === 'managed-file_history')
        parseHostedFileHistoryState(
          metadata['state'],
          authority.sessionHeader.sessionKey.sessionId,
        );
      if (metadata['previousRecordRef'])
        await readRef(
          metadata['previousRecordRef'] as unknown as ManagedSessionDurableRef,
        );
    }
    if (
      HOSTED_RECOVERY_RESOURCE_KINDS.has(ref.kind) ||
      ref.kind === 'managed-action-options'
    ) {
      const body =
        ref.kind === 'managed-action-options'
          ? parseHostedActionOptions(bytes)
          : parseHostedRecoveryResource(
              bytes,
              authority.sessionHeader.sessionKey,
              ref.kind,
            );
      for (const nested of hostedRecoveryReferences(body))
        await readRef(nested);
    }
    if (ref.kind === 'managed-definition') {
      const definition = object(JSON.parse(bytes.toString('utf8')));
      parseHostedModelConfigDigest(definition?.['modelConfigDigest']);
      const sessionSkills = parseSessionSkillsRef(
        definition?.['sessionSkillsRef'],
      );
      if (sessionSkills) {
        await readRef(sessionSkills);
        await readHostedSkills(sessionSkills, resources);
      }
      const pin = parseHostedAgentDefinition(definition?.['agentDefinition']);
      if (pin?.instructionsRef) {
        await readRef(pin.instructionsRef);
        await readHostedAgentInstructions(pin, resources);
      }
      if (pin?.skillsRef) {
        await readRef(pin.skillsRef);
        await readHostedSkills(pin.skillsRef, resources);
      }
    }
    if (ref.kind === 'managed-tool-outcome') {
      const outcome = object(JSON.parse(bytes.toString('utf8')));
      if (outcome?.['manifestRef'])
        await readRef(
          assertManagedSessionDurableRef(
            outcome['manifestRef'] as ManagedSessionJsonValue,
            'outcome manifest',
          ),
        );
    }
    if (ref.kind === 'managed-checkpoint') {
      // The checkpoint itself comes from the bytes just read; only its
      // history pages, if any, are read through the Store.
      const checkpoint = await readHarnessCheckpoint(
        readerWithVerified(resources, ref, bytes),
        ref,
      );
      refs.push(...collectNestedResourceRefs(ref, bytes));
      if (
        checkpoint.resume.fileHistoryRef ||
        checkpoint.output.mediaRefs.length
      )
        throw new Error('Hosted recovery layout is unsupported.');
      const checkpointRefs = [
        checkpoint.resume.apiHistoryRef,
        checkpoint.resume.artifactRef,
        checkpoint.resume.goalRecordsRef,
        checkpoint.resume.goalCheckpointWindowRef,
        checkpoint.resume.tokenCountsRef,
        checkpoint.resume.uiTelemetryRef,
        checkpoint.resume.attributionRef,
        checkpoint.attempt?.routeRef,
        checkpoint.attempt?.capabilityRef,
        checkpoint.attempt?.samplingRef,
        checkpoint.attempt?.usageRef,
        ...(checkpoint.tools?.items.map((item) => item.outcomeRef) ?? []),
        checkpoint.approval?.optionsRef,
        checkpoint.approval?.decisionRef,
        checkpoint.approval?.invocationRef,
        checkpoint.output.llmContentRef,
        checkpoint.output.hookResultRef,
      ];
      for (const nested of checkpointRefs) {
        if (nested) await readRef(nested);
      }
    }
    if (ref.kind === 'managed-checkpoint-history') {
      refs.push(...collectNestedResourceRefs(ref, bytes));
    }
    if (ref.kind === 'managed-hook-plan') {
      const plan = object(JSON.parse(bytes.toString()));
      if (!plan) throw new Error('Hosted Hook plan is invalid.');
      if (plan['messagesRef'] !== undefined)
        await readRef(
          assertManagedSessionDurableRef(
            plan['messagesRef'] as ManagedSessionJsonValue,
            'Hook messages',
          ),
        );
    }
    if (ref.kind === 'managed-hook-message-chunks') {
      const parts = object(JSON.parse(bytes.toString()))?.['parts'];
      if (!Array.isArray(parts))
        throw new Error('Hosted Hook message manifest is invalid.');
      for (const part of parts)
        await readRef(
          assertManagedSessionDurableRef(part, 'Hook message part'),
        );
    }
  }
  const header = authority.sessionHeader;
  for (const entry of authority.extensionRecordsInDomain('mcp_configuration')) {
    const configuration = parseMcpConfiguration(entry.record);
    if (
      !session.mcp?.servers.some(
        (server) => server.serverId === configuration.serverId,
      )
    )
      throw new Error('Hosted MCP configuration is not pinned.');
  }
  const events = authority.eventsInSequenceRange(1, throughSequence);
  for (const event of events) {
    if (
      event.kind === 'domain.committed' &&
      ![
        'session_metadata',
        ...(session.mcp || session.extensions?.enabled
          ? ['config_install']
          : []),
        ...(session.extensions?.enabled ? ['tool_stage'] : []),
        'hook_registration',
        'hook_execution',
        'file_history',
        'history_maintenance',
        'todo_state',
        ...(session.mcp ? ['mcp_configuration', 'mcp_operation'] : []),
        // H3 families: an admitted child_run or monitor_run journal is
        // exactly what a workspace-profile load must restore, driven by
        // their own record parsers up front.
        'child_run',
        'monitor_run',
        // H6: definitions and runs, parsed by their own bodies.
        'schedule',
        'automation_run',
        // H4b: the parent acceptance joins its child_run chains.
        'child_acceptance',
        // H4d-b: messages along the lineage, outbox entries and receipts.
        'session_message',
        // H5: channel routes and deliveries, parsed by their own bodies.
        'channel_route',
        'channel_delivery',
        // H4e-b1: the lead's team roster and board.
        'team_state',
        'team_task',
        'team_plan',
        // H4e-b3: member command ledgers — the outbox entries, the
        // lead's inbound receipts, and the replies they carry.
        'session_command',
      ].includes(event.payload['domain'] as string)
    )
      throw new Error('Hosted recovery domain is unsupported.');
  }
  const refs = [
    header.definitionRef,
    header.rootSnapshotRef,
    ...(header.baseTranscriptProof ? [header.baseTranscriptProof] : []),
  ];
  for (const event of events) {
    for (const [field, value] of Object.entries(event.payload)) {
      if (field.endsWith('Ref') && value !== null && value !== undefined) {
        refs.push(value as unknown as ManagedSessionDurableRef);
      } else if (field === 'resources' && Array.isArray(value)) {
        for (const ref of value)
          refs.push(ref as unknown as ManagedSessionDurableRef);
      }
    }
  }
  refs.push(...descend);
  // Independent reads, a bounded batch at a time; a resource several
  // references name is still read once. A batch settles fully before a
  // failure is reported, so no read outlives the verification.
  for (let index = 0; index < refs.length; index += RESTORE_READ_BATCH) {
    const results = await Promise.allSettled(
      refs.slice(index, index + RESTORE_READ_BATCH).map((ref) => readRef(ref)),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  if (session.publication) {
    for (const event of authority.eventsInSequenceRange(1, throughSequence)) {
      if (event.kind !== 'tool.receipt') continue;
      const { executionCallId, ref, envelope, manifest } =
        await readShellReceipt(session, event);
      if (
        envelope.executionStatus === 'not_started' &&
        envelope.capture === null
      )
        continue;
      // A detached start handle has no publication delivery to verify, like
      // an unstarted one: its durable truth is the child_run record.
      if (envelope.capture?.captureStatus === 'detached') continue;
      const receipt = object(
        await session.publication.owner.request('/receipts/verify', {
          executionCallId,
          toolOutcomeRef: ref,
          manifestRef: manifest,
          historyRevision: event.sequence,
        }),
      );
      if (
        !isDeepStrictEqual(receipt?.['toolOutcomeRef'], ref) ||
        !isDeepStrictEqual(receipt?.['manifestRef'], manifest) ||
        receipt?.['historyRevision'] !== event.sequence
      )
        throw new Error('Original publication verification conflicts.');
      if (manifest) publicationManifests.add(manifest.resourceId);
      if (envelope.capture?.captureStatus !== 'complete') incomplete = true;
    }
  }
  const verifyContents = async (
    ref: ManagedSessionDurableRef,
    manifest: ToolResultManifest,
  ): Promise<void> => {
    for (const content of manifest.contents) {
      if ('ref' in content.body) {
        const bytes = await toolResults.read(content.body.ref);
        if (createHash('sha256').update(bytes).digest('hex') !== content.digest)
          throw new Error('Hosted tool result content is incomplete.');
      } else {
        const hash = createHash('sha256');
        for (
          let offset = 0;
          offset < content.byteLength ||
          (content.byteLength === 0 && offset === 0);
          offset += MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes
        ) {
          const read = await segmentStore.readRange({
            manifestRef: ref,
            expectedIdentity: manifest,
            streamId: content.streamId,
            offset,
            length: Math.min(
              MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes,
              content.byteLength - offset,
            ),
          });
          if (read.status !== 'ok')
            throw new Error('Hosted tool result content is incomplete.');
          hash.update(read.result);
        }
        if (hash.digest('hex') !== content.digest)
          throw new Error('Hosted tool result content is incomplete.');
      }
    }
  };
  // A detached background Shell or Monitor owns its own manifest lineage:
  // every record revision carried the then-current output manifest into
  // the verified population, so the history's pending revisions descend
  // here too. Their discipline is the record's own chain — a pending
  // revision mid-history is the ledger doing its job, not corruption, and
  // a detached capture never had a foreground receipt to expect.
  const detached = new Map<string, ManagedSessionDurableRef | null>();
  for (const event of events) {
    if (event.kind !== 'domain.committed') continue;
    const domain = event.payload['domain'];
    if (domain !== 'child_run' && domain !== 'monitor_run') continue;
    const recordRef = assertManagedSessionDurableRef(
      event.payload['recordRef'],
      'domain record',
    );
    const record =
      domain === 'child_run'
        ? parseChildRun(
            JSON.parse((await resources.read(recordRef)).toString('utf8')),
          )
        : parseMonitorRun(
            JSON.parse((await resources.read(recordRef)).toString('utf8')),
          );
    // A child Session run (child agent or workflow) owns no output
    // manifest — its result travels the Session delivery line — so it has
    // no detached lineage to verify.
    if ('kind' in record && isChildSessionRun(record)) continue;
    if (record.run.executionCallId !== null)
      detached.set(record.run.executionCallId, record.outputRef);
  }
  const lineages = new Map<
    string,
    Array<{ ref: ManagedSessionDurableRef; manifest: ToolResultManifest }>
  >();
  for (const ref of manifests.values()) {
    const manifest = parseToolResultManifestBytes(
      keptManifests.get(ref) ?? (await toolResults.read(ref)),
    );
    if (detached.get(manifest.executionCallId) !== undefined) {
      let members = lineages.get(manifest.executionCallId);
      if (members === undefined) {
        members = [];
        lineages.set(manifest.executionCallId, members);
      }
      members.push({ ref, manifest });
      continue;
    }
    if (session.publication) {
      if (!publicationManifests.has(ref.resourceId))
        throw new Error('Hosted publication has no verified receipt.');
      continue;
    }
    if (manifest.captureStatus !== 'complete')
      throw new Error('Hosted tool result capture is incomplete.');
    await verifyContents(ref, manifest);
  }
  for (const [executionCallId, members] of lineages) {
    members.sort(
      (left, right) => left.manifest.revision - right.manifest.revision,
    );
    for (let index = 1; index < members.length; index++)
      if (
        !isToolResultManifestChainLink(
          members[index - 1]!.manifest,
          members[index]!.manifest,
        )
      )
        throw new Error(
          `Detached capture lineage of ${executionCallId} broke.`,
        );
    const outputRef = detached.get(executionCallId);
    const terminal = members.at(-1)!;
    if (outputRef === null) {
      if (
        members.some((member) => member.manifest.executionStatus !== 'unknown')
      )
        throw new Error(
          `Detached capture lineage of ${executionCallId} settled no record named.`,
        );
      continue;
    }
    if (!isDeepStrictEqual(outputRef, terminal.ref))
      throw new Error(
        `Detached capture lineage of ${executionCallId} does not end at the record output.`,
      );
    if (terminal.manifest.captureStatus === 'complete')
      await verifyContents(terminal.ref, terminal.manifest);
  }
  return { incomplete, messages: keptMessages };
}

/**
 * Attributes each durable Shell receipt to the prompt whose turn ran the tool.
 *
 * Attribution never follows a monitor notification: a wake may only claim the
 * session while idle, so a receipt that follows a queued notification still
 * belongs to the occupied foreground turn. Receipts after every non-monitor
 * input settled attribute to nothing and stay unrecovered by the caller.
 */
export function attributeShellReceipts(
  events: readonly ManagedSessionEvent[],
): {
  promptId: string | null;
  receipts: Array<{ promptId: string; event: ManagedSessionEvent }>;
} {
  const pending = new Set<string>();
  const receipts: Array<{ promptId: string; event: ManagedSessionEvent }> = [];
  let currentPrompt: string | null = null;
  for (const event of events) {
    if (event.kind === 'input.accepted') {
      const turnId = event.payload['turnId'];
      if (typeof turnId === 'string' && !isWakeOwnedInput(event)) {
        pending.add(turnId);
        currentPrompt = turnId;
      }
    }
    if (event.kind === 'tool.receipt' && currentPrompt) {
      receipts.push({ promptId: currentPrompt, event });
    }
    if (event.kind === 'turn.settled') {
      const turnId = event.payload['turnId'];
      if (typeof turnId === 'string') {
        pending.delete(turnId);
        if (currentPrompt === turnId) currentPrompt = null;
      }
    }
  }
  return {
    promptId: pending.size === 1 ? [...pending][0] : null,
    receipts,
  };
}

export async function recoverShellReceipts(
  session: HostedSession,
  options: HostedWorkspaceBrokerOptions,
  throughSequence: number,
): Promise<string | null> {
  const authority = session.managed.authority;
  const events = authority.eventsInSequenceRange(1, throughSequence);
  const { promptId, receipts } = attributeShellReceipts(events);
  const harness = createManagedHarnessHandle(session.managed);
  const projected = receipts.length
    ? await session.managed.sink.project(throughSequence)
    : [];
  const projectedIds = new Set(projected.map((item) => item.uuid));
  for (const { promptId: receiptPromptId, event: receipt } of receipts) {
    const { executionCallId, ref, history, envelope, manifest, decision } =
      await readShellReceipt(session, receipt);
    if (!projectedIds.has(history['messageId'])) {
      if (receiptPromptId !== promptId)
        throw new Error('Settled Shell history is missing.');
      const result = record(
        session,
        authority.sessionHeader.sessionKey.sessionId,
        'tool_result',
        projected.at(-1)?.uuid ?? null,
        {
          uuid: history['messageId'],
          timestamp: history['timestamp'],
          daemonPromptId: receiptPromptId,
          model: history['model'],
          message: { role: 'user', parts: history['parts'] as Part[] },
        },
      );
      if (
        Buffer.byteLength(JSON.stringify(result)) >
        HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes
      )
        throw new Error('Original Shell history exceeds the Session limit.');
      await session.managed.sink.write(result);
      projected.push(result);
      projectedIds.add(result.uuid);
    }
    const authorization = await authority.harnessRunAuthorization();
    if (
      (decision === 'committed' ||
        envelope.executionStatus === 'not_started') &&
      authorization.status === 'runnable' &&
      authorization.checkpoint.continuation.phase === 'await_runtime' &&
      receiptPromptId === promptId &&
      authorization.checkpoint.tools?.items.some(
        (item) => item.executionCallId === executionCallId,
      )
    )
      await harness.resolveAwaitRuntime(executionCallId, ref);
    if (
      receiptPromptId !== promptId ||
      envelope.executionStatus === 'not_started'
    )
      continue;
    const intent = events.findLast(
      (event) =>
        event.sequence < receipt.sequence &&
        event.kind === 'tool.intent' &&
        event.payload['executionCallId'] === executionCallId,
    );
    const inputRef = assertManagedSessionDurableRef(
      intent?.payload['argsRef'],
      'original Shell input',
    );
    if (inputRef.kind !== 'managed-tool-input')
      throw new Error('Original Shell Runtime owner conflicts.');
    const input = object(
      JSON.parse((await session.managed.resources.read(inputRef)).toString()),
    );
    if (
      input?.['harnessSessionId'] !==
        authority.sessionHeader.sessionKey.sessionId ||
      typeof input['runtimeSessionId'] !== 'string'
    )
      throw new Error('Original Shell Runtime owner conflicts.');
    const runtimeSessionId = assertManagedSessionStableId(
      input['runtimeSessionId'],
      'original Shell Runtime owner',
    );
    try {
      const broker = new HostedWorkspaceBroker(
        options,
        authority.sessionHeader.sessionKey,
        runtimeSessionId,
      );
      await broker.acknowledgeV3(executionCallId, {
        executionCallId,
        manifest,
        deliveryStatus: decision,
        historyRevision: decision === 'committed' ? receipt.sequence : null,
      });
    } catch (cause) {
      writeStderrLineSafe(
        'qwen serve: Tool v3 ACK failed during recovery: ' + String(cause),
      );
    }
  }
  return promptId && receipts.some((item) => item.promptId === promptId)
    ? promptId
    : null;
}
