/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ToolNames } from '../tools/tool-names.js';
import process from 'node:process';
import { QWEN_DIR } from '../config/storage.js';
import type { GenerateContentConfig } from '@google/genai';
import { InputFormat } from '../output/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { buildDefaultSystemPrompt } from './default-system-prompt.js';

const debugLogger = createDebugLogger('PROMPTS');

export type SystemPromptInteractionMode = 'interactive' | 'headless' | 'acp';

/**
 * Resolve the system-prompt interaction mode from a config. Single source of
 * truth for the ACP > interactive > headless precedence so callers that build
 * the core system prompt (generation and `/context` token estimation) cannot
 * drift apart. Uses a structural type to avoid a hard dependency on the full
 * Config class.
 */
export function resolveInteractionMode(config: {
  getExperimentalZedIntegration(): boolean;
  getInputFormat?(): string;
  isInteractive(): boolean;
}): SystemPromptInteractionMode {
  // ACP mode must match the runtime definition used by the question/permission
  // sites (askUserQuestion.ts, enterPlanMode.ts, coreToolScheduler.ts), which
  // treat a stream-json session as ACP-capable because the host can relay
  // questions and responses. Resolving stream-json to 'headless' here would
  // wrongly tell the model to never ask a question while the runtime still
  // allows 'ask_user_question'.
  if (
    config.getExperimentalZedIntegration() ||
    config.getInputFormat?.() === InputFormat.STREAM_JSON
  ) {
    return 'acp';
  }
  return config.isInteractive() ? 'interactive' : 'headless';
}

export function resolvePathFromEnv(envVar?: string): {
  isSwitch: boolean;
  value: string | null;
  isDisabled: boolean;
} {
  // Handle the case where the environment variable is not set, empty, or just whitespace.
  const trimmedEnvVar = envVar?.trim();
  if (!trimmedEnvVar) {
    return { isSwitch: false, value: null, isDisabled: false };
  }

  const lowerEnvVar = trimmedEnvVar.toLowerCase();
  // Check if the input is a common boolean-like string.
  if (['0', 'false', '1', 'true'].includes(lowerEnvVar)) {
    // If so, identify it as a "switch" and return its value.
    const isDisabled = ['0', 'false'].includes(lowerEnvVar);
    return { isSwitch: true, value: lowerEnvVar, isDisabled };
  }

  // If it's not a switch, treat it as a potential file path.
  let customPath = trimmedEnvVar;

  // Safely expand the tilde (~) character to the user's home directory.
  if (customPath.startsWith('~/') || customPath === '~') {
    try {
      const home = os.homedir(); // This is the call that can throw an error.
      if (customPath === '~') {
        customPath = home;
      } else {
        customPath = path.join(home, customPath.slice(2));
      }
    } catch (error) {
      // If os.homedir() fails, we catch the error instead of crashing.
      debugLogger.warn(
        `Could not resolve home directory for path: ${trimmedEnvVar}`,
        error,
      );
      // Return null to indicate the path resolution failed.
      return { isSwitch: false, value: null, isDisabled: false };
    }
  }

  // Return it as a non-switch with the fully resolved absolute path.
  return {
    isSwitch: false,
    value: path.resolve(customPath),
    isDisabled: false,
  };
}

/**
 * Processes a custom system instruction and optional explicit append content.
 * This function should only be used when there is actually a custom instruction.
 *
 * @param customInstruction - Custom system instruction (ContentUnion from @google/genai)
 * @param _userMemory - Retained for public API compatibility; runtime context
 * is no longer appended to the system prompt
 * @param appendInstruction - Extra instructions to append after the base
 * @returns Processed custom system instruction with append instructions applied
 */
