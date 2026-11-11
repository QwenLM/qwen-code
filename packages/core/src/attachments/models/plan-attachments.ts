/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { READ_FILE_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { EDIT_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { WRITE_FILE_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { ASK_USER_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { GLOB_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { GREP_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import { EXPLORE_AGENT_NAME } from '../../agents/builtin/explore-agent.js';
import { PLAN_AGENT_NAME } from '../../agents/builtin/plan-agent.js';
import { areExplorePlanAgentsDisabled } from '../../config/brand.js';
import { ENV_PLAN_MODE_AGENT_COUNT } from '../../config/brand.js';
import { ENV_PLAN_MODE_EXPLORE_AGENT_COUNT } from '../../config/brand.js';
import { systemReminder } from '../message-helpers.js';
import { userMessage } from '../message-helpers.js';

/**
 * Compact-restored plan file reference.
 * Sent after compact to tell the model the plan file content.
 */
export class PlanFileReferenceAttachment extends BaseAttachment {
  readonly type = 'plan_file_reference' as const;
  declare planFilePath: string;
  declare planContent: string;

  constructor(data: AttachmentData<PlanFileReferenceAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      userMessage(
        `Approved plan file (${this.planFilePath}):\n${this.planContent}`,
      ),
    ];
  }
}

/**
 * Current plan mode state — injected on first turn and every 5 human turns.
 * Uses turn-count throttle + full/sparse cycling.
 *
 * - reminderType='full'  : complete instructions (1st, 6th, 11th … attachment)
 * - reminderType='sparse': brief reminder (all other attachments)
 * - isSubAgent=true      : sub-agent variant with simplified instructions
 * - interviewPhase=true  : iterative pair-planning workflow instead of 5-phase workflow
 * - phase4Variant        : controls Phase 4 instruction conciseness (control/trim/cut/cap)
 */
export class PlanModeAttachment extends BaseAttachment {
  readonly type = 'plan_mode' as const;
  /** 'full' = complete instructions; 'sparse' = brief reminder. */
  declare reminderType: 'full' | 'sparse';
  declare isActive: boolean;
  declare isSubAgent?: boolean;
  /** Absolute path of the plan file for this session. */
  declare planFilePath: string;
  /** Whether a plan file already exists on disk. */
  declare planExists: boolean;
  /**
   * When true, the full reminder uses the iterative interview-phase workflow
   * (explore → update plan → ask user → repeat) instead of the 5-phase workflow.
   * Enabled via ENV_PLAN_MODE_INTERVIEW_PHASE=true environment variable.
   */
  declare interviewPhase?: boolean;
  /**
   * Policy-filtered Agent types available when this reminder was generated.
   * Undefined preserves compatibility with older persisted attachments whose
   * runtime availability was not captured.
   */
  declare availableAgentTypes?: string[];
  /**
   * Controls how the Phase 4 (Final Plan) instructions are rendered in the
   * full reminder. Defaults to 'control' (full instructions).
   * Configurable via ENV_PLAN_PHASE4_VARIANT environment variable.
   */
  declare phase4Variant?: 'control' | 'trim' | 'cut' | 'cap';

  constructor(data: AttachmentData<PlanModeAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    if (!this.isActive) {
      // Not in plan mode — no injection needed.
      return [];
    }

    const planFilePath = this.planFilePath;
    const planFileInfo = planFilePath
      ? this.planExists
        ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the ${EDIT_TOOL_NAME} tool.`
        : `No plan file exists yet. You should create your plan at ${planFilePath} using the ${WRITE_FILE_TOOL_NAME} tool.`
      : undefined;

    // Shared banner inserted into both sub-agent and full-reminder blocks.
    const planFileBanner = planFileInfo
      ? `## Plan File Info:\n${planFileInfo}\n` +
        `You should build your plan incrementally by writing to or editing this file. ` +
        `NOTE that this is the only file you are allowed to edit — other than this you are only allowed to take READ-ONLY actions.\n\n`
      : '';

    // Sub-agent: simplified read-only instructions.
    // NOTE: planFileBanner is intentionally excluded here — PlanAgent has
    // Write and Edit in its disallowedTools, so it genuinely cannot
    // edit the plan file. Including the banner ("you are allowed to edit
    // this file") would produce contradictory instructions.
    if (this.isSubAgent) {
      return [
        systemReminder(
          `Plan mode is active. The user indicated that they do not want you to execute yet — you MUST NOT make any edits, ` +
            `run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. ` +
            `This supercedes any other instructions you have received.\n\n` +
            `Answer the user's query comprehensively, using the ${ASK_USER_TOOL_NAME} tool if you need to ask the user clarifying questions. ` +
            `If you do use the ${ASK_USER_TOOL_NAME}, make sure to ask all clarifying questions you need to fully understand the user's intent before proceeding.`,
        ),
      ];
    }

    // Sparse reminder: brief (all attachments except the 1st, 6th, 11th …)
    if (this.reminderType === 'sparse') {
      return [
        systemReminder(
          `Plan mode is active (a work state — NOT a permission mode). ` +
            (planFilePath
              ? `Read-only except plan file (${planFilePath}). `
              : `Read-only mode active. `) +
            `To exit plan mode: call ${EXIT_PLAN_MODE_TOOL_NAME} (works at any time, a completed plan is NOT required). ` +
            `Memory-only requests are not part of the plan workflow: save or update memory if allowed, briefly acknowledge, and remain in plan mode. ` +
            `Do not update the plan file or call ${EXIT_PLAN_MODE_TOOL_NAME} for memory-only requests. ` +
            `Follow 5-phase workflow. ` +
            `End turns with ${ASK_USER_TOOL_NAME} (for clarifications) or ${EXIT_PLAN_MODE_TOOL_NAME} (for plan approval). ` +
            getPlanModeMemoryOnlyEndingException() +
            ` ` +
            `Memory-only requests should end with a brief acknowledgement and remain in plan mode. ` +
            `Never ask about plan approval via text or ${ASK_USER_TOOL_NAME}.`,
        ),
      ];
    }

    // 只压制「推荐」，不影响 dispatch——与 prompts/render-inputs.ts 的
    // exploreAgentGuidance 是同一条不变式。
    const disableAgents = areExplorePlanAgentsDisabled();
    const isAgentAvailable = (name: string) =>
      !disableAgents &&
      (this.availableAgentTypes === undefined ||
        this.availableAgentTypes.includes(name));
    const exploreAgentAvailable = isAgentAvailable(EXPLORE_AGENT_NAME);
    const planAgentAvailable = isAgentAvailable(PLAN_AGENT_NAME);

    // Interview-phase full reminder: iterative pair-planning workflow
    if (this.reminderType === 'full' && this.interviewPhase) {
      const exploreInstruction = exploreAgentAvailable
        ? `1. **Explore** — use the \`${EXPLORE_AGENT_NAME}\` agent or ${READ_FILE_TOOL_NAME}/${GLOB_TOOL_NAME}/${GREP_TOOL_NAME} to gather evidence`
        : `1. **Explore** — use ${READ_FILE_TOOL_NAME}/${GLOB_TOOL_NAME}/${GREP_TOOL_NAME} directly to gather evidence`;
      return [
        systemReminder(
          `Plan mode is active (interview-phase workflow). The user indicated that they do not want you to execute yet — ` +
            `you MUST NOT make any edits (with the exception of the plan file mentioned below), ` +
            `run any non-readonly tools (including changing configs or making commits), ` +
            `or otherwise make any changes to the system. This supercedes any other instructions you have received.\n\n` +
            planFileBanner +
            `## Iterative Planning Workflow\n\n` +
            `You are pair-planning with the user. Explore the codebase, ask targeted questions only when you are blocked on a genuine user decision, and capture findings in the plan file incrementally — do not attempt to produce a complete plan in a single pass.\n\n` +
            `### The Loop\n` +
            `${exploreInstruction}\n` +
            `2. **Update plan file** — write your discoveries to the plan file immediately after each exploration round\n` +
            `3. **Ask the user** — use ${ASK_USER_TOOL_NAME} only for genuine ambiguities you cannot resolve from code\n` +
            `Then repeat from step 1 until the plan is complete.\n\n` +
            `### First Turn\n` +
            `Scan 2–3 key files → write a skeleton plan. Ask clarifying questions only if a genuine ambiguity remains.\n\n` +
            `### When to Converge\n` +
            `The plan is ready when it covers: what to change, which files, what existing code to reuse, and how to verify.\n\n` +
            `This is critical - your turn should only end with either using the ${ASK_USER_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. Do not stop unless it's for these 2 reasons\n` +
            getPlanModeMemoryOnlyEndingException() +
            `\n\n` +
            `**Important:** Use ${ASK_USER_TOOL_NAME} ONLY to clarify requirements or choose between approaches. Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no ${ASK_USER_TOOL_NAME}. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.\n\n` +
            getPlanModeMemoryOnlyNote(),
        ),
      ];
    }

    // Full reminder: complete 5-phase workflow instructions (1st, 6th, 11th … attachment)
    return [
      systemReminder(
        `Plan mode is active (a work state — NOT a permission mode). ` +
          `The user indicated that they do not want you to execute yet — you MUST NOT make any edits ` +
          `(with the exception of the plan file mentioned below), run any non-readonly tools ` +
          `(including changing configs or making commits), or otherwise make any changes to the system. ` +
          `This supercedes any other instructions you have received.\n\n` +
          `**Exit:** Call ${EXIT_PLAN_MODE_TOOL_NAME} at any time to exit plan mode. ` +
          `A completed plan is NOT required — the user can also exit via the /plan command. ` +
          `Memory-only requests are the exception: do not use ${EXIT_PLAN_MODE_TOOL_NAME} for them.\n\n` +
          getPlanModeMemoryOnlyNote() +
          `\n\n` +
          planFileBanner +
          `## Plan Workflow\n\n` +
          getPlanPhase1Instructions(exploreAgentAvailable) +
          `\n\n` +
          getPlanPhase2Instructions(planAgentAvailable) +
          `\n\n` +
          `### Phase 3: Review\n` +
          `Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.\n` +
          `1. Read the critical files you identified during exploration to deepen your understanding\n` +
          `2. Ensure that the plans align with the user's original request\n` +
          `3. Use ${ASK_USER_TOOL_NAME} to clarify any remaining questions with the user\n\n` +
          `${getPlanPhase4Instructions(this.phase4Variant ?? 'control')}\n\n` +
          `### Phase 5: Call ${EXIT_PLAN_MODE_TOOL_NAME}\n` +
          `At the very end of your turn, once you have asked the user questions and are happy with your final plan file - ` +
          `you should always call ${EXIT_PLAN_MODE_TOOL_NAME} to indicate to the user that you are done planning.\n` +
          `This is critical - your turn should only end with either using the ${ASK_USER_TOOL_NAME} tool OR calling ${EXIT_PLAN_MODE_TOOL_NAME}. ` +
          `Do not stop unless it's for these 2 reasons\n` +
          getPlanModeMemoryOnlyEndingException() +
          `\n\n` +
          `**Important:** Use ${ASK_USER_TOOL_NAME} ONLY to clarify requirements or choose between approaches. ` +
          `Use ${EXIT_PLAN_MODE_TOOL_NAME} to request plan approval. ` +
          `Do NOT ask about plan approval in any other way - no text questions, no ${ASK_USER_TOOL_NAME}. ` +
          `Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${EXIT_PLAN_MODE_TOOL_NAME}.\n\n` +
          `Memory-only requests are not plan completion; do not call ${EXIT_PLAN_MODE_TOOL_NAME} for them.\n\n` +
          `NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${ASK_USER_TOOL_NAME} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`,
      ),
    ];
  }
}

/**
 * Plan mode reentry notification.
 * Emitted when the user re-enters plan mode (e.g. approved plan changes).
 */
export class PlanModeReentryAttachment extends BaseAttachment {
  readonly type = 'plan_mode_reentry' as const;
  declare planFilePath: string;

  constructor(data: AttachmentData<PlanModeReentryAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `## Re-entering Plan Mode\n\n` +
          `You are returning to plan mode after having previously exited it. ` +
          `A plan file exists at ${this.planFilePath} from your previous planning session.\n\n` +
          `**Before proceeding with any new planning, you should:**\n` +
          `1. Read the existing plan file to understand what was previously planned\n` +
          `2. Evaluate the user's current request against that plan\n` +
          `3. Decide how to proceed:\n` +
          `   - **Different task**: If the user's request is for a different task — even if it's similar or related — start fresh by overwriting the existing plan\n` +
          `   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections\n` +
          `4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ${EXIT_PLAN_MODE_TOOL_NAME}. If this is a memory-only request, do not update the plan file and do not call ${EXIT_PLAN_MODE_TOOL_NAME}; save or update memory if allowed, briefly acknowledge, and remain in plan mode.\n\n` +
          `Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`,
      ),
    ];
  }
}

/**
 * Plan mode exit notification.
 */
export class PlanModeExitAttachment extends BaseAttachment {
  readonly type = 'plan_mode_exit' as const;
  declare planFilePath: string;
  declare planExists: boolean;

  constructor(data: AttachmentData<PlanModeExitAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `## Exited Plan Mode\n\n` +
          `You have exited plan mode. You can now make edits, run tools, and take actions.` +
          (this.planExists && this.planFilePath
            ? `\nThe plan file is at ${this.planFilePath} — refer to it during implementation.`
            : ''),
      ),
    ];
  }
}

/**
 * Reminder to verify the plan before taking action.
 * Normalized as <system-reminder>.
 */
export class VerifyPlanReminderAttachment extends BaseAttachment {
  readonly type = 'verify_plan_reminder' as const;

  constructor(data: AttachmentData<VerifyPlanReminderAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `Please verify the current plan before proceeding with implementation. ` +
          `Check that the plan is still accurate and complete.`,
      ),
    ];
  }
}

