/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { plugin } from '@qwen-code/channel-github';
import type {
  DaemonChannelInstanceSnapshot,
  DaemonChannelTypeDescriptor,
} from '@qwen-code/sdk/daemon';
import {
  createChannelEditorDraft,
  validateChannelEditorDraft,
} from './channel-editor-state';

// Parity between the editor's client mirror and the daemon authority. The
// descriptor is the plugin's own field list, so a lone change on either side
// (dependency dropped, second precondition added, vocabulary moved) fails
// this table instead of leaving both suites green. Test-only import: the
// plugin is a devDependency and never reaches the web-shell bundle.
const descriptor: DaemonChannelTypeDescriptor = {
  type: 'github',
  displayName: 'GitHub',
  manageable: true,
  fields: plugin.management.fields,
};

const CASES = [
  {
    name: 'delivery off with a selection',
    events: ['ci_failure'],
    delivery: false,
    code: 'requiresBoundDelivery',
    daemon: /requires deliverToBoundSessions/,
  },
  {
    name: 'delivery on with a selection',
    events: ['ci_failure'],
    delivery: true,
    code: undefined,
    daemon: undefined,
  },
  {
    name: 'delivery off with an empty selection',
    events: [],
    delivery: false,
    code: undefined,
    daemon: undefined,
  },
  {
    name: 'delivery off with an unknown value',
    events: ['typo_event'],
    delivery: false,
    code: 'invalidOption',
    daemon: /Unrecognized prWatchEvents/,
  },
] as const;

describe('bound-delivery rule parity (editor mirror vs daemon authority)', () => {
  it.each(CASES)('$name', ({ events, delivery, code, daemon }) => {
    const config = {
      type: 'github',
      useLocalGh: true,
      deliverToBoundSessions: delivery,
      prWatchEvents: [...events],
    };
    const instance: DaemonChannelInstanceSnapshot = {
      name: 'parity',
      config,
      secrets: {},
      startsWithServe: false,
      runtime: { state: 'stopped' },
    };
    const draft = createChannelEditorDraft(descriptor, instance);
    draft.name = 'parity';

    const clientCode = validateChannelEditorDraft(
      descriptor,
      draft,
      [],
      instance,
    )['prWatchEvents'];
    expect(clientCode).toBe(code);

    const daemonMessage = plugin.management.validateConfig?.(config);
    if (daemon) {
      expect(daemonMessage).toMatch(daemon);
    } else {
      expect(daemonMessage).toBeUndefined();
    }
  });
});
