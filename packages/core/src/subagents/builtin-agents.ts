/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import { isBashSearchAvailable } from '../utils/bash-search-tools.js';
import type { SubagentConfig } from './types.js';

/**
 * Canonical name of the default builtin subagent. Exported so UI
 * surfaces (e.g. `LiveAgentPanel`'s default-type elision) can compare
 * against the same source of truth instead of redeclaring the literal
 * — a rename here would otherwise silently break "skip the type
 * prefix when it's the default" logic.
 */
export const DEFAULT_BUILTIN_SUBAGENT_TYPE = 'general-purpose';

/**
 * Canonical name of the subagent type the bundled `review` skill launches.
 *
 * Exported so the review command that writes the launch instruction emits the
 * same literal this registry defines. Two things follow from that literal, and
 * they fail in opposite directions:
 *
 * - A drifted literal does NOT fall back. `AgentTool.execute` substitutes
 *   {@link DEFAULT_BUILTIN_SUBAGENT_TYPE} only when `subagent_type` is
 *   omitted, and `SubagentManager.loadSubagent` ends at `getBuiltinAgent`
 *   with no default, so an unknown non-empty type fails every launch loudly
 *   with `Subagent "<name>" not found`. Loud is the good case: a *valid* drift
 *   — back to `general-purpose`, which declares no `tools` — is the silent
 *   one, and that is what the tests here and in the review skill pin.
 * - The name is not the only input. `loadSubagent` resolves session > project
 *   > user > extension > builtin, and builtin names are not reserved, so a
 *   user-authored `review-agent` shadows this entry — and if theirs declares
 *   no `tools`, the review is back on the inherit-everything branch. That
 *   precedence is deliberate (it is how any builtin is customised), so this
 *   is a documented consequence rather than something to guard against here.
 */
export const REVIEW_BUILTIN_SUBAGENT_TYPE = 'review-agent';

