# Short Skills Dialog

## Decision

When `/skills` receives a terminal-height constraint, its rows are reserved for
the dialog chrome and workspace-toggleable skills. Higher-scope-locked skills
are represented by a count and are not included in constrained search results.

Without a height constraint, the dialog keeps the complete read-only locked
section and filters it with the search query.

## Invariants

- A constrained dialog never renders more rows than its supplied budget.
- At least one matching actionable row remains visible when one exists.
- Bare mode ignores a retained hidden query for filtering, Vim navigation, and
  Escape handling.
