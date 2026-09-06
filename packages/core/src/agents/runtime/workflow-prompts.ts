/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System prompts for workflow subagents.
 *
 * Verbatim from claude-code 2.1.160 binary's §XmO constant (confirmed via
 * `strings -a -n 6 <binary> | rg "You are a subagent spawned by a workflow"`).
 * Kept in its own module so future phases (P3 schema mode via §ZmO, P5 budget
 * guidance) can introduce variant prompts without touching the orchestrator.
 */

/**
 * Base subagent prompt — used when no schema is set on agent() opts.
 *
 * VERBATIM from claude-code 2.1.160 binary §XmO. The five bullet points are
 * load-bearing for subagent behavior alignment:
 *  - "Output the literal result" — discourages explanatory text
 *  - "raw JSON ... no code fences" — critical for schema-returning agents in P3
 *  - "Do NOT use SendUserMessage" — closes the back-channel escape hatch
 *  - "Be concise" — bounds token cost
 *
 * P1 omits the §ZmO variant (schema-mode) because P1 throws on agent({schema}).
 * When P3 adds StructuredOutput, add WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA
 * here as a separate const.
 */
export const WORKFLOW_SUBAGENT_SYSTEM_PROMPT =
  'You are a subagent spawned by a workflow orchestration script. ' +
  'Use the tools available to complete the task.\n' +
  'CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.\n' +
  '- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."\n' +
  '- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.\n' +
  '- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.\n' +
  '- Be concise. The script will parse your output.';

/**
 * Schema-mode subagent prompt — used when `agent({schema})` enforces the
 * StructuredOutput contract. The `structured_output` tool's own description
 * (see tools/syntheticOutput.ts) already tells the model the tool ends the
 * session on the first valid call; this prompt reinforces that the FINAL
 * answer must travel through that tool, not through plain text.
 *
 * Aligns with upstream Claude Code 2.1.168 §ZmO constant in spirit (binary
 * verbatim is not yet captured — the load-bearing fragments are: must call
 * the tool, args must validate, no plain-text fallback, no SendUserMessage).
 */
export const WORKFLOW_SUBAGENT_SYSTEM_PROMPT_WITH_SCHEMA =
  'You are a subagent spawned by a workflow orchestration script. ' +
  'Use the tools available to complete the task.\n' +
  'CRITICAL: You MUST deliver your final answer by calling the ' +
  '`structured_output` tool with arguments that conform to its parameter schema. ' +
  'Plain-text final answers are DISCARDED — only a valid `structured_output` ' +
  'call returns a result to the calling script.\n' +
  '- Use other tools (Read, Grep, etc.) to gather information first.\n' +
  '- When ready, call `structured_output` ONCE with the conforming JSON object.\n' +
  '- If validation fails, the error tells you what to fix. Try again with corrected fields.\n' +
  '- After two failed attempts, the run terminates — get the arguments right.\n' +
  '- Do NOT use SendUserMessage to deliver your answer.\n' +
  '- Be concise; the script reads only the structured payload, not your prose.';
