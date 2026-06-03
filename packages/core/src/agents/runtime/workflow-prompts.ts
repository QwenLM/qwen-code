/**
 * System prompts for workflow subagents.
 *
 * Verbatim from claude-code 2.1.160 binary's §XmO constant. Kept in its own
 * module so future phases (P3 schema mode, P5 budget guidance) can introduce
 * variant prompts without touching the orchestrator.
 */

/**
 * Base subagent prompt — used when no schema is set on agent() opts.
 * Tells the subagent its final text is the return value, not a human message.
 */
export const WORKFLOW_SUBAGENT_SYSTEM_PROMPT =
  'You are a subagent spawned by a workflow orchestration script. ' +
  'Use the tools available to complete the task.\n\n' +
  'NOTE: You are running inside a workflow script. Your final text response ' +
  'is returned verbatim as a string to the calling script — it is your ' +
  'return value, not a message to a human. Output the literal result; do ' +
  "not output confirmations like 'Done.' Be concise — the script will " +
  'parse your output.';
