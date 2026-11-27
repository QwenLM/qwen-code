/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validation for a `PermissionUpdate` that arrived from outside the process.
 *
 * A hook can print permission changes on stdout, so those have to be parsed
 * before they are believed. Everything inside the process constructs
 * `PermissionUpdate` values directly and needs no schema; this exists for the
 * one untrusted edge.
 */

import { z } from 'zod';
import { PERMISSION_MODES } from './manager/decision/index.js';
import type { PermissionUpdate } from '../tools/tool-checkers/checker-reasons.js';

const permissionRuleValueSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
});

const permissionBehaviorSchema = z.enum(['allow', 'deny', 'ask']);

const permissionUpdateDestinationSchema = z.enum([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
]);

const permissionModeSchema = z.enum([...PERMISSION_MODES] as [
  string,
  ...string[],
]);

export const permissionUpdateSchema: z.ZodType<PermissionUpdate> =
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('addRules'),
      rules: z.array(permissionRuleValueSchema),
      behavior: permissionBehaviorSchema,
      destination: permissionUpdateDestinationSchema,
    }),
    z.object({
      type: z.literal('replaceRules'),
      rules: z.array(permissionRuleValueSchema),
      behavior: permissionBehaviorSchema,
      destination: permissionUpdateDestinationSchema,
    }),
    z.object({
      type: z.literal('removeRules'),
      rules: z.array(permissionRuleValueSchema),
      behavior: permissionBehaviorSchema,
      destination: permissionUpdateDestinationSchema,
    }),
    z.object({
      type: z.literal('setMode'),
      mode: permissionModeSchema,
      destination: permissionUpdateDestinationSchema,
    }),
    z.object({
      type: z.literal('addDirectories'),
      directories: z.array(z.string()),
      destination: permissionUpdateDestinationSchema,
    }),
    z.object({
      type: z.literal('removeDirectories'),
      directories: z.array(z.string()),
      destination: permissionUpdateDestinationSchema,
    }),
  ]) as z.ZodType<PermissionUpdate>;