function getPlanModeMemoryOnlyNote(): string {
  return (
    `## Memory-only Requests\n` +
    `If the user only asks you to remember, forget, or update memory, treat it as memory maintenance, not plan approval or plan completion.\n` +
    `- Do NOT call ${EXIT_PLAN_MODE_TOOL_NAME} for memory-only requests.\n` +
    `- Do NOT update the plan file for memory-only requests.\n` +
    `- Save or update memory if allowed, then briefly acknowledge and remain in plan mode.\n` +
    `Only call ${EXIT_PLAN_MODE_TOOL_NAME} when the user asks to approve, finish, or exit the plan, or when you have completed an implementation plan for approval.`
  );
}

function getPlanModeMemoryOnlyEndingException(): string {
  return `Memory-only requests are exempt from this ${ASK_USER_TOOL_NAME}/${EXIT_PLAN_MODE_TOOL_NAME} ending rule: briefly acknowledge and remain in plan mode without calling either tool.`;
}

// ── Plan Phase 4 variant helper ───────────────────────────────────────────────

/**
 * Returns the Phase 4 (Final Plan) instructions block for the given variant.
 *
 *   control — full context + approach + critical files + reused functions + verification (default)
 *   trim    — one-line context + file list + reusable functions + single command
 *   cut     — no context, one line per file change, single verification command (<40 lines)
 *   cap     — no context/prose, one bullet per file (file:line), hard 40-line limit
 */
