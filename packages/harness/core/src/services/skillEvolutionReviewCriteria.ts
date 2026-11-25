/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SKILL_EVOLUTION_STRONG_SIGNALS = `Strong signals — if any applies, submit at least one suggestion with confidence >= 0.7:
- User corrected your method, scope, or output more than once
- User said "以后都这样做"/"下次注意"/"from now on"/"going forward"
- A rule in memory references a concrete tool call, fixed ID, time-range calculation, or output format
- You changed approach mid-way due to tool failure, wrong assumption, or user feedback
- A reusable 2+ step procedure emerged that another agent could execute verbatim
- An existing skill was invoked and extended at runtime: uncovered pagination, dedup, retry, parameter transform, output formatting, substituted commands, or broader scope
- An existing skill's name or description is misleading or narrower than its actual use`;

export const SKILL_EVOLUTION_UPDATE_AUDIT = `When an existing skill was invoked in this conversation, answer these three before concluding the skill already covers the workflow:
1. Did the agent add steps SKILL.md did not cover?
2. Did any SKILL.md command or tool call fail and require substitution?
3. Was the user's request within the skill's stated scope, or silently stretched?
If any answer is yes, submit action="update" with confidence >= 0.7.`;

export const SKILL_EVOLUTION_CREATE_AUDIT = `When no existing skill was invoked but the conversation produced a multi-step procedure, answer these three before concluding there is no skill candidate:
1. Did the user issue 2+ refinement turns reaching a stable output spec?
2. Did any tool call fail and require substitution?
3. Is the final flow a reproducible pipeline another agent could rerun verbatim?
If any answer is yes, submit action="create" with confidence >= 0.7.`;
