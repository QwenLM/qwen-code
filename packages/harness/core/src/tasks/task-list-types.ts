/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BusinessInfo } from '../qoder/business-info.js';
import { z } from 'zod';

export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export const TaskListStatusSchema = z.enum(TASK_STATUSES);
export type TaskListStatus = z.infer<typeof TaskListStatusSchema>;

export const TaskMetadataSchema = z.record(z.unknown());

export const TaskListItemSchema = z.object({
  businessInfo: z
    .object({
      version: z.string(),
      id: z.string().optional(),
      model_key: z.string().optional(),
    })
    .passthrough()
    .optional(),
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  activeForm: z.string().optional(),
  owner: z.string().optional(),
  status: TaskListStatusSchema,
  blocks: z.array(z.string()),
  blockedBy: z.array(z.string()),
  metadata: TaskMetadataSchema.optional(),
});

export type TaskListItem = z.infer<typeof TaskListItemSchema>;

export interface CreateTaskInput {
  businessInfo?: Readonly<BusinessInfo>;
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskInput {
  businessInfo?: Readonly<BusinessInfo>;
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskListStatus | 'deleted';
  owner?: string | null;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskListChange {
  taskListId: string;
  operation: 'create' | 'update' | 'delete' | 'clear';
  taskId?: string;
}

export function isInternalTask(task: TaskListItem): boolean {
  return Boolean(task.metadata?.['_internal']);
}
