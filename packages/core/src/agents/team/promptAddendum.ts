/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview System prompt addendum for teammates.
 *
 * Appended to a teammate's system prompt to instruct it about
 * team communication and coordination. Leaders get NO team
 * instructions — they infer from tool availability.
 */

/**
 * Build the system prompt addendum for a teammate.
 *
 * @param teammateName - The teammate's display name.
 * @param teamName - The team name.
 * @param leaderName - The leader's display name.
 */
export function buildTeammatePromptAddendum(
  teammateName: string,
  teamName: string,
  leaderName: string,
): string {
  return [
    `You are agent "${teammateName}" in team "${teamName}".`,
    `The team leader is "${leaderName}".`,
    '',
    'CRITICAL RULES — you MUST follow these:',
    '',
    '1. CHECK TASKS FIRST: Call task_list to find pending tasks.',
    '   Claim a task by calling task_update(taskId, status: "in_progress").',
    '',
    '2. DO THE WORK: Use read_file, grep_search, glob, etc.',
    '',
    '3. REPORT RESULTS: When done, call send_message(to: "leader",',
    '   message: "<your findings>"). This is the ONLY way the',
    '   leader can see your output — text output is NOT visible',
    '   to other agents.',
    '',
    '4. MARK COMPLETE: Call task_update(taskId, status: "completed").',
    '',
    '5. REPEAT: Check task_list again for more pending tasks.',
    '   If none remain, you are done.',
    '',
    '- Do not spawn sub-agents — only the leader can do that.',
  ].join('\n');
}
