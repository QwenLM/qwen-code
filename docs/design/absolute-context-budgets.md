# Absolute context budgets

[English](absolute-context-budgets.md) | [简体中文](absolute-context-budgets.zh-CN.md)

## Status and problem

Draft implementation for #12029, part of #12028. Core and CLI tests plus
request-level validation pass. The proposed defaults require core-owner review
before landing.

ToolSearch preload currently allows 10% of the model window by default; the
always-on memory warning uses 15%. Larger windows therefore permit larger
resident prefixes without any change in task needs. Window occupancy is not a
cost budget.

## Proposed changes

Keep `tools.toolSearch.threshold` as a percentage. Add
`tools.toolSearch.maxPreloadTokens`, default 8000, and use the smaller of the
percentage budget and the absolute cap. Zero disables budget-based preload;
it does not disable tools or change explicit eager declarations. Preserve the
all-or-nothing preload decision and no-ToolSearch/CodeModeOnly behavior.

Cap the existing always-on context warning at 10000 estimated tokens, retaining
the 15% threshold when smaller. This is a warning, not truncation or refusal to
load instructions. Show the effective threshold in the warning rather than
claiming that the percentage was exceeded when only the absolute cap was.

Use existing settings validation and Config forwarding, with finite,
nonnegative cap handling at the runtime boundary. Do not introduce a budget
manager or alter the schema-size estimator in this change.

## Layers and files

Update CLI settings schema and Config construction, core Config parameters and
getter, the client preload call site, and the memory warning. Regenerate the
settings JSON schema using the repository generator. Add collocated tests and
update user settings documentation. Audit derived Config and SDK call paths so
the setting is neither lost nor declared without a production caller.

## Tradeoffs and boundaries

8000/10000 are reviewable policy proposals from the issue discussion, not
measured optimal values. Smaller preload budgets may add ToolSearch turns and
change the declaration prefix mid-session. Less initial input does not prove
lower whole-task cost. Compare cold and warm usage separately before claiming
savings. No assertion that every built-in-only setup stays unchanged: enabled
features and tool descriptions change the pool size.

The deferred-call bridge in PR #10410 is not a prerequisite for this default.
Its bridge does not exist on `main`, and its follow-up #11321 concerns that new
surface. The measured default startup pool (~6447 estimated tokens) remains
below the proposed 8000-token cap, so the default does not introduce a new
ToolSearch reveal or prefix mutation there. A lower custom cap can do so; that
is an explicit operator tradeoff until a stable bridge lands.

This change neither migrates extension content nor fixes category accounting.
It does not change permissions, tool visibility rules, or instruction contents.

## Acceptance

Verify small and large windows, percentage/cap minimum, zero and custom caps,
exact pool boundaries, invalid values, and unchanged no-ToolSearch and code-mode
paths. Verify below/above warning threshold and existing warning lifecycle.
Check setting forwarding from CLI and default use by direct Config callers.

Dry-run the global CLI with isolated configuration and localhost request
capture, then repeat against the built bundle. Record actual tool declarations
and warning text, not just a formula test. Run build, typecheck, focused tests,
independent verification and two clean diff audits. Mock usage is not provider
cost evidence.

## Open decision

Core owner must confirm default caps and the additive setting before landing.
Keep the work Draft until that decision is complete.
