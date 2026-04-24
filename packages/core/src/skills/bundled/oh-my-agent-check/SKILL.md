---
name: oh-my-agent-check
description: Audit agent wrappers, CLI agents, coding assistants, browser agents, long-running runtimes, memory systems, tool routing, rendering layers, and hidden fallback loops. Use when the user asks why an agent behaves worse than the base model, skips tools, reuses stale evidence, pollutes memory, mutates output, or needs an evidence-backed agent diagnosis.
allowedTools:
  - glob
  - grep_search
  - read_file
  - read_many_files
  - run_shell_command
---

# Oh My Agent Check

Use this skill to audit an agent system itself, not to complete the user's
domain task.

This skill fits cases like:

- "Why does this agent become worse after wrapping a model?"
- "Why did it skip tools?"
- "Why does it hallucinate system state?"
- "Why does old memory leak into new turns?"
- "Why was the answer correct internally but broken in delivery?"
- "Audit this CLI agent, runtime, assistant, or wrapper architecture."

## Core Rule

Do not trust the current output quality, current prompt text, or current
"fixed" behavior by default.

Assume the target agent may be hiding wrapper regressions, stale state, memory
contamination, prompt conflicts, weak tool discipline, rendering mutation, or
hidden repair loops.

Do not blame the base model until the wrapper layers have been falsified.

## Layers To Audit

Inspect the full stack:

1. System prompt and persona
2. Session history injection
3. Long-term memory retrieval
4. Distillation, recap, and active recall
5. Tool routing and selection
6. Tool execution and observation handling
7. Tool-output interpretation
8. Final answer shaping
9. Platform rendering and transport
10. Hidden fallback, retry, repair, or summarization loops
11. Persistence, caches, stale files, and stale database rows

## Working Style

Work JSON-first internally before writing prose conclusions.

Build these artifacts in order and use them as the internal reasoning contract:

1. `agent_check_scope.json`
2. `evidence_pack.json`
3. `failure_map.json`
4. `agent_check_report.json`

You do not need to write these files unless the user asks for artifacts. The
final answer must be rendered from `agent_check_report.json`, not improvised
from vague impressions.

Minimum contents:

- `agent_check_scope.json`: target, entrypoints, channels, model stack,
  symptoms, time window, layers to audit
- `evidence_pack.json`: exact files, code locations, logs, traces, config
  paths, payload shapes, and whether evidence is current, historical, or mixed
- `failure_map.json`: symptom, user-visible effect, mechanism, source layer,
  root cause, confidence, contradictory evidence
- `agent_check_report.json`: executive verdict, severity-ranked findings,
  conflict map, contamination paths, hidden-agent behaviors, code-vs-prompt
  control gaps, ordered fix plan

## Evidence Workflow

Prefer direct repository and runtime evidence:

- `grep_search` or `glob` for discovery
- `read_file` or `read_many_files` for exact source context
- `run_shell_command` for logs, tests, git history, process state, and local
  diagnostics
- exact line references when possible
- historical traces when the user reports a regression that may already be
  partially fixed

If the user mentions "yesterday", "earlier", "it used to", or gives a pasted
bad interaction, inspect historical logs or sessions instead of overfitting to
the current code.

## Standard Audit Modes

Choose the closest mode and say which one you used.

### tool-discipline

Use when the agent should have used a tool but did not, selected the wrong tool,
or drifted away from tool evidence.

Focus on:

- code-enforced vs prompt-enforced tool requirements
- preflight probes
- tool-call skip paths
- stale evidence reuse
- whether final answers are bound to current-turn evidence

### memory-contamination

Use when old topics leak into new turns, same-session artifacts re-enter the
loop, or memory and session history blur together.

Focus on:

- stale session reuse
- aggressive distillation cadence
- weak memory admission criteria
- model-generated text persisted as pseudo-truth
- retrieval quality and ordering

### wrapper-regression

Use when the base model seems strong, but the wrapped agent behaves worse.

Focus on:

- system prompt vs runtime role conflicts
- duplicated context injection
- generated text fed back into the model as authority
- hidden formatting, recap, or fallback layers

### rendering-transport

Use when the answer seems correct internally but is broken in delivery.

Focus on:

- transport payload shape assumptions
- rich text and markdown compatibility gaps
- deterministic fallback behavior
- platform-layer semantic mutations

### hidden-agent-layers

Use when repair, retry, recap, or formatting layers act like extra assistants.

Focus on:

- second-pass LLM calls
- hidden repair prompts
- maintenance-worker synthesis paths
- transport layers rewriting meaning

## Fix Strategy

Prefer code control over prompt control.

Recommended default order:

1. Hard-gate mandatory tool requirements in code.
2. Remove or narrow hidden fallback and repair agents.
3. Reduce duplicated context across prompt, history, memory, distillation, and
   recall.
4. Tighten memory admission and retrieval criteria.
5. Tighten distillation trigger policy.
6. Reduce rendering-layer mutation.
7. Convert internal flow to typed JSON envelopes.

Also look for these common failure patterns:

- false confidence after failed probes
- stale evidence replay as live truth
- fake agentic depth: more planning, less control
- hidden repair brains mutating correct answers
- memory poisoning from assistant self-talk
- protocol decay: markdown or prose used as internal state

## Severity Model

Use these severity labels:

- `critical`: the agent can confidently produce wrong operational behavior
- `high`: the agent frequently degrades correctness or stability
- `medium`: the issue creates meaningful but bounded reliability risk
- `low`: cleanup or clarity issue with limited immediate impact

## Output Rules

Lead with findings, not compliments.

The final user-facing response should present:

1. Severity-ranked findings
2. Architecture diagnosis
3. Ordered fix plan

If no issue is proven, say that clearly and list the evidence inspected plus
remaining blind spots.

Do not soften the verdict for politeness. If the wrapper is broken, say it is
broken. If the main problem is prompt-only control, say that directly.
