/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgePendingInteractionOption,
  BridgePendingPermissionInteraction,
  BridgePendingUserQuestion,
  BridgePendingUserQuestionInteraction,
} from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  DaemonPendingInteractionOption,
  DaemonPendingPermissionInteraction,
  DaemonPendingUserQuestion,
  DaemonPendingUserQuestionInteraction,
} from './types.js';

type Assert<T extends true> = T;
type MutuallyAssignable<A, B> = A extends B
  ? B extends A
    ? true
    : false
  : false;

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