function getPlanPhase4Instructions(
  variant: 'control' | 'trim' | 'cut' | 'cap',
): string {
  switch (variant) {
    case 'trim':
      return (
        `### Phase 4: Final Plan\n` +
        `Goal: Write a concise final plan to the plan file.\n` +
        `- One-line **Context**: what this change does and why\n` +
        `- List of files to modify (paths only)\n` +
        `- Reusable functions/utilities found (with file paths)\n` +
        `- Verification: single command to test end-to-end`
      );
    case 'cut':
      return (
        `### Phase 4: Final Plan\n` +
        `Goal: Write a minimal plan to the plan file. NO Context or Background section.\n` +
        `- One line per file change (path: what changes)\n` +
        `- Single verification command\n` +
        `- Good plans are under 40 lines — be ruthlessly concise`
      );
    case 'cap':
      return (
        `### Phase 4: Final Plan\n` +
        `Goal: Write an ultra-minimal plan to the plan file. NO Context. NO prose.\n` +
        `- One bullet per file in \`file:line\` format\n` +
        `- Single verification command\n` +
        `- **Hard limit: 40 lines total** — every word must earn its place`
      );
    default:
      // 'control' — full instructions
      return (
        `### Phase 4: Final Plan\n` +
        `Goal: Write your final plan to the plan file (the only file you can edit).\n` +
        `- Begin with a **Context** section: explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome\n` +
        `- Include only your recommended approach, not all alternatives\n` +
        `- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively\n` +
        `- Include the paths of critical files to be modified\n` +
        `- Reference existing functions and utilities you found that should be reused, with their file paths\n` +
        `- Include a verification section describing how to test the changes end-to-end`
      );
  }
}

