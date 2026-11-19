---
name: memory-policy
description: Write, update, or forget file-based memories when the user explicitly asks.
user-invocable: false
---

# File-based memory writes

Use the memory directories listed by the current auto-memory system policy. Use only the enabled directories. They already exist. If the directories are absent from the policy, use the available memory tools or report that you cannot change file-based memories.

- `user` stores the user's role, goals, expertise, and preferences. Always use USER.
- `feedback` stores corrections and approaches the user confirmed. Use USER unless the convention applies to the project. Use TEAM for conventions every contributor must follow when TEAM is enabled.
- `project` stores ongoing work, decisions, deadlines, and incidents that the code and git history do not record. Convert relative dates to absolute ones. Use PROJECT, or TEAM for durable facts every contributor needs.
- `reference` records where to find information in external systems such as issue trackers and dashboards. Use PROJECT for project resources, USER for personal resources, and TEAM for shared resources every contributor relies on when TEAM is enabled.

Keep API keys, tokens, credentials, and other sensitive data out of TEAM, which is visible to everyone who can read the repository. Skip transitory conversation state, code patterns, architecture, file paths, git history, fix recipes, tool schemas, and anything already in QWEN.md or AGENTS.md. Capture a durable, surprising fact instead.

## Save or update

1. Check the enabled directories and existing entries before creating a file. Keep one independently retrievable fact per file. Update an existing entry when it covers the same fact. Write the file under the matching type directory inside the selected root, such as `feedback/testing.md`. Set or refresh all frontmatter fields:

   ```text
   ---
   name: "Memory title"
   description: "A specific one-line hook"
   type: feedback
   category: testing_standard
   keywords:
     - "deterministic test fixtures"
     - "request replay tests"
   usage_scenarios:
     - "Adding a request replay test"
   ---
   ```

   Set one category from this list: `basic_information`, `hobbies`, `communication_preference`, `behavior_habit`, `project_introduction`, `tech_stack`, `build_configuration`, `dependency_configuration`, `ide_configuration`, `scm_configuration`, `environment_configuration`, `code_standard`, `practice_standard`, `testing_standard`, `comment_standard`, `tool_experience`, `mcp_experience`, `common_pitfall`, `important_decision`, `task_summary`. Use 2–6 discriminative keywords, unique case-insensitively, with at most two exact identifiers last. Use 1–3 future usage scenarios that add to the description. Each keyword or scenario can be at most 64 characters. Double-quote every keyword and scenario. For `feedback` and `project`, lead with the rule or fact, followed by **Why:** and **How to apply:** lines.

2. For USER or PROJECT, update the `MEMORY.md` in the same root. Keep one concise pointer per entry, under about 150 characters: `- [Title](type/file.md) — one-line hook`. Only the first 200 lines of each index are eligible for the catalog. Keep any trailing truncation notice last. The index holds pointers only, without frontmatter. For TEAM, the runtime generates the index and the normal repository workflow carries the entry to teammates. Save only the body file and leave the TEAM index and Git alone.

## Forget

Find the relevant entry in the enabled directories and delete or correct it as requested. Remove or update its pointer in the same USER or PROJECT index. TEAM index changes follow automatically.
