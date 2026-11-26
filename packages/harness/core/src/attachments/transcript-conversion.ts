/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Attachment, AttachmentData } from './types.js';
import { BaseAttachment } from './models/base-attachment.js';
import { EnvironmentAttachment } from './models/environment-attachment.js';
import { SessionContextAttachment } from './models/session-context-attachment.js';
import { isWellFormedAttachmentPayload } from '../protocol/transcript/message-utils.js';
import {
  AgentMentionAttachment,
  PeerMentionAttachment,
  AgentListingDeltaAttachment,
  TeamContextAttachment,
} from './models/agent-attachments.js';
import {
  AutoModeAttachment,
  AutoModeExitAttachment,
} from './models/auto-mode-attachments.js';
import { QueuedCommandAttachment } from './models/command-attachments.js';
import {
  FileAttachment,
  ImageFileAttachment,
  InvalidImageFileAttachment,
  AlreadyReadFileAttachment,
  CompactFileReferenceAttachment,
  PDFReferenceAttachment,
  PDFFileAttachment,
  EditedTextFileAttachment,
  EditedImageFileAttachment,
  DirectoryAttachment,
} from './models/file-attachments.js';
import { GoalStateAttachment } from './models/goal-attachments.js';
import {
  TurnBudgetGuidanceAttachment,
  TurnBudgetExhaustedAttachment,
  RemainingTurnsAttachment,
  AdditionalTurnsAttachment,
} from './models/turn-attachments.js';
import {
  HookOutputAttachment,
  HookBlockingErrorAttachment,
  HookNonBlockingErrorAttachment,
  HookErrorDuringExecutionAttachment,
  HookSuccessAttachment,
  HookCancelledAttachment,
  HookStoppedContinuationAttachment,
  HookSystemMessageAttachment,
  HookPermissionDecisionAttachment,
} from './models/hook-attachments.js';
import {
  McpInstructionsDeltaAttachment,
  McpLazyToolsDeltaAttachment,
  McpResourceAttachment,
} from './models/mcp-attachments.js';
import {
  RelevantMemoriesAttachment,
  CurrentSessionMemoryAttachment,
} from './models/memory-attachments.js';
import {
  PlanFileReferenceAttachment,
  PlanModeAttachment,
  PlanModeReentryAttachment,
  PlanModeExitAttachment,
  VerifyPlanReminderAttachment,
} from './models/plan-attachments.js';
import { PostCompactRestoredFilesAttachment } from './models/restore-attachments.js';
import {
  SkillListingAttachment,
  InvokedSkillsAttachment,
} from './models/skill-attachments.js';
import {
  DateChangeAttachment,
  CriticalSystemReminderAttachment,
  StreamInterruptionAttachment,
  TokenUsageAttachment,
  CompactionReminderAttachment,
} from './models/system-attachments.js';
import {
  TaskReminderAttachment,
  TodoReminderAttachment,
} from './models/task-attachments.js';
import {
  WorkflowKeywordRequestAttachment,
  UltraEffortEnterAttachment,
  UltraEffortExitAttachment,
} from './models/workflow-attachments.js';

type AttachmentClasses = {
  readonly [K in Attachment['type']]: {
    fromTranscript(
      data: AttachmentData<Extract<Attachment, { type: K }>>,
    ): Extract<Attachment, { type: K }>;
  };
};

/** Complete class map used only when restoring plain attachment data. */
const attachmentClasses: AttachmentClasses = {
  environment: EnvironmentAttachment,
  session_context: SessionContextAttachment,
  file: FileAttachment,
  image_file: ImageFileAttachment,
  invalid_image_file: InvalidImageFileAttachment,
  already_read_file: AlreadyReadFileAttachment,
  compact_file_reference: CompactFileReferenceAttachment,
  pdf_reference: PDFReferenceAttachment,
  pdf_file: PDFFileAttachment,
  edited_text_file: EditedTextFileAttachment,
  edited_image_file: EditedImageFileAttachment,
  directory: DirectoryAttachment,
  relevant_memories: RelevantMemoriesAttachment,
  current_session_memory: CurrentSessionMemoryAttachment,
  skill_listing: SkillListingAttachment,
  invoked_skills: InvokedSkillsAttachment,
  plan_file_reference: PlanFileReferenceAttachment,
  plan_mode: PlanModeAttachment,
  plan_mode_reentry: PlanModeReentryAttachment,
  plan_mode_exit: PlanModeExitAttachment,
  verify_plan_reminder: VerifyPlanReminderAttachment,
  auto_mode: AutoModeAttachment,
  auto_mode_exit: AutoModeExitAttachment,
  goal_state: GoalStateAttachment,
  turn_budget_guidance: TurnBudgetGuidanceAttachment,
  turn_budget_exhausted: TurnBudgetExhaustedAttachment,
  remaining_turns: RemainingTurnsAttachment,
  additional_turns: AdditionalTurnsAttachment,
  date_change: DateChangeAttachment,
  critical_system_reminder: CriticalSystemReminderAttachment,
  stream_interruption: StreamInterruptionAttachment,
  token_usage: TokenUsageAttachment,
  compaction_reminder: CompactionReminderAttachment,
  workflow_keyword_request: WorkflowKeywordRequestAttachment,
  ultra_effort_enter: UltraEffortEnterAttachment,
  ultra_effort_exit: UltraEffortExitAttachment,
  queued_command: QueuedCommandAttachment,
  task_reminder: TaskReminderAttachment,
  todo_reminder: TodoReminderAttachment,
  agent_mention: AgentMentionAttachment,
  peer_mention: PeerMentionAttachment,
  agent_listing_delta: AgentListingDeltaAttachment,
  team_context: TeamContextAttachment,
  hook_output: HookOutputAttachment,
  hook_blocking_error: HookBlockingErrorAttachment,
  hook_non_blocking_error: HookNonBlockingErrorAttachment,
  hook_error_during_execution: HookErrorDuringExecutionAttachment,
  hook_success: HookSuccessAttachment,
  hook_cancelled: HookCancelledAttachment,
  hook_stopped_continuation: HookStoppedContinuationAttachment,
  hook_system_message: HookSystemMessageAttachment,
  hook_permission_decision: HookPermissionDecisionAttachment,
  mcp_instructions_delta: McpInstructionsDeltaAttachment,
  mcp_lazy_tools_delta: McpLazyToolsDeltaAttachment,
  mcp_resource: McpResourceAttachment,
  post_compact_restored_files: PostCompactRestoredFilesAttachment,
};

/** Restore known transcript data without imposing new historical schema requirements. */
export function restoreAttachment(value: unknown): Attachment | undefined {
  if (!isWellFormedAttachmentPayload(value)) return undefined;
  if (!Object.hasOwn(attachmentClasses, value.type)) return undefined;
  if (value instanceof BaseAttachment) return value as Attachment;

  // Dynamic indexing loses the map's relation between discriminator and input.
  const attachmentClass = attachmentClasses[
    value.type as Attachment['type']
  ] as { fromTranscript(data: AttachmentData<Attachment>): Attachment };
  return attachmentClass.fromTranscript(value as AttachmentData<Attachment>);
}
