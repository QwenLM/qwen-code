# Short Skills Dialog

[English](short-skills-dialog.md) | [简体中文](short-skills-dialog.zh-CN.md)

## Decision

Search includes both workspace-toggleable skills and locked skills. Bare mode
ignores a retained hidden query for filtering and keyboard behavior.

The dialog allocates its height budget to chrome and actionable rows first.
Remaining rows display matching locked skills in a read-only section, including
its heading and any separating margin. A count identifies locked matches that
do not fit; it is a subset of the total or matched count, not an additional
number of skills. The subtitle holds the count when available; bare mode uses
a remaining list row. If no actionable skill matches and the budget cannot
hold locked details, the list shows a one-line locked-match count.

Without a height constraint, every matching locked skill remains visible.
Lock decisions and their explanations use the shared settings logic, including
extension authored names and workspace restrictions that cannot be toggled here.

## Invariants

- A constrained dialog never renders more rows than its supplied budget.
- At least one matching actionable row remains visible when one exists.
- Locked matches never produce a false no-match message.
- Locked skills cannot be toggled or picked from the read-only section.
- Bare mode preserves the hidden query for restoration on expansion.
