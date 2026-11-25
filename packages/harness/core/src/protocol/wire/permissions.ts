/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Wire-level permission types.
 *
 * The SDK-side `CanUseTool` callback and its `CanUseToolOptions` (which
 * carry an `AbortSignal`) live in the SDK package, not here.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'yolo' | 'plan' | 'dontAsk' | 'auto';
export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject';
export type PermissionUpdateDestination = 'userSettings' | 'projectSettings' | 'localSettings' | 'session' | 'cliArg';
export type PermissionRuleValue = {
    toolName: string;
    ruleContent?: string;
};
export type PermissionUpdate = {
    type: 'addRules';
    rules: PermissionRuleValue[];
    behavior: PermissionBehavior;
    destination: PermissionUpdateDestination;
} | {
    type: 'replaceRules';
    rules: PermissionRuleValue[];
    behavior: PermissionBehavior;
    destination: PermissionUpdateDestination;
} | {
    type: 'removeRules';
    rules: PermissionRuleValue[];
    behavior: PermissionBehavior;
    destination: PermissionUpdateDestination;
} | {
    type: 'setMode';
    mode: PermissionMode;
    destination: PermissionUpdateDestination;
} | {
    type: 'addDirectories';
    directories: string[];
    destination: PermissionUpdateDestination;
} | {
    type: 'removeDirectories';
    directories: string[];
    destination: PermissionUpdateDestination;
};
export type PermissionResult = {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: PermissionUpdate[];
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
} | {
    behavior: 'deny';
    message: string;
    interrupt?: boolean;
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
};