export function getCustomSystemPrompt(
  customInstruction: GenerateContentConfig['systemInstruction'],
  _userMemory?: string,
  appendInstruction?: string,
): string {
  // Extract text from custom instruction
  let instructionText = '';

  if (typeof customInstruction === 'string') {
    instructionText = customInstruction;
  } else if (Array.isArray(customInstruction)) {
    // PartUnion[]
    instructionText = customInstruction
      .map((part) => (typeof part === 'string' ? part : part.text || ''))
      .join('');
  } else if (customInstruction && 'parts' in customInstruction) {
    // Content
    instructionText =
      customInstruction.parts
        ?.map((part) => (typeof part === 'string' ? part : part.text || ''))
        .join('') || '';
  } else if (customInstruction && 'text' in customInstruction) {
    // PartUnion (single part)
    instructionText = customInstruction.text || '';
  }

  return `${instructionText}${buildSystemPromptSuffix(appendInstruction)}`;
}

/**
 * The context, model, and interaction-mode positions remain because this
 * helper is publicly exported. They no longer affect the fixed base prompt.
 */
export function getCoreSystemPrompt(
  _userMemory?: string,
  _model?: string,
  appendInstruction?: string,
  _interactionMode?: SystemPromptInteractionMode,
): string {
  // if QWEN_SYSTEM_MD is set (and not 0|false), override system prompt from file
  // default path is .qwen/system.md (project-level), can be overridden via QWEN_SYSTEM_MD
  let systemMdEnabled = false;
  let systemMdPath = path.resolve(path.join(QWEN_DIR, 'system.md'));
  // Resolve the environment variable to get either a path or a switch value.
  const systemMdResolution = resolvePathFromEnv(process.env['QWEN_SYSTEM_MD']);

  // Proceed only if the environment variable is set and is not disabled.
  if (systemMdResolution.value && !systemMdResolution.isDisabled) {
    systemMdEnabled = true;

    // We update systemMdPath to this new custom path.
    if (!systemMdResolution.isSwitch) {
      systemMdPath = systemMdResolution.value;
    }

    // require file to exist when override is enabled
    if (!fs.existsSync(systemMdPath)) {
      throw new Error(`missing system prompt file '${systemMdPath}'`);
    }
  }

  // A QWEN_SYSTEM_MD override replaces the base prompt verbatim and is
  // intentionally not augmented with interaction-mode guidance: the override is
  // a full, user-owned prompt, so injecting our mode wording would defeat the
  // purpose of the override. Custom prompts are responsible for their own mode
  // awareness (e.g. not instructing the model to ask questions in headless
  // runs). `appendInstruction` below still applies in both branches.
  const basePrompt = systemMdEnabled
    ? fs.readFileSync(systemMdPath, 'utf8')
    : buildDefaultSystemPrompt();

  // if QWEN_WRITE_SYSTEM_MD is set (and not 0|false), write base system prompt to file
  const writeSystemMdResolution = resolvePathFromEnv(
    process.env['QWEN_WRITE_SYSTEM_MD'],
  );

  // Check if the feature is enabled. This proceeds only if the environment
  // variable is set and is not explicitly '0' or 'false'.
  if (writeSystemMdResolution.value && !writeSystemMdResolution.isDisabled) {
    const writePath = writeSystemMdResolution.isSwitch
      ? systemMdPath
      : writeSystemMdResolution.value;

    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, basePrompt);
  }

  const appendSuffix = buildSystemPromptSuffix(appendInstruction);

  return `${basePrompt}${appendSuffix}`;
}

function buildSystemPromptSuffix(text?: string): string {
  const trimmed = text?.trim();
  return trimmed ? `\n\n---\n\n${trimmed}` : '';
}

/**
 * Provides the system prompt for the history compression process.
 *
 * Asks the summary model to wrap its chain-of-thought in an `<analysis>`
 * block (stripped before the result enters history) and then emit a
 * `<state_snapshot>` XML envelope with 9 sub-sections aligned to
 * claude-code's compaction format: primary_request_and_intent,
 * key_technical_concepts, files_and_code_sections, errors_and_fixes,
 * problem_solving, all_user_messages, pending_tasks, current_work,
 * next_step.
 *
 * The resume trailer ("do not acknowledge the summary, ..." etc.) is
 * NOT in this prompt — it is appended once by `postProcessSummary` in
 * `postCompactAttachments.ts` so the summary model does not re-generate
 * it every compaction.
 */
