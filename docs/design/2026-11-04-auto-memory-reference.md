# Moving the Main Session's Auto-Memory Guidance into a Bundled Reference

[English](2026-11-04-auto-memory-reference.md) | [简体中文](2026-11-04-auto-memory-reference.zh-CN.md)

**Status:** implements [#16291](https://github.com/QwenLM/qwen-code/issues/16291). Part of [#12028](https://github.com/QwenLM/qwen-code/issues/12028) and [#12781](https://github.com/QwenLM/qwen-code/issues/12781). Reuses the bundled-reference routing from [#12323](https://github.com/QwenLM/qwen-code/pull/12323) and [#11013](https://github.com/QwenLM/qwen-code/issues/11013).

## 1. Problem

With the defaults (`memory.enableManagedAutoMemory: true`), the main session's system prompt carries a `# auto memory` section on every request of every surface (Ink, OpenTUI, headless and the SDK, ACP), and subagents inherit it. A captured `qwen -p` request on main (2026-11-04) had a 35,792-character system prompt, of which this section was 16,140 characters (45%); `## Types of memory` alone was 7,939.

The main model writes memories on few turns, mostly when the user asks it to remember or forget something. The background extractor writes the rest, with its own prompt. So the detailed type guidance and its examples are needed on those few turns, while every request pays for them.

## 2. What moved, and what stayed

The main session now gets a **resident policy** from `buildResidentAutoMemoryPrompt` (`memory/prompt.ts`). It keeps what a session needs to save and use memories correctly without loading anything:

- the catalog note, and the USER / PROJECT (and, when enabled, TEAM) directories;
- remember and forget requests are handled immediately;
- the four types in one line each, with the scope that picks the directory, and the **Why:** / **How to apply:** body rule;
- the TEAM routing, the ban on secrets in TEAM and the generated team index, when team memory is on;
- what not to save, in one sentence, including that this holds even when the user asks;
- the two save steps, the frontmatter template unchanged, and the category names;
- deduplication and removing wrong memories;
- when to read memory, honoring "ignore memory", and checking the current state before relying on a memory or recommending a file, function or flag it names;
- a pointer to the `auto-memory` skill.

The **bundled `auto-memory` skill** (`skills/bundled/auto-memory/SKILL.md`) carries the full text of these constants:

- `TYPES_SECTION_INDIVIDUAL`, with every example;
- `MEMORY_CATEGORY_SECTION`, `WHAT_NOT_TO_SAVE_SECTION` and `WHEN_TO_ACCESS_SECTION`;
- `MEMORY_WRITING_RULES`, the keyword, usage-scenario and body-size rules, together with `MEMORY_METADATA_ITEM_BOUNDS`;
- `TEAM_SCOPE_SECTION`, `TRUSTING_RECALL_SECTION` and `MEMORY_PERSISTENCE_SECTION`.

The constants stay the single source, because other prompts are built from them:

- The extraction, Dream, User Dream, `/remember` and import agents keep building their prompts from the full constants.
- `buildManagedAutoMemoryPrompt` gives byte-identical output for every argument shape. The refactor only extracted `TEAM_SCOPE_SECTION`, `MEMORY_WRITING_RULES` and `MEMORY_PERSISTENCE_SECTION` into constants.
- `SKILL.test.ts` asserts every line of each constant is in the skill, so the reference cannot drift from what those agents are told.
- It also asserts each moved anchor is absent from the resident policy and from the skill's frontmatter, and each kept anchor is present in the resident policy.

## 3. How the route is decided

`buildMainSessionAutoMemoryPrompt` (`skills/auto-memory-skill.ts`) uses `resolveBundledReferenceRoute`, the same resolver the Workflow and Agent tools use:

| Route                                                                           | Main-session policy                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `skill`                                                                         | resident policy + pointer                                   |
| `skill-via-tool-search`                                                         | resident policy + pointer + the tool_search bridge sentence |
| `inline` (no route to any skill)                                                | the full policy, as before                                  |
| `withheld` (`skills.disabled` names `auto-memory`, or the bundled level is off) | resident policy only                                        |

It decides on the route rather than on the surface the tool descriptions use. That surface falls back to a pointer when the reference file cannot be read, but the full policy needs no file.

**Session start.** `Config.refreshHierarchicalMemory` first runs at session start, before the tool registry exists, so the first build cannot see the Skill tool. Config therefore keeps the policy's inputs and builds the policy again right after it creates the registry. Later refreshes see the registry directly.

**Listing.** The skill is listed only when managed auto-memory is on. `Config.isSkillEnabled` and `SkillManager` hide it otherwise, the way they hide `generated-ui`.

## 4. Measured effect

Lengths in characters, with typical paths (`/home/alice/.qwen/memories` and `/home/alice/.qwen/projects/-home-alice-work-app/memory`):

| Shape                          | No team | Team on |
| ------------------------------ | ------- | ------- |
| Before (full policy)           | 15,868  | 17,243  |
| Pointer route                  | 4,572   | 5,356   |
| Pointer via tool_search        | 4,690   | 5,474   |
| Withheld                       | 4,337   | 5,121   |
| Inline (no route to any skill) | 15,868  | 17,243  |

The default session saves **11,296 characters (about 2.8k tokens) per request**.

The listing cost is small:

- The skill adds one `<available_skills>` entry of 233 characters.
- `BUNDLED_LISTING_BUDGET` moves from 6,800 to 7,050 to fit it, and `bundled-skills.integration.test.ts` records why.

A session that loads the skill carries its body, about 14.6k characters, in history from then on until compaction. Only sessions that save or reorganize a memory pay that.

## 5. Risks

- **Weaker metadata.** A save made without loading the skill may pick weaker keywords or a looser body shape. Three things limit that:
  - The resident policy keeps the frontmatter template, the category names and the body rule.
  - The writer's validation messages still quote `MEMORY_METADATA_ITEM_BOUNDS`.
  - The background extractor and Dream keep working from the full rules.
- **Restricted subagents.** The route resolver reads the tool registry, not a subagent's tool policy. A custom subagent that inherits the policy but cannot call `skill` gets a pointer it cannot follow. This is the existing [#12424](https://github.com/QwenLM/qwen-code/issues/12424) gap; the resident policy alone still saves correctly.
- **Structured recall.** This change is independent of structured recall ([#12947](https://github.com/QwenLM/qwen-code/issues/12947)), whose prompt is already short. It changes only the legacy path, which is the default.

## 6. Validation

- **Unit tests:**
  - `skills/bundled/auto-memory/SKILL.test.ts`: every constant line in the skill, plus both-way anchors;
  - `skills/auto-memory-skill.test.ts`: the four routes and the size budget;
  - `config/config.test.ts`: the policy per route, and the listing gate;
  - `memory/prompt.test.ts` and `skills/bundled-skills.integration.test.ts`.
- **Byte identity:** the output of `buildManagedAutoMemoryPrompt` was compared with the merge base for five argument shapes and matched.
- **Behavior:** a before/after run with real models over nine scenarios. The scenarios cover saving to the right tier with valid metadata, absolute dates, references, refusing to store derivable facts, updating instead of duplicating, forgetting, verifying a stale memory against the code, honoring "don't use memory", and an unrelated task that must neither load the skill nor write memory. The results are in the PR.
