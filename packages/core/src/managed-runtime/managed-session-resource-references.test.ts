/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { managedSessionNestedResourceRefs } from './managed-session-resource-references.js';
import {
  createInitialHarnessCheckpoint,
  encodeHarnessCheckpointV1,
} from './managed-harness-checkpoint.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import { encodeChildLaunchEnvelope } from './managed-child-operations.js';

const ref = (kind: string, id = kind): ManagedSessionDurableRef => ({
  resourceId: id,
  kind,
  schemaVersion: 1,
  byteLength: 2,
  digest: 'a'.repeat(64),
});
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

it('takes only declared definition edges, ignoring arbitrary nested data', () => {
  const instructionsRef = ref('managed-agent-instructions');
  const skillsRef = ref('managed-agent-skills');
  const bundleRef = ref('managed-extension-config-bundle');
  const contributionsRef = ref('managed-extension-contributions');
  expect(
    managedSessionNestedResourceRefs(
      ref('managed-definition'),
      json({
        agentDefinition: { instructionsRef, skillsRef },
        sessionSkillsRef: skillsRef,
        publicChildExtensionAgent: {
          effectiveConfigRef: bundleRef,
          extensionAgent: { bundleRef, contributionsRef },
        },
        arbitrary: { userData: ref('not-a-dependency') },
      }),
    ),
  ).toEqual([
    skillsRef,
    instructionsRef,
    skillsRef,
    bundleRef,
    bundleRef,
    contributionsRef,
  ]);
});

it('retains public child launch Skills and extension dependencies', () => {
  const skillsRef = ref('managed-agent-skills');
  const bundleRef = ref('managed-extension-config-bundle');
  const contributionsRef = ref('managed-extension-contributions');
  const bytes = encodeChildLaunchEnvelope({
    description: 'child',
    prompt: 'work',
    definition: {
      definitionId: 'agent',
      definitionRevision: 1,
      definitionDigest: 'a'.repeat(64),
    },
    publicLaunch: {
      version: 2,
      sourcePromptId: 'prompt',
      approvalMode: 'yolo',
      approvalRevision: 0,
      modelId: 'model',
      modelRevision: 0,
      modelRoute: {
        authType: 'openai',
        endpointDigest: 'a'.repeat(64),
        providerPin: 'b'.repeat(64),
      },
      skillsRef,
      extensionAgent: {
        configRevision: 1,
        bundleRef,
        contributionsRef,
        pin: {
          extensionId: 'extension',
          packageRevision: 1,
          packageDigest: 'a'.repeat(64),
        },
        agentName: 'agent',
        toolNames: ['read_file'],
      },
    },
  });
  expect(managedSessionNestedResourceRefs(ref('managed-input'), bytes)).toEqual(
    [skillsRef, bundleRef, contributionsRef],
  );
});

it('includes extension contribution pages and explicit CSI preparation inputs', () => {
  const contributions = ref('managed-extension-contributions');
  expect(
    managedSessionNestedResourceRefs(
      ref('managed-extension-config-bundle'),
      json({
        packages: [{ contributionsRef: contributions }],
      }),
    ),
  ).toEqual([contributions]);
  const part = ref('managed-extension-contributions-part');
  expect(
    managedSessionNestedResourceRefs(contributions, json({ parts: [part] })),
  ).toEqual([part]);
  const intent = ref('managed-file_history', 'intent');
  const input = ref('managed-tool-input');
  const definition = ref('managed-tool-definition');
  expect(
    managedSessionNestedResourceRefs(
      ref('managed-file_history'),
      json({
        schemaVersion: 2,
        profile: 'csi-files-retirement/1',
        preparation: {
          intentRef: intent,
          invocations: [{ inputRef: input, toolDefinitionRef: definition }],
        },
      }),
    ),
  ).toEqual([intent, input, definition]);
});

it('preserves inline and paged checkpoint references without walking message content', () => {
  const checkpoint = createInitialHarnessCheckpoint({
    sessionKey: {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      sessionId: 'session',
    },
    checkpointId: 'checkpoint',
    coveredSequence: 1,
    activationId: 'activation',
    turnId: 'turn',
    promptId: null,
    definitionRevision: 'definition',
    configRevision: 'config',
    inputDigest: 'a'.repeat(64),
    previousCheckpointId: null,
  });
  const history = ref('managed-api-history');
  const state = {
    ...checkpoint,
    resume: { ...checkpoint.resume, apiHistoryRef: history },
  };
  expect(
    managedSessionNestedResourceRefs(
      ref('managed-checkpoint'),
      encodeHarnessCheckpointV1(state),
    ),
  ).toEqual([history]);
  const page = ref('managed-checkpoint-history');
  expect(
    managedSessionNestedResourceRefs(
      ref('managed-checkpoint'),
      json({
        ...state,
        storageProfile: 'managed-checkpoint-paged/1',
        history: { ref: page, toolCount: 1, bindingCount: 0 },
      }),
    ),
  ).toEqual([history, page]);
  expect(
    managedSessionNestedResourceRefs(
      history,
      json({ message: ref('not-a-dependency') }),
    ),
  ).toEqual([]);
});
