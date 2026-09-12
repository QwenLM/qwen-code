# Bounded CUA observations

[English](cua-bounded-observations.md) | [简体中文](cua-bounded-observations.zh-CN.md)

## Problem and scope

Long macOS AX trees hit traversal limits and discard their revision baseline on
every observation. Repeated full trees grow the model context even when the
captured UI is unchanged.

The stack is #11683 → #11705 → #11735 (this increment). Its direct base is
#11705 (`54d75e88401c598c7027ec11c4a5cfbf9892ee3a`), which builds on #11683
(`9ad582281de6d79350b255a63b7f7757e14ec11e`). Those changes fix nested capture
completeness and add native compact App observations, but still discard bounded
baselines and return unbounded text. This increment retains macOS bounded
revisions and caps facade text, including the App workflow. Native text
projection stays unchanged; there is no duplicate facade compaction. Captured
action bindings remain available internally to App handles and in `elements`
for exact-window callers.

## Capture and revision semantics

Track AX read success separately from depth/node truncation. A bounded capture
with successful reads and unique native identities may retain a revision.
Its `capture_complete` remains false. Complete and bounded captures have separate
lineages, also scoped by session, target, traversal limits, App/legacy projection,
and format versions.

An identical bounded observation can return `no_change`. Any change to a bounded
observation returns full captured state, never a deletion diff: a missing node
may simply have fallen outside the budget. Native read failures and ambiguous
identities still invalidate the lineage. Tokens name only currently captured
elements; omitted elements cannot be used through a retained token.

Publish capture completeness, read completeness, truncation, and incomplete details at the top
level on macOS, retaining existing revision-envelope fields. The facade keeps
the envelope precedence established by #11683 and falls back to the top level.
Transient read failures receive one retry, including failures mixed with a
traversal limit. Pure budget truncation does not. `capture_read_complete`
distinguishes mixed failures even when the bounded detail trace is already full.
Preserve tokens issued for the current snapshot; do not confuse incomplete
coverage with an unusable current element. Transient revisions also expose the
rendered short ID alongside each snapshot token so App actions cannot confuse
all-node display numbering with actionable-node indices. When an older daemon
omits that mapping, revision-backed App observations do not fall back to action
indices; exact-window callers can still use current snapshot tokens.

## Model-facing text

The facade preserves native row contents, including the fields used for revision
comparisons. Native projection and rich-text formatting remain owned by #11705.

`maxTextChars` bounds returned text independently of `maxElements` and
`maxDepth`, defaulting to 12,000 characters. Truncation occurs at row boundaries
and is explicit at the beginning of the output. The complete captured element
array remains available. App handles retain current short-ID action bindings
and forward the bounded text without replacing capture warnings. Their notices
refer to `app.getState`, not an unexposed element array. A caller can request a
larger full rendering with
`disableDiff: true` and a larger `maxTextChars`; missing text never proves an
element absent. Capture warnings also precede the tree.

## Validation and acceptance

- Reproduce the installed facade's nested-field failure and repeated full output
  through the global CLI / qwen_node_repl before editing.
- Native tests cover identical bounded observations, changed bounded captures,
  token retirement, capture limits, and transient read failure classification.
- Facade tests cover both capture field locations, no redundant budget retry,
  current snapshot tokens, row budgets, and unmodified elements. App tests cover
  short IDs after bounded no-change, read-failure warnings, and larger full text.
- Run package builds/typechecks and focused tests, repository build/typecheck,
  and live browser observation/action checks through qwen_node_repl.
- A static bounded page must reuse its baseline when reads succeed and native
  identities are unique; capture failures remain visibly incomplete, and
  ambiguous identities still require full observations.
- Default text stays within the character budget with diagnostics first. The
  budget is a character limit, not a claim about model billing tokens.

## Risks

Partial captures cannot prove deletion or global absence. The full-on-change
rule deliberately sacrifices partial diffs for that guarantee. Bounded text
can omit captured rows; callers can request larger full text or screenshots.
Exact-window callers can also inspect the current structured elements. Old installed drivers can
benefit from facade output changes but require rebuilding the native driver to
retain bounded revisions.
