# OpenTUI direct marketplace plugin choice

[English](2026-10-31-opentui-extension-plugin-choice.md) | [简体中文](2026-10-31-opentui-extension-plugin-choice.zh-CN.md)

## Problem and scope

A public unsuffixed install of an owned two-plugin Claude marketplace opens a picker in global Ink and both candidate Ink profiles; one Escape cancels without writes and exits naturally. The native run fails before the picker with a missing root qwen-extension.json. No selection or conversion was reached. The independent report e325dc21 was read before implementation; the original native failure and all controls remain unchanged.

## Design

Register the current Config's extension-manager choice callback in the native shell. Export and reuse the existing Source plugin-choice widget unchanged. Choice requests join the same FIFO as consent and setting input, with distinct IDs and per-request resolve/cancel promises. The active modal unmounts the composer. Each widget is keyed by request ID, resetting selection and settled state for consecutive choices. Ordinary rerenders preserve pending work; Config replacement and unmount abort requests, captured stale callbacks reject, and late choices cannot settle a successor. Cleanup does not restore a no-op or replace another owner's callback.

This is a CLI-only callback bridge, not a Core converter, publisher-cache, hook, settings, provider or approval-policy change. Explicit Source acquisition behavior remains unchanged. The readonly fixture qualifies opening and cancellation before conversion. A separate owned mutable fixture qualifies selecting Beta and denying its consent, with original publisher files preserved and only the recorded derived subtree permitted. Approved installation remains unqualified.

## Verification

The implementation passed normal build, typecheck, lint, bundle, native layout checks and six whole test files (328 tests). The owner regressions cover selected values, cancellation, stable rerender, replacement/unmount, stale callbacks, consecutive choices and shared FIFO with setting/consent; existing Source widget and real voice-shell tests remain included.

Node/Ink, Bun/Ink and strict Bun/OpenTUI ran four public cases each: direct choice cancellation, setting save with cold reload, setting cancellation, and direct consent denial. All 12 executions passed, with 15 natural exits0/signal0 and zero model requests, using the same built candidate entry. Saved maps retain the exact authority, installed artifacts and relevant publisher guards. Original native failures remain preserved separately.

A further Beta→No case passed on those three candidate profiles and separately on the installed global Ink baseline. Each run selected the nonfirst Beta plugin, displayed Beta's exact consent, denied it, retained unchanged installed state and exited naturally with zero model requests. Each fresh owned mutable publisher preserved its five original files and existing directory type/modes; only the recorded derived subtree (three directories and two Beta files) was added. The global binary is an independent baseline with unknown product source, not another candidate build.

Together, the candidate runs passed 15 executions of five unique cases with 18 natural exits and zero model requests; the global Beta baseline is one separate passing execution and natural exit.

These checks qualify public picker cancellation and selected-value delivery to consent/denial. They do not qualify approval, successful installation, complete conversion, hooks, arbitrary original user-publisher mutation semantics, an installed candidate, final merged main or overall migration completion.

## 2026-11-14 frame-width correction

The earlier six shell-to-widget assertions only proved content budgets72/96/96 at terminal80/120/200; they did not prove the surrounding frame. A later real native RootRender replay of the exact direct shell branches and real widgets failed all six choice/setting cases: frame x0 and widths80/120/200 instead of x2 and76/100/100. All four physical frame corners were captured before the constraint failed. This was a native branch replay with unrelated shell hooks isolated, not a whole CLI run. The original failures and earlier scoped passes remain preserved.

Only those two direct mounts now use the existing two-column inset and dialog-area-width container, retaining the capped widget content width, region height, keyed request and lifecycle behavior. The existing six unit cases also assert this structural parent boundary; they do not replace native geometry. Post-correction normal build, five whole CLI test files (248 tests), typecheck, full zero-warning ESLint, six-file format check and bundle all passed. The unchanged native branch replay passed all six frame cases. A separate complete strict Bun/OpenTUI tmux CLI run also passed all six painted bounds, public picker cancellation, consent and the exact 110-character setting save, followed by one natural exit0/signal0 with zero model requests and no forced cleanup. These runtime results belong to the frozen pre-documentation-followup aa02+6cd source and entry3ac63a1d; this is local macOS evidence, not an installed candidate, final main or cross-platform qualification. No queue, widget, Core or policy changes are included.