export function getCompressionPrompt(): string {
  return `
You are the component that summarizes a conversation when its context window is about to overflow. The summary you produce will become the agent's ONLY memory of everything that happened before this point. The agent will resume its work based solely on this summary plus a small number of restored file / image attachments that follow.

First, wrap your reasoning in an <analysis> block. Inside it, walk through the conversation chronologically and identify, for each section: the user's explicit requests and intent, your approach to those requests, key decisions / technical concepts / code patterns, specific details (file names, code snippets, function signatures, file edits), errors and how they were fixed, and any specific user feedback — especially when the user told you to do something differently. The <analysis> block is stripped before the summary reaches the next agent; it is purely a drafting scratchpad to improve the summary that follows.

Then produce the final summary as the EXACT XML structure below. Be dense. Omit conversational filler.

<state_snapshot>
    <primary_request_and_intent>
        <!-- Capture all of the user's explicit requests and intents in detail. Quote the user's exact phrasing where intent is at stake. -->
    </primary_request_and_intent>

    <key_technical_concepts>
        <!-- List all important technical concepts, technologies, and frameworks discussed. -->
    </key_technical_concepts>

    <files_and_code_sections>
        <!-- Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages. Include full code snippets where applicable, and a summary of why this file read or edit is important. -->
    </files_and_code_sections>

    <errors_and_fixes>
        <!-- List every error encountered and how it was fixed. Include the verbatim error message when it was quoted to the agent. Pay special attention to specific user feedback on the error, especially if the user told you to do something differently. -->
    </errors_and_fixes>

    <problem_solving>
        <!-- Document problems solved and any ongoing troubleshooting efforts. -->
    </problem_solving>

    <all_user_messages>
        <!-- List ALL user messages that are not tool results, in chronological order. These are critical for understanding the user's feedback and shifting intent. Include short messages like "ok" or "continue" — they are signal. -->
    </all_user_messages>

    <pending_tasks>
        <!-- Outline any pending tasks that the user has explicitly asked the agent to work on but that are not yet complete. -->
    </pending_tasks>

    <current_work>
        <!-- Describe in detail precisely what the agent was working on immediately before this summary was requested, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable. -->
    </current_work>

    <next_step>
        <!-- List the single next step the agent will take, related to the most recent work. The step MUST be DIRECTLY in line with the user's most recent explicit request and the task the agent was working on immediately before this summary. If the last task was concluded, list a next step only if it is explicitly in line with the user's request — do NOT start tangential or older work without confirming with the user first. If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. -->
    </next_step>
</state_snapshot>
`.trim();
}

/**
 * Provides the system prompt for generating project summaries in markdown format.
 * This prompt instructs the model to create a structured markdown summary
 * that can be saved to a file for future reference.
 */
export function getProjectSummaryPrompt(): string {
  return `Please analyze the conversation history above and generate a comprehensive project summary in markdown format. Focus on extracting the most important context, decisions, and progress that would be valuable for future sessions. Generate the summary directly without using any tools.
You are a specialized context summarizer that creates a comprehensive markdown summary from chat history for future reference. The markdown format is as follows:

# Project Summary

## Overall Goal
<!-- A single, concise sentence describing the user's high-level objective -->

## Key Knowledge
<!-- Crucial facts, conventions, and constraints the agent must remember -->
<!-- Include: technology choices, architecture decisions, user preferences, build commands, testing procedures -->

## Recent Actions
<!-- Summary of significant recent work and outcomes -->
<!-- Include: accomplishments, discoveries, recent changes -->

## Current Plan
<!-- The current development roadmap and next steps -->
<!-- Use status markers: [DONE], [IN PROGRESS], [TODO] -->
<!-- Example: 1. [DONE] Set up WebSocket server -->

`.trim();
}

/**
 * Generates a system reminder message for plan mode operation.
 *
 * This function creates an internal system message that enforces plan mode constraints,
 * preventing the AI from making any modifications to the system until the user confirms
 * the proposed plan. It overrides other instructions to ensure read-only behavior.
 *
 * @returns A formatted system reminder string that enforces plan mode restrictions
 *
 * @example
 * ```typescript
 * const reminder = getPlanModeSystemReminder();
 * // Returns: "<system-reminder>Plan mode is active..."
 * ```
 *
 * @remarks
 * Plan mode ensures the AI will:
 * - Only perform read-only operations (research, analysis)
 * - Present a comprehensive plan via ExitPlanMode tool
 * - Wait for user confirmation before making any changes
 * - Override any other instructions that would modify system state
 */
