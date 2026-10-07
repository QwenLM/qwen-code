# Read-only exploration convergence reminder

[English](tool-exploration-convergence.md) | [简体中文](tool-exploration-convergence.zh-CN.md)

## Problem and scope

Issue #13321 requests an actionable convergence point when diverse discovery calls succeed without advancing a deliverable. The adaptive default tool-call cap permits useful diverse calls past its soft threshold. This proposal adds a reminder at that threshold; it does not add a new halt, infer task intent, force writes, or change permissions. Repeated execution failures and their operator rollout policy in #10887 remain separate.

## Behavior

Track a continuous phase of calls whose registered kind is `Read`, `Search`, or `Fetch`. Resolve bridged `tool_call` targets through the registry, so declared read-only MCP tools do not depend on their names. Planning, implementation, delegation and unknown kinds end the phase. At `model.maxToolCallsPerTurn` calls, insert one reminder after the tool results asking the model to use gathered information, proceed toward the requested deliverable or explain a blocker. For read-only requests, ask for findings and remaining questions. The reminder grants no new tool permission or plan approval.

Keep the existing adaptive and explicit hard-cap semantics. A disabled/infinite allowance produces no reminder. Continued legitimate investigation remains allowed; the reminder does not assert that every read is stagnation. Another reminder is possible only after a non-read phase or a new logical turn. The interactive loop-detector disable also suppresses the core reminder.

## Ownership and compatibility

Core owns one budget alongside its existing logical-turn loop detector. Retry rolls back uncommitted call observations, provider duplicate call IDs are counted once, and existing user/Goal/Stop turn resets clear the budget. ACP owns a budget in each daemon tool-loop state, shared by that loop's tool-result continuations. Foreground, channel, Stop/todo, cron and notification loops instantiate that state. Older callers constructing the exported state shape without the optional budget keep their previous behavior. No state is shared between sessions and no arguments, result contents or identifiers are retained in the budget.

The counter observes emitted/accepted call kinds rather than semantically proving successful progress. A non-read request resets the phase even if its execution later fails; the existing failure protections retain responsibility for that case. A model may ignore the reminder, so a controlled provider can verify insertion and runtime behavior but cannot establish production-model convergence or token savings.

## Validation and acceptance

Verify threshold, one-shot behavior, implementation/planning resets, disabled allowance and retry rollback with focused tests. Verify arbitrary and bridged registered MCP kinds. Use actual CLI/tmux with distinct real file reads and capture the outgoing reminder, continued read-only tool availability, natural completion and any auxiliary model requests separately. Native evidence must be pinned to executed source/build identities. Existing cap and permission checks remain authoritative. Keep a productive phase and a legitimate broad read-only investigation valid without forced writes.

## Open boundary

The reminder is a deterministic insertion with nondeterministic model response. A stronger semantic completion gate would require a separate declared task/progress contract; this proposal does not invent one.
