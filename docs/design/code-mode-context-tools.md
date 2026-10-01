# Context tools in Code Mode

[English](code-mode-context-tools.md) | [简体中文](code-mode-context-tools.zh-CN.md)

Updated: 2026-10-01. Implemented; acceptance evidence is recorded in
`.qwen/e2e-tests/exec-skill-pr-2026-10-01/`.

## Tool exposure and output

[Lazy Code Mode](lazy-code-mode.md) defines the current direct-tool surface.
Other registered tools are callable through `exec`, subject to the existing
agent allowlist, validation, permissions, hooks, and cancellation rules.

Nested tool results remain JavaScript values. Only explicit `text`, `image`,
`audio`, and `generatedImage` calls produce script output. Bare return values
and successful completion add no output. The automatic `toolResults` wrapper
is removed. Native Omni media and screenshot media keep their existing transport.

## Skill delivery and recovery

Call `text((await tools.skill({ skill: 'name' })).output)` in one exec call and
read the instructions before taking dependent actions in another call.
Successful skill execution still applies its runtime side effects and model
selector. A later script error preserves the selector, including explicit
`undefined` to inherit the configured model.

Exec snapshots previously loaded skills. A newly loaded skill stays deduplicated
only when its complete current body appears in the final emitted output.
Complete bodies inside JSON-stringified tool results also count as delivered.
Omission, cancellation, and truncation forget the new load, allowing a later
explicit invocation to retry. Previously loaded skills and older historical
bodies remain intact. Internal `newlyLoadedSkills` metadata lets the scheduler
repeat this check after the final aggregate output budget; it adds no model text.

Explicit script text above the 32,000-character response cap is persisted before
being replaced with a bounded preview and file reference. The file contains the
accumulated script output before this cap, including any script error. Models
can read the omitted content through existing read-file pagination. QuickJS's
separate 100,000-character accumulation limit remains in force.

On resume, paired exec responses restore dedup when their output or error text
contains a complete body matching the current skill file. Older `toolResults`
transcripts remain readable. Printed text can be authored by the script, so
exec history restores body dedup only; direct Skill responses retain their
existing validated hooks and permission restoration. Truncated or edited bodies
cannot restore dedup.

## Goal barrier

A goal update waits for earlier nested calls and blocks later ones. A terminal
update ends the script and prevents further calls, preserving accumulated
explicit output. Nonterminal updates allow the script to continue.

## Validation and acceptance

Build, typecheck, and run the focused skill, exec, scheduler, output, and Code
Mode suites. Exercise real CLI processes against a deterministic local provider
for omitted-then-explicit loading, resume, post-skill script errors, oversized
output file recovery, and Responses API resume. Inspect raw provider
requests and persisted files. Use a real model separately to observe whether it
follows the explicit-output instruction and recovers complete skill content.

Acceptance requires one body for an explicit short load plus reload/resume,
successful retry after omission or truncation, preserved error-path model
selection, recoverable omitted bytes, and unchanged ordinary explicit-output
behavior. Skill text printed by a script must not grant hooks or permissions.
