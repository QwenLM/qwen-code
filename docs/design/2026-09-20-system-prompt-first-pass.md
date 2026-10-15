# First-pass system prompt simplification

[English](2026-09-20-system-prompt-first-pass.md) | [简体中文](2026-09-20-system-prompt-first-pass.zh-CN.md)

## Problem and scope

The default main-session prompt repeats project conventions, communication guidance, and interaction-mode instructions. Its five example variants include arithmetic, primality, an unexecuted deletion, and a redundant file-discovery conversation. Refactoring examples invite an unsolicited commit, conflicting with headless instructions that prohibit questions.

This first pass changes built-in prompt text and its tests. It preserves public APIs, model-family routing, declared-tool filtering, direct and CodeModeOnly calling conventions, permissions, sandbox and Git safeguards, output-style selection, custom overrides, and outer context assembly. It does not relocate instructions across provider roles or add configuration.

## Changes

- Merge overlapping convention and communication prose without removing the requirements to inspect relevant code, follow existing dependencies and conventions, and adapt answer depth to the task.
- State the interaction-mode question policy once in the final reminder. Keep task completion guidance there; remove repeated general-purpose safety and file-reading prose already covered elsewhere.
- Retain three examples per variant: a managed background server, a scoped refactor, and creating a test file after checking its absence. Preserve the model-specific call formats and the read-before-write example.
- Shorten example narration, remove the unsolicited commit question, and remove arithmetic, primality, deletion, and duplicate discovery examples. The deletion example was the only demonstration of stating a destructive command's blast radius; it is dropped deliberately because the prose mandating that behaviour (`Explain Critical Commands`, and `# Executing actions with care` naming `rm -rf`) is untouched. Retained examples must inspect source before editing and report verification only after successful checks.
- Shorten redundant tool wording while preserving tool-selection policy, independent-call parallelism, dependency sequencing, absolute paths, and CodeModeOnly output/abort semantics.

## Rationale and consumers

The entry point remains `getCoreSystemPrompt`. Its production callers are the main client and Arena workers; the function is also exported for package consumers. Main-session custom prompts continue bypassing the default builder. The `Using Your Tools` line prefixes and example wrappers remain compatible with declared-tool filtering. Output styles can still omit only the software-engineering workflow.

The change retains representative tool formats instead of deleting all examples without model evidence. It also leaves validation policy and safety wording intact; changing when tests or approvals are required is outside this conservative pass.

## Validation and acceptance

- Reproduce the headless contradiction through the global CLI before changes; verify the local bundle afterward. A captured request proves prompt content, not real-model task quality.
- Exercise general, qwen-coder, qwen-vl, gemma4, and CodeModeOnly variants across interactive, headless, and ACP modes. Retained examples must not ask follow-up questions, while interactive/ACP clarification and headless no-reply guidance remain present.
- Validate example arguments against actual file-tool schemas and preserve read-before-create ordering, partial-tool filtering, all-tools equivalence, and empty-example handling.
- Run focused prompt/output-style tests, build, bundle, typecheck, and changed-file formatting/lint checks. Review updated snapshots and the full diff.
- Compare before/after rendered text under identical inputs using `o200k_base` as a common size ruler. This is not native provider billing or evidence of improved task success.

## Risks and follow-up

Removing demonstrations may affect models differently. Live paired evaluations of task completion, tool errors, unnecessary questions, verification accuracy, tokens, and latency remain necessary before claiming a quality improvement. Existing references to unavailable tools or skills outside the filtered sections are a separate follow-up; this pass does not claim full capability-aware assembly.
