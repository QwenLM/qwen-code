# Moving the Agent Tool's Prompt-Writing Guidance into a Bundled Reference

[English](2026-09-20-agent-delegation-reference.md) | [简体中文](2026-09-20-agent-delegation-reference.zh-CN.md)

**Status:** implemented for [#12054](https://github.com/QwenLM/qwen-code/issues/12054), part of [#12028](https://github.com/QwenLM/qwen-code/issues/12028). Builds on the Agent/Shell size budgets from [#12142](https://github.com/QwenLM/qwen-code/pull/12142) — landed as `36887c49` — whose rows this change lowers.

Every figure below was measured, not rendered on paper: the real `AgentTool` is constructed and its assembled `description` read, with the two subagent entries the budget test uses, team off, todo on. The _Before_ column is the same measurement with the two changed source files reverted to the merge base, so exactly one variable moves. Run locally on Linux — `packages/core` built, then 98 tests across the three affected files and 20 in the bundled-skills integration file, all passing, and every row of §3 reproduced from the constructed tool. The macOS and Windows unit jobs are `skipped` by CI for this PR rather than green, so nothing automated covers them; this is platform-independent string and module work, and `Desktop Shell (windows-2022)` does run. Token counts are characters ÷ 4, the same rough conversion the issue uses.

## 1. Problem

The Agent tool's description is the largest built-in tool description in the request, and it is sent on **every** request of **every** session, whether or not that turn delegates anything. About a quarter of it is craft advice for writing a delegation prompt: how much context to give, what not to delegate, what a fork prompt looks like, and a worked `test-runner` example. A turn that reads a file and answers a question pays for all of it.

The Workflow tool had the same shape and solved it in [#11013](https://github.com/QwenLM/qwen-code/issues/11013): the authoring reference became the bundled `workflow-authoring` skill, and the description carries a pointer. That mechanism is reused here rather than reinvented.

## 2. What moved, and what deliberately did not

Moved into `packages/core/src/skills/bundled/agent-delegation/SKILL.md`:

- the `## Writing the prompt` section (the "smart colleague" briefing paragraph, its five bullets, "Terse command-style prompts…", and **Never delegate understanding**);
- the `**Writing a fork prompt.**` paragraph;
- two craft bullets from `Usage notes:` — "Provide clear, detailed prompts…" and "Clearly tell the agent whether you expect it to write code or just to do research…";
- the `<example_agent_descriptions>` / `isPrime` / `test-runner` worked example.

Kept in the description, on purpose, because a session that never loads the skill still has to get them right:

- when **not** to use the tool at all, and the reuse-an-existing-background-agent rule;
- the whole `## Working with background agents` section — **Don't peek**, **Don't race**, **Don't relaunch**;
- `## When to fork`'s call-shaping facts: a fork inherits the full conversation by default, `fork_turns` bounds it, `subagent_type` must be given, don't set `model` on a fork, pass a short `name`;
- concurrency and write-scope rules, `isolation`/`working_dir` semantics, and "treat the agent's output as evidence".

The split is the test's subject, not a comment: `SKILL.test.ts` asserts each moved anchor **is** in the skill and **is not** in the description a skill-capable session sends, and each kept anchor the other way round. Either half alone would let guidance vanish, or be pasted back, with every test green.

The text moved verbatim rather than being rewritten, with one addition and one deletion. The addition is a rule that a custom subagent's own definition outranks the dispatching prompt. #12142's review threads carry a real dispatch that asked a subagent defined as read-only over one file to search the whole repository, and the relocated "Provide clear, detailed prompts…" bullet encourages that override without ever saying whose contract wins. The rule sits in this reference rather than in the description because it is prompt-writing craft: a session that never loads the reference still cannot widen a subagent's tools, it only wastes the dispatch.

The deletion is one sentence, and it is a dedup rather than a loss. Base `agent.ts` carried "After launching an agent, do not fabricate or predict what it found before it returns. If the user asks a follow-up before the result arrives, provide status rather than guessing." The resident **Don't race** bullet already states the same rule more strongly — "Never fabricate or predict its results in any format…give status, not a guess" — and stays in the description in every shape, so carrying both would have charged every request for one instruction twice. `SKILL.test.ts` pins this: the dropped sentence appears in neither surface, and the surviving rule appears in all three shapes. A general compression pass on this description was reverted under review in #12142; keeping everything else to relocation keeps the two questions separable.

## 3. Measured effect

Description length read off the constructed tool, with the two subagent entries the budget test uses, team off, todo on:

| Shape                                                                                 | chars  | ≈tokens |
| ------------------------------------------------------------------------------------- | ------ | ------- |
| Before                                                                                | 9,730  | 2,433   |
| After, pointer (a session that can load skills)                                       | 7,386  | 1,847   |
| After, pointer + ToolSearch note (a `tools.eager` allowlist withholds the Skill tool) | 7,463  | 1,866   |
| After, reference withheld by `skills.disabled`                                        | 7,192  | 1,798   |
| After, reference inlined (no route to any skill)                                      | 10,377 | 2,594   |

So the normal case saves **2,344 characters ≈ 586 tokens per request**, against a 192-character pointer. The new skill costs one entry in the `<available_skills>` listing, which the session-start prelude carries in a user-role message rather than in the system prompt. That entry renders at **371 characters, ≈93 tokens** — measured through `renderAvailableSkillsBlock`, not the 247 of the frontmatter `description` alone, because the render adds the `<skill>` / `<name>` / `<description>` / `<location>` wrapper, a ` (bundled)` suffix, and XML-escapes the apostrophe in "the Agent tool's" to `&apos;`. The net is therefore **≈493 tokens per request**, recovered on every turn of every session including the ones that never delegate.

The ToolSearch variant costs 77 characters more than the plain pointer: one sentence telling the model to reveal the Skill tool before it can load the reference.

The inline shape is 647 characters larger than today's description, and that 647 decomposes exactly: 92 for the inline preamble and its `---` separator, 265 for the reference's own title and framing paragraph, and 465 for the precedence rule with its blank line, less 175 because the relocated prose reads shorter inside the reference than it did in the description's bullet list. Only the precedence rule is new text rather than relocated text. The total is the deliberate price for sessions that cannot load a skill — a pointer there would name something the model cannot reach — and a pointer-shaped session pays none of it, because only the inline shape carries the reference body at all.

## 4. How the route is decided

`skills/bundled-reference.ts` is the `workflow-authoring` logic extracted so the two references cannot drift, plus the ToolSearch helpers both need. It answers four cases, once, when the tool is constructed:

| Route                   | Condition                                                                             | Description carries                         |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| `skill`                 | a skill manager exists and the Skill tool is registered                               | pointer                                     |
| `skill-via-tool-search` | the Skill tool's schema can be withheld by a `tools.eager` allowlist                  | pointer + "reveal it with ToolSearch first" |
| `inline`                | no route to any skill (skills off, Skill tool denied, or deferred with no ToolSearch) | the reference in full                       |
| `withheld`              | the user turned this reference off by name or disabled the whole bundled level        | nothing                                     |

`AgentTool` resolves this in its constructor and stores it, so a mid-session `/skills` toggle cannot make two `refreshSubagents()` rebuilds disagree about where the reference lives. Registration order makes that safe: every core tool is registered as a lazy factory before any is constructed, so the Skill tool is already in `getAllToolNames()` when the Agent tool is built.

`workflow-authoring-skill.ts` keeps all of its exported names and now delegates to the shared module, so #11013's callers and tests are untouched.

## 5. Blast radius

- **Every request** carries the shorter Agent declaration. Nested agent launches and forks inherit the same description.
- **#12142's budget tests** are lowered to the new measurements, each at measured length plus ~350 as that PR's own tightening pass set them (default 10,200 → 7,750; no-subagents 9,900 → 7,450; all blocks on 11,200 → 8,750; whole model-visible surface 14,200 → 11,750), and gain two rows: a ceiling for the inline shape and a floor on pointer-vs-inline so the gap cannot quietly close.
- **`agent.test.ts`** had five assertions anchored on text that moved. Three would have kept passing by accident, because that file's stub `Config` has no skill manager and therefore gets the inlined reference — they are re-anchored on facts the description keeps in every shape (don't set `model` on a fork, forks inherit the full parent conversation by default, pass a short `name`).
- **The skills listing** gains one bundled entry, listed in `/skills` and gated by `skills.disabled` / `skills.enabled` like any other. It reaches the model through the session-start prelude's `<available_skills>` block — a user-role message, not the system prompt — at the 371 rendered characters costed in §3.
- **Bundling** needs nothing new: `scripts/copy_bundle_assets.js` and `scripts/copy_files.js` copy `skills/bundled/**` recursively, and `bundled-skills.integration.test.ts` parses every shipped `SKILL.md`, so the new directory is covered by both.
- **No prompt, snapshot, or ACP surface** references the moved text: the only files naming it were `agent.ts` and `agent.test.ts`.

## 6. Risks

**A model that never loads the skill writes a worse prompt.** That is the accepted trade, bounded by what stayed resident: the launch rules, the safety rules, and the fork facts that shape the call are all still in the description, so a session that skips the reference still calls the tool correctly — it just briefs the agent less well. The skill's own description names what it holds, which is what lets the model decide whether this turn needs it.

**A recall regression would not show up in unit tests.** Whether models actually load the reference before writing a delegation prompt is an evaluation question, not an assertion; it belongs with the routing-miss measurement #12028 already owns.

**The resident "treat the agent's output as evidence" bullet stays unqualified.** The precedence rule lives in the reference, so a session that never loads it still reads that bullet with nothing saying that a subagent whose definition makes its result authoritative is a different case. Qualifying it in the description would cost every turn of every session what only a dispatching turn needs — the trade this whole change exists to undo — so that half stays with #12142's threads.

## 7. Validation

- `packages/core/src/skills/bundled/agent-delegation/SKILL.test.ts` — the two-way split table, the pointer's wording, the precedence rule, the inline shape, the withheld shape (asserted with the Skill tool both registered and absent, since the opt-out outranks the lack of a route), and the don't-predict dedup.
- `packages/core/src/tools/agent/agent-description-budget.test.ts` — the lowered budgets, the inline ceiling, and the pointer-vs-inline floor.
- `packages/core/src/skills/workflow-authoring-skill.test.ts` and `workflow-description.test.ts` — unchanged, and they are what pins that the extraction did not change #11013's behaviour.
- `packages/core/src/skills/bundled-skills.integration.test.ts` — the new `SKILL.md` parses with `name` matching its directory.