/**
 * Phase 1 instructions. Without an available Explore agent the model explores
 * the codebase itself; otherwise it fans out to parallel subagents.
 */
function getPlanPhase1Instructions(exploreAgentAvailable: boolean): string {
  const exploreStep = exploreAgentAvailable
    ? `**Launch up to ${PLAN_MODE_EXPLORE_AGENT_COUNT} \`${EXPLORE_AGENT_NAME}\` agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning
   - Quality over quantity — ${PLAN_MODE_EXPLORE_AGENT_COUNT} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns`
    : 'Read and explore the relevant files directly to efficiently understand the codebase.';

  return `### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.${
    exploreAgentAvailable
      ? ` Critical: In this phase you should only use the \`${EXPLORE_AGENT_NAME}\` subagent type.`
      : ''
  }

1. Focus on understanding the user's request and the code associated with their request. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.

2. ${exploreStep}`;
}

/**
 * Phase 2 instructions. Without an available Plan agent the model designs the
 * approach itself; otherwise it delegates to parallel subagents.
 */
function getPlanPhase2Instructions(planAgentAvailable: boolean): string {
  // Both variants must describe the same design inputs — the only difference is
  // whether they are addressed to a Plan agent or to the model itself.
  const designInputs = (verb: string) =>
    `- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- ${verb} a detailed implementation plan`;

  if (!planAgentAvailable) {
    return `### Phase 2: Design
