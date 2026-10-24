# Repository Knowledge Lifecycle Skill

Status: accepted for exploration in
[issue #9781](https://github.com/QwenLM/qwen-code/issues/9781).

## Problem

Qwen Code has instructions, current documentation, design records, active
GitHub state, executable constraints, and temporary work artifacts. Existing
workflows can update several of these, but they do not share a small decision
process for choosing the canonical destination of newly learned information or
retiring stale knowledge.

The result can be duplicated facts, durable documents containing temporary
status, and handoffs that depend on conversation history.

## Decision

Add a project-level `knowledge-lifecycle` skill that:

- discovers applicable sources before work and verifies drift-prone claims;
- routes each fact according to its lifecycle instead of creating a new store;
- defaults to analyze-only behavior and distinguishes authorized file edits
  from separately authorized GitHub mutations;
- performs a lightweight closeout before feature and bug-fix workflows finish;
- defines a compact handoff containing state and canonical pointers rather than
  copied specifications.

The feature and bug-fix skills invoke the closeout at the end of their existing
verification and review phases. They keep ownership of implementation and
testing; the new skill owns only the routing decision.

## Scope

The first version changes project workflow instructions only. It does not add
production code, a generated index, a storage system, automatic journaling, or
automatic GitHub writes. It does not migrate existing design documents or
plans.

## Validation

Validate the new skill's frontmatter and structure with the skill validator,
then inspect each representative routing example against the decision table.
Review the workflow changes to confirm they add one bounded closeout step and
do not replace existing feature or bug-fix verification.