export function getPlanModeSystemReminder(planOnly = false): string {
  return `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run tools classified as state-modifying (including changing configs or making commits), or otherwise make changes to the system. A shell command whose safety cannot be determined may run only after the user explicitly approves that exact invocation once, and only when it is necessary for the investigation. This supersedes any other instructions you have received (for example, to make edits).

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you cannot make alone, and refine your plan incrementally.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use read-only tools (${ToolNames.READ_FILE}, ${ToolNames.GREP}, ${ToolNames.GLOB}) to read code. Look for existing functions, utilities, and patterns to reuse. For broader or ambiguous tasks, use multiple parallel exploration passes (directly or via agents when appropriate) to understand different parts of the codebase.
2. **Capture findings** — After each discovery, immediately integrate what you learned into your evolving mental model. Do not wait until the end to synthesize.
3. **Ask the user** — When you hit an ambiguity or decision you cannot resolve from code alone, use ${ToolNames.ASK_USER_QUESTION}. Then go back to step 1.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then ask the user your first round of questions if any exist. Do not explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code
- Batch related questions together (use multi-question ${ToolNames.ASK_USER_QUESTION} calls)
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none

### Planning Principles

- Build a global understanding of how the relevant pieces fit together before deciding on local edits. Do not jump from the first relevant file straight into a plan when the task likely spans multiple files or behaviors.
- Design an implementation approach that fits the existing codebase rather than inventing a parallel pattern.
- Reference existing functions and utilities you found that should be reused, with their file paths.
- Include a verification section describing how to test the changes end-to-end.

### When a Tool is Blocked by Plan Mode

If a non-read-only tool is blocked:
- Do NOT retry the blocked tool or repeatedly attempt similar non-read-only tools
- Do NOT use wrappers, quoting tricks, aliases, or obfuscation to make a blocked write look unknown
- Do NOT immediately call exit_plan_mode just to unblock it — continue gathering context with read-only tools first
- Pivot to read-only tools (read_file, grep_search, glob, list_directory, agents) to gather the information the blocked tool would have provided
- Once you have enough context to form a complete plan, call exit_plan_mode

An exact one-off approval for an unknown shell command approves only that invocation. It does not approve the plan, authorize related commands, or exit Plan mode.

### When to Converge

Your plan is ready when you have addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes. Present your plan ${planOnly ? 'directly' : `by calling the ${ToolNames.EXIT_PLAN_MODE} tool, which will prompt the user to confirm the plan`}. Do NOT make any file changes or run any tools that modify the system state in any way until the user has confirmed the plan.
</system-reminder>`;
}

/**
 * Generates a system reminder about an active Arena session.
 *
 * @param configFilePath - Absolute path to the arena session's `config.json`
 * @returns A formatted system reminder string wrapped in XML tags
 */
export function getArenaSystemReminder(configFilePath: string): string {
  return `<system-reminder>An Arena session is active. For details, read: ${configFilePath}. This message is for internal use only. Do not mention this to user in your response.</system-reminder>`;
}

// ============================================================================
// Insight Analysis Prompts
// ============================================================================

type InsightPromptType =
  | 'analysis'
  | 'impressive_workflows'
  | 'project_areas'
  | 'future_opportunities'
  | 'friction_points'
  | 'memorable_moment'
  | 'improvements'
  | 'interaction_style'
  | 'at_a_glance';

