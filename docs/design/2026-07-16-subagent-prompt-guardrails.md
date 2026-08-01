# Subagent Prompt Guardrails

## Motivation

The Agent tool currently encourages broad parallel delegation and says that
subagent output should generally be trusted. The built-in prompts also omit a
few execution and verification expectations, while the Explore and fork prompts
contain unsafe or contradictory guidance.

## Design

- Tell the parent agent to delegate only bounded, independent work, keep
  immediate critical-path work local, avoid duplicate work, and give parallel
  code-writing agents disjoint write scopes.
- Require the parent to review claims and code changes before integrating or
  relaying a subagent result.
- Simplify the general-purpose prompt and add scope, preservation,
  verification, uncertainty, and structured reporting expectations.
- Narrow Explore's stateful tool surface by removing task, memory, and user
  question tools from its allowlist. Permit shell pipelines while continuing
  to prohibit writes in its prompt.
- Stop requiring fork agents to commit changes unless the directive explicitly
  asks for a commit.

Context inheritance and the default background-execution behavior are outside
this change.

## Verification

Focused unit tests assert the parent guidance, built-in prompt contents,
Explore's tool allowlist, and fork reporting rule. The core package build and
typecheck provide the broader compile-time check.
