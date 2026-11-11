/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns the description for `Skill`.
 */
export function getActivateSkillDescription(): string {
  return `Invoke a skill.

A skill is a packaged set of instructions configured by the user, project, or a plugin for a particular kind of task. Available skills appear in system-reminder messages with one-line descriptions. When the current task is covered by a listed skill, call this tool first so the skill's instructions can be loaded and followed in place of the default approach. Some skills run in an isolated subagent and return the completed result. Users may also request a skill by name (\`/<name>\`, or "slash command").

- \`skill\`: exact name from the available skill listing, without a leading slash. Plugin skills use the fully qualified \`plugin:skill\` name.
- \`args\`: optional arguments to pass through.

Only invoke skills from the available listing. Built-in CLI commands (\`/help\`, \`/clear\`, etc.) are not skills. If a \`<command-name>\` block is already present in the current turn, the skill has already been loaded; follow its instructions directly instead of invoking it again.`;
}
