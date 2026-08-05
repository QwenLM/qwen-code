/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  ChannelConfigFieldDescriptor,
  ChannelConfigFieldKind,
  ChannelConfigNestedFieldDescriptor,
} from '@qwen-code/channel-base';
import type {
  DaemonChannelConfigFieldDescriptor,
  DaemonChannelConfigFieldKind,
  DaemonChannelConfigNestedFieldDescriptor,
} from '@qwen-code/sdk/daemon';

type MirrorMatches<Source, Target> = [Source] extends [Target]
  ? [Target] extends [Source]
    ? true
    : false
  : false;

type FieldKindsMatch = MirrorMatches<
  ChannelConfigFieldKind,
  DaemonChannelConfigFieldKind
>;
type FieldDescriptorsMatch = MirrorMatches<
  ChannelConfigFieldDescriptor,
  DaemonChannelConfigFieldDescriptor
>;
type NestedFieldDescriptorsMatch = MirrorMatches<
  ChannelConfigNestedFieldDescriptor,
  DaemonChannelConfigNestedFieldDescriptor
>;

describe('channel descriptor SDK mirror', () => {
  it('keeps the SDK descriptor types assignable to the channel-base contract', () => {
    const fieldKindsMatch: FieldKindsMatch = true;
    const fieldDescriptorsMatch: FieldDescriptorsMatch = true;
    const nestedFieldDescriptorsMatch: NestedFieldDescriptorsMatch = true;

    expect(
      fieldKindsMatch && fieldDescriptorsMatch && nestedFieldDescriptorsMatch,
    ).toBe(true);
  });
});
