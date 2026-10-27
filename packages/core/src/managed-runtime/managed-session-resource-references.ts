/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MANAGED_SESSION_DOMAINS,
  assertManagedSessionDurableRef,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import { decodeChannelInputEnvelope } from './managed-channel-operations.js';
import { decodeChildLaunchEnvelope } from './managed-child-operations.js';
import { tryParseHarnessCheckpointV1 } from './managed-harness-checkpoint.js';
import {
  CHECKPOINT_HISTORY_KIND,
  checkpointHistoryPage,
  checkpointStorageBody,
  isPagedHarnessCheckpoint,
} from './managed-checkpoint-history.js';
import {
  HOSTED_RECOVERY_RESOURCE_KINDS,
  hostedRecoveryReferences,
  parseHostedRecoveryResource,
} from './hosted-recovery-records.js';
import {
  MANAGED_MESSAGE_CHUNKS_KIND,
  managedMessageChunkParts,
} from './managed-message-chunks.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  parseToolResultManifestBytes,
} from './managed-tool-result.js';

// Paths are the ref positions declared by each resource schema. Opaque input,
// tool arguments/results, replyContext and message Parts are never traversed.
const RESOURCE_REF_PATHS: Readonly<Record<string, readonly string[]>> = {
  'managed-tool_stage': ['inputRef', 'permissionRef', 'resultRef'],
  'managed-history_maintenance': ['requestRef', 'candidateRef'],
  'managed-mcp_configuration': ['catalogRef'],
  'managed-mcp_operation': ['argsRef', 'resultRef'],
  'managed-hook_registration': ['catalogRef'],
  'managed-hook_execution': ['planRef', 'inputRef', 'resultRef'],
  'managed-monitor_run': [
    'commandRef',
    'startReceiptRef',
    'outputRef',
    'lastObservationRef',
  ],
  'managed-child_run': [
    'commandRef',
    'startReceiptRef',
    'outputRef',
    'inputRef',
    'resultRef',
    'terminalReceiptRef',
  ],
  'managed-child_acceptance': ['contentRef', 'terminalReceiptRef'],
  'managed-channel_route': ['policyRef'],
  'managed-channel_delivery': [
    'contentRef',
    'segments.*.contentRef',
    'segments.*.receipt.proofRef',
  ],
  'managed-schedule': ['promptRef'],
  'managed-automation_run': ['gateOutputRef'],
  'managed-session_message': ['contentRef'],
  'managed-session_command': ['argsRef', 'replyRef'],
  'managed-team_task': ['descriptionRef', 'metadataRef'],
  'managed-team_message': ['contentRef'],
  'managed-team_plan': ['planRef', 'feedbackRef'],
  'managed-definition': [
    'sessionSkillsRef',
    'agentDefinition.instructionsRef',
    'agentDefinition.skillsRef',
    'publicChildExtensionAgent.effectiveConfigRef',
    'publicChildExtensionAgent.extensionAgent.bundleRef',
    'publicChildExtensionAgent.extensionAgent.contributionsRef',
  ],
  'managed-action-options': [
    'definitionRef',
    'rootSnapshotRef',
    'assistantRef',
    'inputRef',
    'continuationRef',
    'calls.*.inputRef',
    'calls.*.definitionRef',
  ],
  'managed-hook-plan': ['messagesRef'],
  'managed-hook-message-chunks': ['parts.*'],
  'managed-tool-outcome-chunks': ['parts.*'],
  'managed-tool-outcome': ['manifestRef', 'envelope.capture.manifest'],
  'managed-config_install': [
    'previousBundleRef',
    'restoresBundleRef',
    'bundleRef',
    'rootSnapshotRef',
    'stageAckRefs.*',
    'enableAckRefs.*',
  ],
  'managed-extension-config-bundle': ['packages.*.contributionsRef'],
  'managed-extension-contributions': ['parts.*'],
};

