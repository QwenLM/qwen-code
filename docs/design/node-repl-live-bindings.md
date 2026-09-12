# Persistent REPL closure bindings

[English](node-repl-live-bindings.md) | [简体中文](node-repl-live-bindings.zh-CN.md)

## Status and problem

Implemented and verified at the Kernel level, then exercised in local case50 R3/R4 task runs. Regression and efficiency acceptance across all 20 tasks remain pending. A frozen OSWorld case50 runtime reproduces a stale helper after replacing an observed state in another cell. Ordinary JavaScript returns `2|2` for `let x=1; const read=()=>x; x=2; [read(),x]`; the previous REPL intentionally tested `1|2` across cells. This conflicts with its documented persistent-state/helper workflow and causes repeated token lookups.

## Design

Keep each binding owned by the module that originally declares it. Export a private accessor referencing that lexical binding. Later cells resolve carried references through these accessors, rather than copying values into fresh lexical variables. New declarations and inner scopes remain native JavaScript. Carry-over declaration stubs preserve native redeclaration errors; repeated `var` initializers assign through the original binding, including destructuring and loop targets. Preserve bare-call `this`, object shorthand, lexical shadowing and declaration patterns during rewriting.

Do not install user bindings on `globalThis`: local imported modules share the VM context and must not acquire access to REPL lexical bindings or lose their original globals. Do not synchronize only at statement boundaries: an old helper must observe an assignment in the same statement and its writes must be immediately visible.

## Failure and cancellation

Keep checkpoint values separately from live accessors. Successful cells retain live ownership. An ordinary error restores binding values to the last completed statement/declarator checkpoint. Cancellation or timeout restores values from cell entry and does not publish new bindings. Object mutations and external side effects remain non-transactional, as before. Existing continuation guards and native terminal barriers remain in force.

## Validation and acceptance

Use real Kernel cells for replaced observations, old helper writes, same-statement reads, async helpers, repeated `var`, destructuring, loop targets, shadowing/default parameters, const/TDZ, bare and optional calls, imports/global isolation, partial commit, timeout and cancellation. Run the package build/typecheck and transform/Kernel tests, then independent reproduction and review. Frozen historical runtimes must remain unchanged; a new runtime is a separate experimental treatment. No task-level speedup is claimed from these controls.

The final build and typecheck passed, with 70 transform/Kernel tests and an independent 19-cell review reporting no findings. Review fixes preserve strict unqualified-delete errors and inferred names for anonymous functions/classes, including commented parentheses and class static initializers. References to names not yet declared in a visible module retain the existing behavior; this is not a global Script REPL. Evidence: `.qwen/pr-reviews/node-repl-live-bindings.md` and `.qwen/investigations/node-repl-live-bindings-seventh-tests.log`.

After case50R2 finished, a legacy runtime symlink allowed later builds to mutate three compiled files. Their exact recorded bytes were restored, the package and dependencies independently copied, and all 54 original runtime hashes rechecked. The R2 task trace and timing did not change. New R3 uses a separate complete dependency manifest; the post-run restoration is recorded in R2's `post-run-runtime-mutation-audit.json`, not represented as an unchanged historical dependency attestation.
