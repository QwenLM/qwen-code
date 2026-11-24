# Compact inline auto-memory policy

[English](compact-inline-memory-prompt.md) | [简体中文](compact-inline-memory-prompt.zh-CN.md)

## Problem and approach

Each legacy file-based memory request carries the foreground read/write policy. An empty catalog also used to add a snapshot with a heading for every enabled memory root. Loading the write policy through a tool can reduce the first request and also increase the number of model requests needed to save or forget a memory. A compact inline policy keeps the operations available on the first request.

## Implementation

- Shorten the main-session legacy policy. Keep root and type routing, the full frontmatter contract, deduplication, private index maintenance, team scope and credential rules, and verification of outdated memory. Use the same instructions for direct model requests, including save, correct, and forget.
- Omit the catalog from a fresh request when all enabled roots are empty. After a nonempty snapshot, send a marked empty snapshot that supersedes earlier entries. Preserve full snapshots, ordering, escaping and truncation when any root has entries. Structured recall and background extractors use their own existing prompts.
- Compress the shared action guidance and omit examples from the generic model fallback. Retain the explicit tool-call style override, model-specific guidance, authorization and denial rules, and protection of user changes.

## Verification

Replay the fixed ordinary question and isolated save, update, forget, and recall fixtures with the same model, provider, tools and initial memory in both builds. Record provider input for the first request and for every request in the turn. The ordinary first request must use fewer provider input tokens. The median whole-turn provider input in each scenario must be at most 130% of baseline. Check the resulting files, index and recall, and verify that the model receives the current catalog after deleting the final entry, resuming, and restoring the same entry.