const CHECKPOINT_REF_PATHS = [
  'resume.apiHistoryRef',
  'resume.fileHistoryRef',
  'resume.artifactRef',
  'resume.goalRecordsRef',
  'resume.goalCheckpointWindowRef',
  'resume.tokenCountsRef',
  'resume.uiTelemetryRef',
  'resume.attributionRef',
  'attempt.routeRef',
  'attempt.capabilityRef',
  'attempt.samplingRef',
  'attempt.usageRef',
  'tools.items.*.outcomeRef',
  'approval.optionsRef',
  'approval.decisionRef',
  'approval.invocationRef',
  'output.llmContentRef',
  'output.hookResultRef',
  'output.mediaRefs.*',
] as const;

function refsAtPaths(
  value: unknown,
  paths: readonly string[],
): ManagedSessionDurableRef[] {
  const visit = (
    current: unknown,
    path: readonly string[],
  ): ManagedSessionDurableRef[] => {
    if (current === null || current === undefined) return [];
    if (path.length === 0)
      return [
        assertManagedSessionDurableRef(
          current as ManagedSessionJsonValue,
          'resource dependency',
        ),
      ];
    if (typeof current !== 'object') return [];
    const [field, ...rest] = path;
    return field === '*'
      ? (Array.isArray(current) ? current : []).flatMap((item) =>
          visit(item, rest),
        )
      : visit((current as Record<string, unknown>)[field], rest);
  };
  return paths.flatMap((path) => visit(value, path.split('.')));
}

/** Complete schema-declared resource edges, without interpreting opaque JSON. */
export function managedSessionNestedResourceRefs(
  ref: ManagedSessionDurableRef,
  bytes: Buffer,
): ManagedSessionDurableRef[] {
  if (ref.kind === MANAGED_MESSAGE_CHUNKS_KIND)
    return managedMessageChunkParts(ref.kind, bytes);
  if (ref.kind === CHECKPOINT_HISTORY_KIND)
    return refsAtPaths(checkpointHistoryPage(bytes), [
      'previous',
      'items.*.outcomeRef',
    ]);
  if (ref.kind === 'managed-checkpoint') {
    if (isPagedHarnessCheckpoint(bytes))
      return refsAtPaths(checkpointStorageBody(bytes), [
        ...CHECKPOINT_REF_PATHS,
        'history.ref',
      ]);
    const parsed = tryParseHarnessCheckpointV1(bytes);
    return parsed.ok
      ? refsAtPaths(parsed.checkpoint, CHECKPOINT_REF_PATHS)
      : [];
  }
  if (ref.kind === 'managed-input') {
    try {
      return decodeChannelInputEnvelope(bytes).attachments.flatMap(
        (attachment) => ('ref' in attachment ? [attachment.ref] : []),
      );
    } catch {
      try {
        return refsAtPaths(decodeChildLaunchEnvelope(bytes), [
          'publicLaunch.skillsRef',
          'publicLaunch.extensionAgent.bundleRef',
          'publicLaunch.extensionAgent.contributionsRef',
        ]);
      } catch {
        // Remaining input schemas contain text/inline data or opaque args.
        return [];
      }
    }
  }
  if (HOSTED_RECOVERY_RESOURCE_KINDS.has(ref.kind))
    return hostedRecoveryReferences(
      parseHostedRecoveryResource(bytes, undefined, ref.kind),
    );
  if (ref.kind === MANAGED_TOOL_RESULT_KINDS.manifest) {
    try {
      return refsAtPaths(parseToolResultManifestBytes(bytes), [
        'contents.*.body.ref',
        'contents.*.body.pages.*.ref',
      ]);
    } catch {
      return [];
    }
  }
  const domain = MANAGED_SESSION_DOMAINS.find(
    (domain) => ref.kind === `managed-${domain}`,
  );
  const paths = RESOURCE_REF_PATHS[ref.kind] ?? [];
  if (!domain && paths.length === 0) return [];
  const record = parseManagedSessionRecordJson(
    bytes.toString('utf8'),
    bytes.length,
  );
  return refsAtPaths(record, [
    ...paths,
    ...(domain ? ['previousRecordRef'] : []),
    ...(ref.kind === 'managed-file_history' &&
    (record as Record<string, unknown>)['schemaVersion'] === 2 &&
    (record as Record<string, unknown>)['profile'] === 'csi-files-retirement/1'
      ? [
          'preparation.intentRef',
          'preparation.invocations.*.inputRef',
          'preparation.invocations.*.toolDefinitionRef',
        ]
      : []),
  ]);
}
