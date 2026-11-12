# The Main Session's Resident Auto-Memory Policy

[English](2026-11-04-auto-memory-reference.md) | [简体中文](2026-11-04-auto-memory-reference.zh-CN.md)

**Status:** implements [#16291](https://github.com/QwenLM/qwen-code/issues/16291). Part of [#12028](https://github.com/QwenLM/qwen-code/issues/12028) and [#12781](https://github.com/QwenLM/qwen-code/issues/12781). The first version ([#16303](https://github.com/QwenLM/qwen-code/pull/16303)) also shipped a bundled `auto-memory` reference that the session loaded before saving; section 3 explains why it was removed.

## 1. Problem

With the defaults (`memory.enableManagedAutoMemory: true`), the main session's system prompt carries a `# auto memory` section on every request of every surface (Ink, OpenTUI, headless and the SDK, ACP), and subagents inherit it. A captured `qwen -p` request on main (2026-11-04) had a 35,792-character system prompt, of which this section was 16,140 characters (45%); `## Types of memory` alone was 7,939.

The main model writes memories on few turns, mostly when the user asks it to remember or forget something. The background extractor writes the rest, with its own prompt. So the detailed type guidance and its examples are needed on those few turns, while every request pays for them.

## 2. Design

The main session gets a **resident policy** from `buildResidentAutoMemoryPrompt` (`memory/prompt.ts`). It holds what a session needs to save and use memories correctly:

- the catalog note, and the USER / PROJECT (and, when enabled, TEAM) directories;
- remember and forget requests are handled immediately;
- the four types in one line each, with the scope that picks the directory, and the **Why:** / **How to apply:** body rule;
- the TEAM routing, the ban on secrets in TEAM and the generated team index, when team memory is on;
- what not to save, in one sentence, including that this holds even when the user asks;
- the two save steps, the frontmatter template unchanged, and the category names;
- deduplication and removing wrong memories;
- when to read memory, honoring "ignore memory", and checking the current state before relying on a memory or recommending a file, function or flag it names.

Every reader gets the same text. A legacy refresh builds it once and `Config.getAutoMemoryPrompt()` returns it, so the main session and every subagent's derived Config see one policy, whatever tools the subagent may use. Structured recall ([#12947](https://github.com/QwenLM/qwen-code/issues/12947)) keeps its own short prompt.

The full guidance stays in the prompt constants (`TYPES_SECTION_INDIVIDUAL` with its examples, `MEMORY_CATEGORY_SECTION`, `WHAT_NOT_TO_SAVE_SECTION`, `WHEN_TO_ACCESS_SECTION`, `MEMORY_WRITING_RULES`, `TEAM_SCOPE_SECTION`, `TRUSTING_RECALL_SECTION`, `MEMORY_PERSISTENCE_SECTION`):

- The extraction, Dream, User Dream, `/remember` and import agents keep building their prompts from them.
- `buildManagedAutoMemoryPrompt` gives the same output as before #16303 for every argument shape.

## 3. Why there is no bundled reference

The first version put the full guidance in a bundled `auto-memory` skill. The resident policy ended with a pointer telling the model to load it before saving, the skill was listed in `<available_skills>`, and a route resolver gave subagents without the Skill tool the full policy instead.

The initial behavior eval on 2026-11-09 compared that pointer route with the resident policy alone. It used Token Plan `qwen3.8-max` and `qwen3.8-flash` in headless `-p --yolo` mode with an isolated HOME and project per run. The nine scenarios covered saving to the right tier with valid metadata (s1–s3), refusing to store a fact the code already shows (s4), updating instead of duplicating (s5), forgetting (s6), checking a stale memory against the code (s7), honoring "don't use memory" (s8), and an unrelated task (s9). Each run was graded from the memory files on disk and the main model's tool calls.

| Scenario                             | Pointer + skill | Resident only |
| ------------------------------------ | --------------- | ------------- |
| s1 remember a personal preference    | 6/6             | 5/6           |
| s2, s3, s5–s9                        | 42/42           | 42/42         |
| s4 refuse a derivable fact (12 runs) | 8/12            | 7/12          |

The one s1 miss saved the preference as `user` instead of `feedback`, in the right directory and otherwise valid. On the pointer route the skill was loaded on 14 of 18 explicit saves; the saves that skipped it passed too.

| Average input tokens per run | Pointer + skill                         | Resident only                           |
| ---------------------------- | --------------------------------------- | --------------------------------------- |
| Save needed (s1–s3, s5)      | 88.2k (19.2k uncached, 5.1 model turns) | 57.7k (16.8k uncached, 3.8 model turns) |
| No save needed               | 61.0k (17.6k uncached)                  | 52.3k (16.2k uncached)                  |

Loading the reference added about 15k characters to the conversation history. A separate confirmation run used this PR's bundled build with default settings. It averaged 67.5k input tokens on save runs and 56.5k on no-save runs. It passed all six s1 trials, saved a reference with just one keyword in one s3 trial (5/6 passed), and refused to store the derivable fact in 6/12 s4 trials. The design uses the resident policy alone to reduce input tokens.

A shorter, more compressed policy (about 3.6k characters) was tried in the initial eval. It saved no further tokens, because the frontmatter template and the category list take most of the resident text, and it lost s4 more often unless it kept "not even when the user asks". The resident wording is kept as it is.

## 4. Measured effect

Lengths in characters, with typical paths (`/home/alice/.qwen/memories` and `/home/alice/.qwen/projects/-home-alice-work-app/memory`):

| Shape                       | No team | Team on |
| --------------------------- | ------- | ------- |
| Before #16303 (full policy) | 15,868  | 17,243  |
| #16303 pointer route        | 4,686   | 5,470   |
| Resident policy             | 4,451   | 5,235   |

The default session sends 11,417 fewer characters per request than before #16303. Compared with the pointer route it also drops the 235-character pointer and the 233-character `<available_skills>` entry; `BUNDLED_LISTING_BUDGET` goes back to 6,800.

## 5. Risks

- **Weaker metadata.** The resident policy keeps the frontmatter template, category names, and body rule. Background extraction and Dream still use the full guidance. Legacy file writes accept a one-keyword memory like the s3 miss. The structured-recall readiness scan counts it as a migration candidate, and the migration agent uses `MEMORY_METADATA_ITEM_BOUNDS` in its repair prompt.
- **Derivable facts on request.** When the user explicitly asks to remember something the code already shows, the smaller model often saves it anyway. That held for every variant in the eval, including the full policy (`qwen3.8-flash` 0/6 with the full policy, 2/6 with the resident one), so it is a separate improvement, not a regression from this design. On `qwen3.8-max` the pointer route did slightly better here (6/6, against 9/12 over two runs of the resident policy); across both models it loaded the skill in 3 of its 12 s4 runs.

## 6. Validation

- **Unit tests:**
  - `memory/prompt.test.ts`: the resident policy keeps each rule listed in section 2, leaves out the detailed type guidance, and stays within its size budget;
  - `config/config.test.ts`: the session and a derived Config without a skill manager get the same resident policy;
  - `skills/bundled-skills.integration.test.ts`: the bundled listing stays within 6,800 characters.
- **Behavior.** Section 3 describes the initial eval and the bundled-build confirmation. The full confirmation results are in [PR #16739](https://github.com/QwenLM/qwen-code/pull/16739).