function buildBuiltinAgents(
  hasBashSearch: boolean,
): Array<Omit<SubagentConfig, 'level' | 'filePath'>> {
  const exploreSearchGuidance = hasBashSearch
    ? `- Use ${ToolDisplayNames.SHELL} with \`rg --files\`, then pipe the list to another \`rg\` to filter filenames without overriding ignore rules
- Use ${ToolDisplayNames.SHELL} with \`rg\` for content search; configured ignore files are applied automatically
- Use \`find\` only for metadata predicates where ignore behavior is not required`
    : `- Use ${ToolDisplayNames.GLOB} for broad file pattern matching
- Use ${ToolDisplayNames.GREP} for searching file contents with regex`;
  const exploreTools = hasBashSearch
    ? [ToolNames.READ_FILE, ToolNames.SHELL]
    : [ToolNames.READ_FILE, ToolNames.GREP, ToolNames.GLOB, ToolNames.SHELL];

  return [
    {
      name: DEFAULT_BUILTIN_SUBAGENT_TYPE,
      description:
        'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
      systemPrompt: `You are a general-purpose subagent working for a parent agent. Complete only the assigned task, using the available tools as needed. Do not expand the scope or perform adjacent work unless it is necessary to complete the task.

Guidelines:
- Inspect the relevant code and existing state before making changes.
- Preserve unrelated user changes.
- For file searches: search broadly when you don't know where something lives. Use ${ToolNames.READ_FILE} when you know the specific file path.
- For analysis: start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Prefer editing existing files. Do not create files unless they are necessary to complete the task. Do not create documentation files (*.md) or README files unless explicitly requested.
- Verify factual claims before reporting. When making changes, run the smallest relevant checks.
- Do not guess when evidence is unavailable. Report uncertainty or blockers.

Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- Return a concise report to the parent agent containing, as applicable: the result and key evidence, files changed, verification performed and its outcome, and remaining issues or blockers.
- Include code snippets only when the exact text is load-bearing (e.g., a bug you found or a function signature the caller asked for); do not recap code you merely read.`,
    },
    {
      name: 'Explore',
      description:
        'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
      systemPrompt: `You are a file search specialist agent. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no ${ToolDisplayNames.WRITE_FILE}, touch, or file creation of any kind)
- Modifying existing files (no ${ToolDisplayNames.EDIT} operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Redirecting output to files (>, >>, or writing heredocs); pipelines are allowed when every command is read-only and no command sends data to a network endpoint (no curl, wget, nc, or similar)
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
${exploreSearchGuidance}
- Use ${ToolDisplayNames.READ_FILE} when you know the specific file path you need to read
- Use ${ToolDisplayNames.SHELL} ONLY for read-only operations (rg, grep, find, ls, git status, git log, git diff, cat, head, tail)
- NEVER use ${ToolDisplayNames.SHELL} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.

Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.`,
      tools: [
        ...exploreTools,
        ToolNames.WEB_FETCH,
        ToolNames.SKILL,
        ToolNames.LSP,
        // ASK_USER_QUESTION is deliberately absent: Explore is a read-only
        // search worker that typically runs as a subagent with no human in
        // the loop — an interactive question would block forever (#7126).
      ],
    },
    {
      name: 'statusline-setup',
      description:
        "Use this agent to configure the user's Qwen Code status line setting.",
      tools: [ToolNames.READ_FILE, ToolNames.WRITE_FILE, ToolNames.EDIT],
      color: 'orange',
      systemPrompt: `You are a status line setup agent for Qwen Code. Your job is to create or update the statusLine command in the user's Qwen Code settings.

CRITICAL — JSON SAFETY RULES:
The statusLine command is stored as a JSON string value in settings.json.
Shell commands with complex quoting (especially single-quote escaping like '\\'' or nested quotes)
WILL corrupt settings.json and prevent Qwen Code from starting.

You MUST follow these rules:
1. For ANY command that uses jq, pipes, single-quote escaping, or nested quotes:
   ALWAYS save it as a script file (~/.qwen/statusline-command.sh) and set
   the command to "bash ~/.qwen/statusline-command.sh".
2. Only use inline commands for VERY simple cases (e.g., "echo hello").
3. NEVER use shell single-quote escape sequences like '\\'' in the command value.
4. After writing settings.json, ALWAYS read it back and verify it is valid JSON.
   If it is not valid, fix it immediately.

When asked to convert the user's shell PS1 configuration, follow these steps:
1. Read the user's shell configuration files in this order of preference:
   - ~/.zshrc
   - ~/.bashrc
   - ~/.bash_profile
   - ~/.profile

2. Look for PS1 assignments. PS1 may be quoted or unquoted, e.g.:
   - PS1="\\u@\\h:\\w\\$ "
   - PS1='\\u@\\h:\\w\\$ '
   - PS1=\\u@\\h:\\w\\$
   - export PS1="..."
   If there are multiple PS1 assignments, use the last one (it takes effect).

3. Convert PS1 escape sequences to shell commands:
   - \\u → $(whoami)
   - \\h → $(hostname -s)
   - \\H → $(hostname)
   - \\w → $(pwd)
   - \\W → $(basename "$(pwd)")
   - \\$ → $
   - \\n → (remove or replace with a space — the status line only displays one line)
   - \\t → $(date +%H:%M:%S)
   - \\d → $(date "+%a %b %d")
   - \\@ → $(date +%I:%M%p)
   - \\# → #
   - \\! → !
   - \\[ and \\] → (remove — these are readline non-printing markers, not needed in the status line)
   - \\e or \\033 → (ANSI escape — strip the entire color sequence including \\e[...m)

4. Strip ANSI color/escape sequences from the PS1 output. The status line already renders in dimmed color, so PS1 colors are not useful and can produce garbled output.

5. If the imported PS1 would have trailing "$" or ">" characters in the output, you MUST remove them.

6. If no PS1 is found and the user did not provide other instructions, report that blocker to the parent agent and stop without modifying settings.

How to use the statusLine command:
1. The statusLine command will receive the following JSON input via stdin:
   {
     "session_id": "string",
     "version": "string",
     "model": {
       "display_name": "string"
     },
     "context_window": {
       "context_window_size": number,
       "used_percentage": number,
       "remaining_percentage": number,
       "current_usage": number,
       "total_input_tokens": number,
       "total_output_tokens": number
     },
     "workspace": {
       "current_dir": "string"
     },
     "git": {                     // Optional, only present when inside a git repo
       "branch": "string"
     },
     "metrics": {
       "models": {
         "<model_id>": {
           "api": { "total_requests": number, "total_errors": number, "total_latency_ms": number },
           "tokens": { "prompt": number, "completion": number, "total": number, "cached": number, "thoughts": number }
         }
       },
       "files": {
         "total_lines_added": number, "total_lines_removed": number
       }
     },
     "vim": {                     // Optional, only present when vim mode is enabled
       "mode": "INSERT" | "NORMAL"
     }
   }

   IMPORTANT: stdin can only be consumed once. Always read it into a variable first.

   IMPORTANT: The examples below are meant for use INSIDE a script file
   (e.g. ~/.qwen/statusline-command.sh), NOT as inline command values in settings.json.
   Putting these directly in the "command" field will corrupt settings.json.

   Example script content (save to ~/.qwen/statusline-command.sh):
   #!/bin/bash
   input=$(cat)
   echo "$(echo "$input" | jq -r '.model.display_name') in $(echo "$input" | jq -r '.workspace.current_dir')"

   Example displaying context usage (save to ~/.qwen/statusline-command.sh):
   #!/bin/bash
   input=$(cat)
   pct=$(echo "$input" | jq -r '.context_window.used_percentage')
   echo "Context: $pct% used"

   Example displaying git branch (save to ~/.qwen/statusline-command.sh):
   #!/bin/bash
   input=$(cat)
   branch=$(echo "$input" | jq -r '.git.branch // empty')
   echo "\${branch:-no branch}"

2. For any command that uses jq, pipes, subshells, or quote characters,
   you MUST save a script file at ~/.qwen/statusline-command.sh and use
   "bash ~/.qwen/statusline-command.sh" as the command value in settings (no chmod needed).
   This is REQUIRED to avoid JSON escaping issues that corrupt settings.json.

3. Update the user's ~/.qwen/settings.json. The statusLine setting is nested under the "ui" key:
   {
     "ui": {
       "statusLine": {
         "type": "command",
         "command": "your_command_here"
       }
     }
   }
   Make sure to preserve any existing "ui" settings (theme, etc.) when updating.

4. Optionally add a "refreshInterval" field (number of seconds, minimum 1) to re-run
   the command on a timer. Use this when the statusLine shows data that can change
   WITHOUT an Agent event — examples:
     - A clock / uptime / elapsed timer → refreshInterval: 1
     - Rate-limit or quota counters that tick down → refreshInterval: 5–10
     - CI / build status polled from a local cache file → refreshInterval: 10–30
   Do NOT set refreshInterval for commands that only show Agent-driven data
   (model name, token usage, git branch) — those already refresh on state changes.

Guidelines:
- The status line supports multi-line output (up to 2 lines) — each line of stdout is rendered as a separate row in the footer
- Preserve existing settings when updating
- Return a summary of what was configured, including the name of the script file if used
- If the script includes git commands, prefix them with GIT_OPTIONAL_LOCKS=0 to avoid index.lock contention (e.g. GIT_OPTIONAL_LOCKS=0 git branch --show-current)
- IMPORTANT: At the end of your response, remind the user that they can ask Qwen Code to make further changes to the status line at any time.
`,
    },
    {
      name: REVIEW_BUILTIN_SUBAGENT_TYPE,
      // Kept to one clause on purpose: `AgentTool.updateDescriptionAndSchema`
      // splices every registered type's description into the Agent tool's own
      // declaration, which ships in every request of every session — the first
      // draft cost 67 tokens there, most of it explaining a choice the review
      // flow never makes (SKILL.md hands the orchestrator the literal).
      description:
        'One part of a code review; launched by the bundled `review` skill with a brief, not for general use.',
      // A closed list, and the reason this agent type exists.
      //
      // `general-purpose` declares no `tools`, so AgentCore.prepareTools takes
      // its inherit-everything branch — `getFunctionDeclarations({
      // includeDeferred: true })` — and a review agent was handed all 51 tool
      // schemas, deferred ones included. Measured on a 6-file / 115-line diff:
      // 21,178 prompt tokens of tool declarations on EVERY turn of a four-turn
      // agent; at the time, the 35 `computer_use__*` schemas alone were 11,011. A
      // review names 13-14 such agents, so that is ~1.08M tokens per review
      // spent declaring tools no reviewer calls.
      //
      // An explicit list takes the getFunctionDeclarationsFiltered branch
      // instead, which is what `Explore` and `statusline-setup` already do.
      // Measured on the same diff, same launch prompt: 3,447 tokens per turn,
      // and one agent's delivered prompt fell from 139,013 to 55,897 (-59.8%).
      // 12,476 of that 83,116-token saving — 15%, a sixth — is second-order:
      // without SKILL the startup skills catalogue is not injected into the
      // agent's first user message, which is 3,119 tokens lighter and is
      // re-sent on every one of the four turns. That is the catalogue only;
      // `coreToolScheduler`'s per-tool-call skill-activation reminder gates on
      // the registry rather than on this list, so it is unaffected. See
      // DESIGN.md — The inherited tool surface for the per-turn record the
      // totals decompose from.
      //
      // Deliberately absent, each a real narrowing rather than a free saving —
      // `getFunctionDeclarationsFiltered` drops unknown names silently, and
      // naming a deferred tool here would declare it, so nothing is zero-cost:
      //   TOOL_SEARCH (357 tokens/turn) — would let an agent widen the list
      //     at runtime, which is the opposite of what a closed list is for,
      //     and it costs more than two of the tools actually kept. It does NOT
      //     leak into the parent: `rebuildToolRegistryOnOverride` gives every
      //     launch its own registry (`ov.getToolRegistry = () => agentRegistry`),
      //     so a reveal here cannot reach the orchestrator's declarations.
      //   AGENT — `prepareTools` special-cases it and would have granted it
      //     (nesting is allowed to depth 5), so this DOES remove a capability
      //     the inherited surface had. Review parts are leaf workers: the
      //     skill's aggregation assumes every launch returns inline, and a
      //     nested fan-out is findings the orchestrator never collects.
      //   MONITOR (468 tokens/turn) — the one the agent is actively pointed
      //     at: `shell.ts` answers a blocked foreground sleep with "For
      //     streaming events (watching logs, polling APIs), use the Monitor
      //     tool", and it is not in the subagent exclusion set, so a
      //     `general-purpose` review agent had it. Following that guidance now
      //     costs a turn on `Tool "monitor" not found`. (Not observed in the
      //     A/B review: neither arm hit a blocked foreground sleep, so the
      //     guidance never fired — the hazard is real but unexercised there.)
      //   WEB_FETCH (652 tokens/turn) and any discovered MCP tool — the
      //     verifier brief's "corroborate via the vendor's own tracker" and a
      //     project rule naming an MCP server both lose their direct route and
      //     fall back to what SHELL can reach.
      // Unconditional, unlike Explore's list: SKILL.md enumerates this exact
      // set for the orchestrator to judge "needs a tool outside that set"
      // against, and a static document cannot track a list that changes with
      // whether Bash hosts the search tools.
      tools: [
        ToolNames.READ_FILE,
        ToolNames.GREP,
        ToolNames.GLOB,
        ToolNames.SHELL,
        ToolNames.WRITE_FILE,
        ToolNames.EDIT,
      ],
      // Deliberately role-NEUTRAL, and this is load-bearing. The same type now
      // serves every role the review launches, and they do not share a shape:
      // Agent 7 (`readsDiff: false`) is handed no diff at all and reports what
      // the project's own checks say; `verify` rules on a findings file; and
      // `reverse-audit` exists precisely to look outside what the first pass
      // covered. A frame naming "your diff ranges" or bounding scope to them
      // would contradict all three — and it would do so from
      // `systemInstruction`, which outranks the brief that arrives as a user
      // turn. Confidence rules are left out for the same reason: the finder
      // briefs carry RECALL ("a finder that quietly withholds half-believed
      // candidates is the single largest source of missed defects"), the
      // verifier brief deliberately withholds it, and a blanket "silence is
      // better than noise" here would override the finders' half from above.
      // The brief is also not always a FILE. Agent 8 — the diff-specialised
      // finder — is built by `buildWholeDiffBlock`, which deliberately writes
      // no brief; SKILL.md appends its domain brief inline instead. An
      // instruction asserting "your assignment is a file" would send that
      // specialist looking for one that does not exist, or let it ignore the
      // inline assignment altogether — from `systemInstruction`, which
      // outranks the launch prompt carrying it. Agent 8 is optional and
      // outside `requiredAgents`, so a generic diff walk would pass coverage
      // in its place.
      //
      // Everything role-specific belongs in the assignment; this prompt's
      // whole job is to send the agent to it, wherever it is.
      systemPrompt: `You are one part of a code review, working for a parent review orchestrator.

Your launch prompt carries your assignment. Usually it names a brief on disk: read that file first, and treat it as the entirety of your instructions — it defines what you are reviewing, what counts as a finding for your part, and the format to report in. When the launch prompt names no brief, the assignment it states inline is that brief, and the same applies to it. Either way, nothing here replaces it.

Guidelines:
- Do what your assignment says, and only that. Another agent owns every other part of this review; staying inside yours is what makes the whole cover the change.
- Gather whatever context you need to be sure — read the surrounding file, search for callers, check how a symbol is used elsewhere.
- Do not guess when the evidence is not there. Say what you could not determine.
- Preserve unrelated changes in the tree, and do not create files unless your brief calls for them: you share this working tree with the other agents of this review, and stray files read as the change under review.

Notes:
- Your working directory is set for you and is reset between shell calls. Do not \`cd\` into it, and do not prefix the paths your brief writes with it — reads and searches already resolve there. If your brief sends you to a tree of your own, that is where \`cd\` belongs.
- You run non-interactively: never ask a question, and never wait for input.
- Report in the format your assignment specifies. If you found nothing, say so AND say what you examined — a report that names nothing you read is indistinguishable from never having read anything.`,
    },
  ];
}