Goal: Design an implementation approach based on the user's intent and your exploration results from Phase 1.

${designInputs('Produce')}`;
  }

  const multiAgentGuidance =
    PLAN_MODE_AGENT_COUNT > 1
      ? `- **Multiple agents**: Use up to ${PLAN_MODE_AGENT_COUNT} agents for complex tasks that benefit from different perspectives

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are tricky edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture
`
      : '';

  return `### Phase 2: Design
Goal: Design an implementation approach.

Launch a \`${PLAN_AGENT_NAME}\` agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to ${PLAN_MODE_AGENT_COUNT} agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks — it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)
${multiAgentGuidance}
In the agent prompt:
${designInputs('Request')}`;
}

/**
 * Maximum number of Plan agents that may run in parallel during Phase 2.
 * Configurable via ENV_PLAN_MODE_AGENT_COUNT env var (default: 1).
 */
const PLAN_MODE_AGENT_COUNT: number = (() => {
  const n = parseInt(process.env[ENV_PLAN_MODE_AGENT_COUNT] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

/**
 * Maximum number of Explore agents that may run in parallel during Phase 1.
 * Configurable via ENV_PLAN_MODE_EXPLORE_AGENT_COUNT env var (default: 3).
 */
const PLAN_MODE_EXPLORE_AGENT_COUNT: number = (() => {
  const n = parseInt(process.env[ENV_PLAN_MODE_EXPLORE_AGENT_COUNT] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();
