/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookLifecycleEvent as CoreHookLifecycleEvent,
  HookTurnPage as CoreHookTurnPage,
} from '@qwen-code/qwen-code-core/telemetry/hook-lifecycle-contract.js';
import type { HookLifecycleEvent, HookTurnPage } from './ui/hook-lifecycle.js';

import type {
  BridgePendingInteractionOption,
  BridgePendingPermissionInteraction,
  BridgePendingUserQuestion,
  BridgePendingUserQuestionInteraction,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type { ServeWorkspaceSkillsStatus } from '@qwen-code/acp-bridge/status';
import type {
  DaemonPendingInteractionOption,
  DaemonPendingPermissionInteraction,
  DaemonPendingUserQuestion,
  DaemonPendingUserQuestionInteraction,
  DaemonWorkspaceSkillsStatus,
} from './types.js';

type Assert<T extends true> = T;
type MutuallyAssignable<A, B> = A extends B
  ? B extends A
    ? true
    : false
  : false;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

export const hookLifecycleTypesInSync: [
  Assert<Equal<CoreHookLifecycleEvent, HookLifecycleEvent>>,
  Assert<Equal<CoreHookTurnPage, HookTurnPage>>,
] = [true, true];

type PendingInteractionOptionStaysInSync = Assert<
  MutuallyAssignable<
    BridgePendingInteractionOption,
    DaemonPendingInteractionOption
  >
>;
type PendingPermissionInteractionStaysInSync = Assert<
  MutuallyAssignable<
    BridgePendingPermissionInteraction,
    DaemonPendingPermissionInteraction
  >
>;
type PendingUserQuestionStaysInSync = Assert<
  MutuallyAssignable<BridgePendingUserQuestion, DaemonPendingUserQuestion>
>;
type PendingUserQuestionInteractionStaysInSync = Assert<
  MutuallyAssignable<
    BridgePendingUserQuestionInteraction,
    DaemonPendingUserQuestionInteraction
  >
>;

/** Compile-time assertion for bridge/SDK pending-interaction wire mirrors. */
export const pendingInteractionWireTypesInSync: [
  PendingInteractionOptionStaysInSync,
  PendingPermissionInteractionStaysInSync,
  PendingUserQuestionStaysInSync,
  PendingUserQuestionInteractionStaysInSync,
] = [true, true, true, true];

type SkillsSnapshotKeysInSync = Assert<
  Equal<
    keyof NonNullable<ServeWorkspaceSkillsStatus['snapshot']>,
    keyof NonNullable<DaemonWorkspaceSkillsStatus['snapshot']>
  >
>;
type SkillsSnapshotOptionalityInSync = Assert<
  Equal<
    undefined extends ServeWorkspaceSkillsStatus['snapshot'] ? true : false,
    undefined extends DaemonWorkspaceSkillsStatus['snapshot'] ? true : false
  >
>;

export const skillsSnapshotWireTypesInSync: [
  Assert<
    MutuallyAssignable<
      NonNullable<ServeWorkspaceSkillsStatus['snapshot']>,
      NonNullable<DaemonWorkspaceSkillsStatus['snapshot']>
    >
  >,
  SkillsSnapshotKeysInSync,
  SkillsSnapshotOptionalityInSync,
] = [true, true, true];