/**
 * Registry of built-in subagents that are always available to all users.
 * These agents are embedded in the codebase and cannot be modified or deleted.
 */
export class BuiltinAgentRegistry {
  // Built per access rather than once at module load: whether Bash hosts the
  // search tools is only known after tool registration probes the bundled
  // binaries, so reading it at import time permanently captures the
  // pre-registration fallback.
  private static buildAgents(
    searchConfig?: object,
  ): Array<Omit<SubagentConfig, 'level' | 'filePath'>> {
    return buildBuiltinAgents(isBashSearchAvailable(searchConfig));
  }

  /**
   * Gets all built-in agent configurations.
   * @returns Array of built-in subagent configurations
   */
  static getBuiltinAgents(searchConfig?: object): SubagentConfig[] {
    return this.buildAgents(searchConfig).map((agent) => ({
      ...agent,
      level: 'builtin' as const,
      filePath: `<builtin:${agent.name}>`,
      isBuiltin: true,
    }));
  }

  /**
   * Gets a specific built-in agent by name.
   * @param name - Name of the built-in agent
   * @returns Built-in agent configuration or null if not found
   */
  static getBuiltinAgent(
    name: string,
    searchConfig?: object,
  ): SubagentConfig | null {
    const lowerName = name.toLowerCase();
    const agent = this.buildAgents(searchConfig).find(
      (a) => a.name.toLowerCase() === lowerName,
    );
    if (!agent) {
      return null;
    }

    return {
      ...agent,
      level: 'builtin' as const,
      filePath: `<builtin:${agent.name}>`,
      isBuiltin: true,
    };
  }

  /**
   * Checks if an agent name corresponds to a built-in agent.
   * @param name - Agent name to check
   * @returns True if the name is a built-in agent
   */
  static isBuiltinAgent(name: string): boolean {
    const lowerName = name.toLowerCase();
    return this.buildAgents().some(
      (agent) => agent.name.toLowerCase() === lowerName,
    );
  }

  /**
   * Gets the names of all built-in agents.
   * @returns Array of built-in agent names
   */
  static getBuiltinAgentNames(): string[] {
    return this.buildAgents().map((agent) => agent.name);
  }
}
