---
name: knowledge-lifecycle
description: Route Qwen Code repository knowledge to its canonical artifact
  before, during, and after development work. Use for source-of-truth discovery,
  knowledge closeout, durable knowledge promotion, or compact handoffs; do not
  use it as a general note-taking or memory-dump workflow.
---

# Repository Knowledge Lifecycle

Keep one canonical source for each fact. Other artifacts may summarize it only
when they also point to that source.

## Modes

- **Analyze-only** is the default for audits, reviews, and unclear write scope.
  Report recommended updates without changing repository or GitHub state.
- **Explicit-write** applies when the user asked for an implementation or
  documentation change and the proposed file updates are within that scope.
  GitHub issues, pull requests, projects, and comments still require explicit
  authorization before each workflow that mutates them.

## Before Work

1. Identify the task and affected paths.
2. Read the applicable `AGENTS.md` files and path-scoped rules.
3. Find current documentation, durable design records, and active GitHub or
   implementation-plan context relevant to those paths.
4. Verify drift-prone claims against current code, tests, schemas, and
   configuration before treating them as current facts.
5. Keep stable pointers to the sources you use. Do not copy their full content
   into a new note.

If sources conflict, report the conflict. Do not silently choose the newest file
or assume that current implementation overrides an accepted contract.

## Route Knowledge

| Knowledge                                                  | Canonical artifact                                                 | Update or retire when                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Recurring repository or path-specific working agreement    | The nearest applicable `AGENTS.md` or path-scoped rule             | The agreement changes or no longer recurs                           |
| Current user or developer behavior                         | Current documentation                                              | Shipped behavior changes; replace stale guidance                    |
| Durable rationale or a hard-to-reverse decision            | Design document, RFC, or ADR                                       | A later decision supersedes it; retain a pointer to the replacement |
| Active scope, ownership, progress, discussion, or blockers | GitHub issue, project, pull request, or active implementation plan | Work advances, closes, or is abandoned                              |
| Behavior that must remain true                             | Test, schema, lint rule, hook, or CI check                         | The invariant changes or is intentionally removed                   |
| Operational, migration, deprecation, or release knowledge  | The relevant runbook or lifecycle document                         | The process or supported lifecycle changes                          |
| Short-lived investigation or handoff                       | A temporary `.qwen/` work artifact                                 | Its stated expiry condition is met                                  |

Do not create a new artifact when an existing canonical source should be
updated. Do not add a manually maintained index merely to repeat the repository
tree.

## During Work

- Update only the artifacts that own changed facts.
- Use short summaries and stable pointers when another artifact needs context.
- Put dynamic status in GitHub, not in durable documentation.
- Put enforceable behavior in executable artifacts when practical; prose alone
  is not the canonical source for an invariant.
- Keep investigations and transcripts temporary unless closeout identifies a
  durable fact worth promoting.

## Knowledge Closeout

Before declaring work complete, inspect the actual diff and verified results,
then decide:

1. Did current behavior change? Update current documentation and the executable
   constraint that should preserve it.
2. Was a durable decision made? Update or add its design record and point from
   any superseded record.
3. Did a working agreement prove recurring? Update the narrowest applicable
   instruction file; do not promote task-specific advice.
4. Did active scope or status change? Propose the GitHub update and perform it
   only with explicit authorization.
5. Was operational knowledge discovered? Update the owning runbook or lifecycle
   document.
6. Is the information useful only for the current task? Leave it temporary or
   discard it when its expiry condition is met.

Report the result as a compact list of `source -> action -> pointer`. If no
knowledge should persist, say so instead of creating an empty closeout artifact.

## Handoff

When another agent or person must continue the work, provide only:

- **Base commit:** the exact commit the verified state is based on.
- **Verified state:** what was checked and the observed result.
- **Blockers:** unresolved conditions, or `None`.
- **First next action:** one concrete action that can resume progress.
- **Expires when:** the condition that makes this handoff stale.
- **Canonical pointers:** links or paths to the owning issue, plan, design,
  documentation, tests, or runbook.

Do not copy specifications, issue discussions, or conversation history into the
handoff.

## Routing Examples

- **Small bug fix:** the regression test owns the invariant. Update user docs
  only if documented behavior changed; keep progress in the issue or pull
  request.
- **Behavior-changing feature:** current docs describe the shipped behavior,
  tests enforce it, and a design record holds only durable rationale.
- **Durable design decision:** record the decision and alternatives in the
  design document or ADR; mark an older decision as superseded with a pointer.
- **Long-running implementation:** keep ownership, progress, and blockers in the
  active issue, project, or plan; handoffs point there instead of copying it.
- **Operational discovery:** update the runbook, migration, deprecation, or
  release document that owns the process; do not bury it in a task transcript.
