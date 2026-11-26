/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SDKMessageSchema, WIRE_PROTOCOL_VERSION } from './index.js';
import type {
  SDKArtifactInfo,
  SDKArtifactUpdateMessage,
  SDKCommandsChangedMessage,
  SDKMessage,
} from './index.js';

const minimalChangedArtifact: SDKArtifactInfo = {
  path: '/workspace/minimal.md',
  display_path: 'minimal.md',
  name: 'minimal.md',
  kind: 'changed',
  additions: 1,
  deletions: 0,
  is_new: true,
};

const minimalArtifactUpdate: SDKArtifactUpdateMessage = {
  type: 'system',
  subtype: 'artifacts_update',
  artifacts: [minimalChangedArtifact],
  uuid: '00000000-0000-4000-8000-000000000001',
  session_id: 'session-minimal',
};

const minimalSDKMessage: SDKMessage = minimalArtifactUpdate;

const commandsChanged: SDKCommandsChangedMessage = {
  type: 'system',
  subtype: 'commands_changed',
  commands: [
    { name: 'review', description: 'Review code', argumentHint: '[path]' },
  ],
  uuid: '00000000-0000-4000-8000-000000000004',
  session_id: 'session-command-catalog',
};
const commandCatalogMessage: SDKMessage = commandsChanged;

// @ts-expect-error artifacts is required on artifacts_update.
const missingArtifacts: SDKArtifactUpdateMessage = {
  type: 'system',
  subtype: 'artifacts_update',
  uuid: '00000000-0000-4000-8000-000000000002',
  session_id: 'session-missing-artifacts',
};

// @ts-expect-error uuid is required on artifacts_update.
const missingUuid: SDKArtifactUpdateMessage = {
  type: 'system',
  subtype: 'artifacts_update',
  artifacts: [],
  session_id: 'session-missing-uuid',
};

// @ts-expect-error session_id is required on artifacts_update.
const missingSessionId: SDKArtifactUpdateMessage = {
  type: 'system',
  subtype: 'artifacts_update',
  artifacts: [],
  uuid: '00000000-0000-4000-8000-000000000003',
};

// @ts-expect-error path is required on every Artifact.
const missingPath: SDKArtifactInfo = {
  display_path: 'missing-path.md',
  name: 'missing-path.md',
  kind: 'changed',
  additions: 1,
  deletions: 0,
  is_new: true,
};

// @ts-expect-error display_path is required on every Artifact.
const missingDisplayPath: SDKArtifactInfo = {
  path: '/workspace/missing-display-path.md',
  name: 'missing-display-path.md',
  kind: 'changed',
  additions: 1,
  deletions: 0,
  is_new: true,
};

// @ts-expect-error name is required on every Artifact.
const missingName: SDKArtifactInfo = {
  path: '/workspace/missing-name.md',
  display_path: 'missing-name.md',
  kind: 'changed',
  additions: 1,
  deletions: 0,
  is_new: true,
};

// @ts-expect-error additions is required on changed Artifacts.
const missingAdditions: SDKArtifactInfo = {
  path: '/workspace/missing-additions.md',
  display_path: 'missing-additions.md',
  name: 'missing-additions.md',
  kind: 'changed',
  deletions: 0,
  is_new: true,
};

// @ts-expect-error deletions is required on changed Artifacts.
const missingDeletions: SDKArtifactInfo = {
  path: '/workspace/missing-deletions.md',
  display_path: 'missing-deletions.md',
  name: 'missing-deletions.md',
  kind: 'changed',
  additions: 1,
  is_new: true,
};

// @ts-expect-error is_new is required on changed Artifacts.
const missingIsNew: SDKArtifactInfo = {
  path: '/workspace/missing-is-new.md',
  display_path: 'missing-is-new.md',
  name: 'missing-is-new.md',
  kind: 'changed',
  additions: 1,
  deletions: 0,
};

void [
  minimalSDKMessage,
  missingArtifacts,
  missingUuid,
  missingSessionId,
  missingPath,
  missingDisplayPath,
  missingName,
  missingAdditions,
  missingDeletions,
  missingIsNew,
  commandCatalogMessage,
];

describe('WIRE_PROTOCOL_VERSION', () => {
  it('announces the SDK protocol version bundled with this CLI', () => {
    expect(WIRE_PROTOCOL_VERSION).toBe('1.5.0');
  });
});

describe('Artifact protocol public entry', () => {
  it('exports Artifact types and accepts artifacts_update as an SDKMessage', () => {
    const artifacts: readonly SDKArtifactInfo[] = [
      {
        path: '/workspace/report.md',
        display_path: 'report.md',
        name: 'report.md',
        group: { key: 'outputs', name: 'Outputs' },
        relative_path: 'report.md',
        size: 128,
        mime: 'text/markdown',
        mtime: 1_787_000_000_000,
        kind: 'changed',
        additions: 8,
        deletions: 2,
        is_new: false,
      },
      {
        path: '/workspace/chart.png',
        display_path: 'chart.png',
        name: 'chart.png',
        kind: 'presented',
      },
    ];
    const update: SDKArtifactUpdateMessage = {
      type: 'system',
      subtype: 'artifacts_update',
      artifacts,
      uuid: '00000000-0000-4000-8000-000000000000',
      session_id: 'session-1',
    };
    const message: SDKMessage = update;

    expect(SDKMessageSchema().parse(message)).toEqual(update);
  });
});
