# Reduce first-request prompt overhead

[English](lean-first-request.md) | [简体中文](lean-first-request.zh-CN.md)

## Problem

File-based auto-memory adds its full write contract to every main request, including read-only turns. A new session with empty indexes also sends an empty catalog. The general-model system prompt includes worked examples even for ordinary questions. On a previous first-request fixture, the proposed changes saved about 1,720 tokens by a local estimator. Provider usage on that fixture is unknown.

## Design

- Keep the enabled memory directories, recall and freshness guidance, and the explicit remember/forget trigger in the resident legacy prompt. Load the bundled `memory-policy` Skill before an explicit write, update, or forget. Its instructions carry the existing metadata, scope, deduplication, index, and team rules.
- Use the short policy when the selected skill is the official bundled one, it is enabled, and the session exposes a working Skill invocation route. A missing, disabled, or shadowed skill uses the existing inline write policy. Structured sessions use their existing tools.
- Omit the initial catalog when all enabled indexes are blank. If history already carries a nonempty catalog, record an empty superseding snapshot when the last memory is removed. Keep the source labels, limits, and reminder escaping for populated catalogs.
- Omit automatic examples for general tool formats and retain the explicit `QWEN_CODE_TOOL_CALL_STYLE=general` override, specialized model formats, and Code Mode examples. Condense the risk paragraph while preserving the authorization, headless stop, existing-work, and safeguard instructions.

## Validation

Run the CLI and ACP against a controlled OpenAI-compatible provider and inspect the outgoing request, tool results, and on-disk memory. Cover a new empty session, adding an entry, deleting the last entry, resuming, then restoring an entry. Cover missing, hidden, disabled, and shadowed Skill routes, metadata, duplicate updates, forget, and scope rules. Verify prompts for default general, explicit general, specialized models, and Code Mode.

For the live benchmark, run five paired fresh sessions per case, alternating order and pinning the question, model, configuration, permissions, and initial memory. Report provider first-main-request usage separately from per-component estimates. Count all tool rounds and retries in the explicit remember, update, and forget turns. Use the same estimator on the frozen first-request fixture, aiming for at least 1,200 estimated tokens saved across the changed components. Require lower provider first-request input in all five pairs, zero memory-policy calls on ordinary questions, and passing memory and authorization checks. Report the full-turn cost of explicit writes and the number of ordinary first turns required to offset it.
