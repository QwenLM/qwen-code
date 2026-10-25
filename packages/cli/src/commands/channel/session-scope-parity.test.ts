/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';
import {
  effectiveSessionScope,
  multiSessionCompatibilityError,
} from './config-utils.js';

// The Web Shell editor re-derives the multiSession-forced scope instead of
// importing the daemon rule (it is browser code; the SDK is the only shared
// boundary). This test is the coupling: the client copy must resolve the same
// scope the daemon does, or the editor pre-fills a value the store then
// rejects with multiSessionCompatibilityError. See
// packages/web-shell/client/components/channels/channel-editor-state.ts.
//
// The client module is loaded through a runtime path rather than a static
// import so cli's composite TypeScript program does not have to list a
// browser file that lives outside this package.
const clientModulePath = fileURLToPath(
  new URL(
    '../../../../web-shell/client/components/channels/channel-editor-state.ts',
    import.meta.url,
  ),
);

type ClientDraftModule = {
  createChannelEditorDraft: (
    descriptor: unknown,
    instance?: unknown,
  ) => { values: Record<string, string | boolean> };
};

type ScopeDefault = 'user' | 'thread' | 'chat_thread' | 'single' | undefined;

function descriptorFor(defaultSessionScope: ScopeDefault) {
  const field: Record<string, unknown> = {
    key: 'sessionScope',
    label: 'Session scope',
    kind: 'enum',
    required: true,
    options: [
      { value: 'user', label: 'Per user and chat' },
      { value: 'thread', label: 'Per thread' },
      { value: 'chat_thread', label: 'Per chat and thread' },
      { value: 'single', label: 'One shared session' },
    ],
  };
  if (defaultSessionScope !== undefined) field['default'] = defaultSessionScope;
  return {
    type: 'qq',
    displayName: 'QQ',
    manageable: true,
    fields: [
      field,
      { key: 'multiSession', label: 'Named sessions', kind: 'boolean' },
    ],
  } as unknown as DaemonChannelTypeDescriptor;
}

function instanceFor(
  rawConfig: Record<string, unknown>,
): DaemonChannelInstanceSnapshot {
  return {
    name: 'parity-bot',
    config: { type: 'qq', ...rawConfig },
    secrets: {},
    startsWithServe: false,
    runtime: { state: 'stopped' },
  } as unknown as DaemonChannelInstanceSnapshot;
}

const CASES: Array<{
  label: string;
  pluginDefault: ScopeDefault;
  rawConfig: Record<string, unknown>;
  multiSession: boolean;
}> = [
  {
    label: 'plugin default thread, no stored scope',
    pluginDefault: 'thread',
    rawConfig: {},
    multiSession: false,
  },
  {
    label: 'plugin default chat_thread, no stored scope',
    pluginDefault: 'chat_thread',
    rawConfig: {},
    multiSession: false,
  },
  {
    label: 'plugin declares no default, no stored scope',
    pluginDefault: undefined,
    rawConfig: {},
    multiSession: false,
  },
  {
    // The case this PR fixed: the legacy `field.default === 'thread'` branch
    // returns 'thread' for an existing multiSession instance, which the store
    // rejects, so the client must apply the forced scope first.
    label: 'plugin default thread, multiSession, no stored scope',
    pluginDefault: 'thread',
    rawConfig: {},
    multiSession: true,
  },
  {
    label: 'plugin default chat_thread, multiSession, no stored scope',
    pluginDefault: 'chat_thread',
    rawConfig: {},
    multiSession: true,
  },
  {
    label: 'plugin declares no default, multiSession, no stored scope',
    pluginDefault: undefined,
    rawConfig: {},
    multiSession: true,
  },
  {
    label: 'explicit stored scope wins over a forced scope',
    pluginDefault: 'chat_thread',
    rawConfig: { sessionScope: 'chat_thread' },
    multiSession: true,
  },
];

describe('web-shell/daemon session scope parity', () => {
  it.each(CASES)('$label', async (testCase) => {
    const { createChannelEditorDraft } = (await import(
      clientModulePath
    )) as ClientDraftModule;
    const rawConfig = {
      ...testCase.rawConfig,
      ...(testCase.multiSession ? { multiSession: true } : {}),
    };
    const daemonScope = effectiveSessionScope(
      rawConfig,
      testCase.multiSession,
      {
        defaultSessionScope: testCase.pluginDefault,
      },
    );
    const draft = createChannelEditorDraft(
      descriptorFor(testCase.pluginDefault),
      instanceFor(rawConfig),
    );

    expect(draft.values['sessionScope']).toBe(daemonScope);
    // When the editor pre-fills (nothing stored), the store's own check must
    // accept the value; that rejection is the failure the client copy exists
    // to prevent. An explicit stored scope is preserved on both sides and the
    // store is expected to reject it, so parity is the only claim there.
    if (testCase.rawConfig['sessionScope'] === undefined) {
      expect(
        multiSessionCompatibilityError(testCase.label, {
          multiSession: testCase.multiSession,
          sessionScope: draft.values['sessionScope'],
        } as unknown as Parameters<typeof multiSessionCompatibilityError>[1]),
      ).toBeUndefined();
    }
  });
});
