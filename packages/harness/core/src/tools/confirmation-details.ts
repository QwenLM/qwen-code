/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializable confirmation details — the UI data payload attached to each
 * permission request.  Discriminated on `type`.
 *
 * These types are pure data (no callbacks) and are safe to serialize across
 * process boundaries (e.g. for remote approval UIs).
 */

import type { DiffStat } from './tools.js';
import type { Question } from './ask-user-types.js';
import type {
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from './tool-names.js';
import type { WorkflowMeta } from '../workflows/workflow-types.js';

export type SerializableConfirmationDetails =
  | {
      type: 'info';
      title: string;
      systemMessage?: string;
      prompt: string;
      urls?: string[];
      /**
       * Marks a special info confirmation. 'auto_mode_breaker' renders as a
       * plain proceed/don't-proceed gate carrying the breaker notice, instead
       * of the usual tool-approval options.
       */
      kind?: 'auto_mode_breaker';
    }
  | {
      type: 'edit';
      title: string;
      systemMessage?: string;
      fileName: string;
      filePath: string;
      /** Workspace-aware display path (relative, ~/..., or absolute). */
      displayPath?: string;
      fileDiff: string;
      originalContent: string | null;
      newContent: string;
      isModifying?: boolean;
      diffStat?: DiffStat;
      /**
       * Set by `projectConfirmationDetailsForExternalUse` when the details were
       * too large to carry verbatim on an external permission frame: the
       * content fields above are then bounded previews, not the full bodies.
       * Never set on locally rendered details.
       */
      truncated?: boolean;
    }
  | {
      type: 'exec';
      title: string;
      systemMessage?: string;
      command: string;
      rootCommand: string;
      rootCommands: string[];
      commands?: string[];
      /** AI-generated description of what the command does. */
      description?: string;
      isCompound?: boolean;
      /**
       * False when no "always allow" option should be offered — the prompt
       * is a catastrophic-removal finding no rule should cover.
       */
      persistable?: boolean;
    }
  | {
      type: 'mcp';
      title: string;
      systemMessage?: string;
      serverName: string;
      toolName: string;
      toolDisplayName: string;
      toolArgs?: Record<string, unknown>;
      toolDescription?: string;
      toolParameterSchema?: unknown;
    }
  | {
      type: typeof ASK_USER_TOOL_NAME;
      title: string;
      systemMessage?: string;
      questions: Question[];
    }
  | {
      type: typeof EXIT_PLAN_MODE_TOOL_NAME;
      title: string;
      systemMessage?: string;
      planPath: string;
      /** Optional plan body included for remote approval UIs that cannot read planPath. */
      planContent?: string;
    }
  | {
      type: 'file_read';
      title: string;
      systemMessage?: string;
      filePath: string;
      /** Workspace-aware display path (relative, ~/..., or absolute). */
      displayPath: string;
      prompt?: string;
    }
  | {
      type: 'workflow';
      title: string;
      systemMessage?: string;
      prompt?: string;
      workflowName?: string;
      description?: string;
      source: 'inline' | 'name' | 'scriptPath' | 'unknown';
      script?: string;
      scriptPath?: string;
      args?: unknown;
      meta?: WorkflowMeta;
    }
  | {
      type: 'repeated_tool_call';
      title: string;
      systemMessage?: string;
      toolName: string;
      repeatCount: number;
      threshold: number;
      inputPreview: string;
    }
  | {
      type: 'video';
      title: string;
      systemMessage?: string;
      prompt: string;
      mode:
        | 'text_to_video'
        | 'first_frame_to_video'
        | 'reference_to_video';
      image?: string;
      size?: string;
      durationSeconds?: number;
    };