const INSIGHT_PROMPTS: Record<InsightPromptType, string> = {
  analysis: `Analyze this Qwen Code session and extract structured facets.

CRITICAL GUIDELINES:

1. **goal_categories**: Count ONLY what the USER explicitly asked for.
   - DO NOT count Qwen's autonomous codebase exploration
   - DO NOT count work Qwen decided to do on its own
   - ONLY count when user says "can you...", "please...", "I need...", "let's...
   - POSSIBLE CATEGORIES (but be open to others that appear in the data):
      - bug_fix
      - feature_request
      - debugging
      - test_creation
      - code_refactoring
      - documentation_update
   "

2. **user_satisfaction_counts**: Base ONLY on explicit user signals.
   - "Yay!", "great!", "perfect!" → happy
   - "thanks", "looks good", "that works" → satisfied
   - "ok, now let's..." (continuing without complaint) → likely_satisfied
   - "that's not right", "try again" → dissatisfied
   - "this is broken", "I give up" → frustrated

3. **friction_counts**: Be specific about what went wrong.
   - misunderstood_request: Qwen interpreted incorrectly
   - wrong_approach: Right goal, wrong solution method
   - buggy_code: Code didn't work correctly
   - user_rejected_action: User said no/stop to a tool call
   - excessive_changes: Over-engineered or changed too much

4. If very short or just warmup, use warmup_minimal for goal_category`,

  impressive_workflows: `Analyze this Qwen Code usage data and identify what's working well for this user. Use second person ("you").

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "intro": "1 sentence of context",
  "impressive_workflows": [
    {"title": "Short title (3-6 words)", "description": "2-3 sentences describing the impressive workflow or approach. Use 'you' not 'the user'."}
  ]
}

Include 3 impressive workflows.`,

  project_areas: `Analyze this Qwen Code usage data and identify project areas.

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "areas": [
    {"name": "Area name", "session_count": N, "description": "2-3 sentences about what was worked on and how Qwen Code was used."}
  ]
}

Include 4-5 areas. Skip internal QC operations.`,

  future_opportunities: `Analyze this Qwen Code usage data and identify future opportunities.

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "intro": "1 sentence about evolving AI-assisted development",
  "opportunities": [
    {"title": "Short title (4-8 words)", "whats_possible": "2-3 ambitious sentences about autonomous workflows", "how_to_try": "1-2 sentences mentioning relevant tooling", "copyable_prompt": "Detailed prompt to try"}
  ]
}

Include 3 opportunities. Think BIG - autonomous workflows, parallel agents, iterating against tests.`,

  friction_points: `Analyze this Qwen Code usage data and identify friction points for this user. Use second person ("you").

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "intro": "1 sentence summarizing friction patterns",
  "categories": [
    {"category": "Concrete category name", "description": "1-2 sentences explaining this category and what could be done differently. Use 'you' not 'the user'.", "examples": ["Specific example with consequence", "Another example"]}
  ]
}

Include 3 friction categories with 2 examples each.`,

  memorable_moment: `Analyze this Qwen Code usage data and find a memorable moment.

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "headline": "A memorable QUALITATIVE moment from the transcripts - not a statistic. Something human, funny, or surprising.",
  "detail": "Brief context about when/where this happened"
}

Find something genuinely interesting or amusing from the session summaries.`,

  improvements: `Analyze this Qwen Code usage data and suggest improvements.

## QC FEATURES REFERENCE (pick from these for features_to_try):
1. **MCP Servers**: Connect Qwen to external tools, databases, and APIs via Model Context Protocol.
   - How to use: Run \`qwen mcp add --transport http <server-name> <http-url>\`
   - Good for: database queries, Slack integration, GitHub issue lookup, connecting to internal APIs
   - Example: "To connect to GitHub, run \`qwen mcp add --header "Authorization: Bearer your_github_mcp_pat" --transport http github https://api.githubcopilot.com/mcp/\` and set the AUTHORIZATION header with your PAT. Then you can ask Qwen to query issues, PRs, or repos."

2. **Custom Skills**: Reusable prompts you define as markdown files that run with a single /command.
   - How to use: Create \`.qwen/skills/commit/SKILL.md\` with instructions. Then type \`/commit\` to run it.
   - Good for: repetitive workflows - /commit, /review, /test, /deploy, /pr, or complex multi-step workflows
   - SKILL.md format:
    \`\`\`
    ---
    name: skill-name
    description: A description of what this skill does and when to use it.
    ---

    # Steps
    1. First, do X.
    2. Then do Y.
    3. Finally, verify Z.

    # Examples
    - Input: "fix lint errors in src/" → Output: runs eslint --fix, commits changes
    - Input: "review this PR" → Output: reads diff, posts inline comments

    # Edge Cases
    - If no files match, report "nothing to do" instead of failing.
    - If the user didn't specify a branch, default to the current branch.
    \`\`\`

3. **Headless Mode**: Run Qwen non-interactively from scripts and CI/CD.
   - How to use: \`qwen -p "fix lint errors"\`
   - Good for: CI/CD integration, batch code fixes, automated reviews

4. **Task Agents**: Qwen spawns focused sub-agents for complex exploration or parallel work.
   - How to use: Qwen auto-invokes when helpful, or ask "use an agent to explore X"
   - Good for: codebase exploration, understanding complex systems

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "Qwen_md_additions": [
    {"addition": "A specific line or block to add to QWEN.md based on workflow patterns. E.g., 'Always run tests after modifying auth-related files'", "why": "1 sentence explaining why this would help based on actual sessions", "prompt_scaffold": "Instructions for where to add this in QWEN.md. E.g., 'Add under ## Testing section'"}
  ],
  "features_to_try": [
    {"feature": "Feature name from QC FEATURES REFERENCE above", "one_liner": "What it does", "why_for_you": "Why this would help YOU based on your sessions", "example_code": "Actual command or config to copy"}
  ],
  "usage_patterns": [
    {"title": "Short title", "suggestion": "1-2 sentence summary", "detail": "3-4 sentences explaining how this applies to YOUR work", "copyable_prompt": "A specific prompt to copy and try"}
  ]
}

IMPORTANT for Qwen_md_additions: PRIORITIZE instructions that appear MULTIPLE TIMES in the user data. If user told Qwen the same thing in 2+ sessions (e.g., 'always run tests', 'use TypeScript'), that's a PRIME candidate - they shouldn't have to repeat themselves.

IMPORTANT for features_to_try: Pick 2-3 from the QC FEATURES REFERENCE above. Include 2-3 items for each category.`,

  interaction_style: `Analyze this Qwen Code usage data and describe the user's interaction style.

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "narrative": "2-3 paragraphs analyzing HOW the user interacts with Qwen Code. Use second person 'you'. Describe patterns: iterate quickly vs detailed upfront specs? Interrupt often or let Qwen run? Include specific examples. Use **bold** for key insights.",
  "key_pattern": "One sentence summary of most distinctive interaction style"
}
`,

  at_a_glance: `You're writing an "At a Glance" summary for a Qwen Code usage insights report for Qwen Code users. The goal is to help them understand their usage and improve how they can use Qwen better, especially as models improve.

Use this 4-part structure:

1. **What's working** - What is the user's unique style of interacting with Qwen and what are some impactful things they've done? You can include one or two details, but keep it high level since things might not be fresh in the user's memory. Don't be fluffy or overly complimentary. Also, don't focus on the tool calls they use.

2. **What's hindering you** - Split into (a) Qwen's fault (misunderstandings, wrong approaches, bugs) and (b) user-side friction (not providing enough context, environment issues -- ideally more general than just one project). Be honest but constructive.

3. **Quick wins to try** - Specific Qwen Code features they could try from the examples below, or a workflow technique if you think it's really compelling. (Avoid stuff like "Ask Qwen to confirm before taking actions" or "Type out more context up front" which are less compelling.)

4. **Ambitious workflows for better models** - As we move to much more capable models over the next 3-6 months, what should they prepare for? What workflows that seem impossible now will become possible? Draw from the appropriate section below.

Keep each section to 2-3 not-too-long sentences. Don't overwhelm the user. Don't mention specific numerical stats or underlined_categories from the session data below. Use a coaching tone.

Call respond_in_schema function with A VALID JSON OBJECT as argument:
{
  "whats_working": "(refer to instructions above)",
  "whats_hindering": "(refer to instructions above)",
  "quick_wins": "(refer to instructions above)",
  "ambitious_workflows": "(refer to instructions above)"
}`,
};

/**
 * Get an insight analysis prompt by type.
 * @param type - The type of insight prompt to retrieve
 * @returns The prompt string for the specified type
 */
export function getInsightPrompt(type: InsightPromptType): string {
  return INSIGHT_PROMPTS[type];
}
